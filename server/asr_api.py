#!/usr/bin/env python3
"""Local speech-to-text service (sherpa-onnx Paraformer).

End of the voice pipeline for the Muscovado panel: the phone records PCM ->
upload -> this service turns it into text.
Listens on loopback only; called by the co-located authd, never exposed directly.

    POST /transcribe   body = audio bytes (wav/mp3/m4a/webm/opus all fine, decoded by ffmpeg)
    GET  /health

Environment variables
    PARA_DIR        model directory name under ~/asr/models
    ASR_API_PORT    listen port, default 9131
    PARA_MODELS     model root, default <this file's directory>/models

Requires ffmpeg on PATH and sherpa-onnx + numpy installed:

    python3 -m venv ~/asr/.venv
    ~/asr/.venv/bin/pip install sherpa-onnx numpy

Model: sherpa-onnx-paraformer-zh-small-2024-03-09
(unpack into models/; needs model.int8.onnx and tokens.txt)
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sherpa_onnx

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS_ROOT = os.environ.get("PARA_MODELS") or os.path.join(HERE, "models")
MODEL_DIR = os.environ.get("PARA_DIR", "sherpa-onnx-paraformer-zh-small-2024-03-09")
ONNX = os.path.join(MODELS_ROOT, MODEL_DIR, "model.int8.onnx")
TOKENS = os.path.join(MODELS_ROOT, MODEL_DIR, "tokens.txt")

HOST = "127.0.0.1"
PORT = int(os.environ.get("ASR_API_PORT", "9131"))
SAMPLE_RATE = 16000
THREADS = 2
MAX_BYTES = 8 * 1024 * 1024        # 8MB, enough for 1+ minutes of compressed audio
MIN_SECONDS = 0.25


class BusyError(RuntimeError):
    """Queue timeout: the recognizer is busy; fail fast rather than pile up requests."""


_lock = threading.Lock()           # sherpa's recognizer is not guaranteed thread-safe
_recognizer = None


def get_recognizer():
    global _recognizer
    if _recognizer is None:
        if not (os.path.exists(ONNX) and os.path.exists(TOKENS)):
            raise RuntimeError(f"model missing: {ONNX}")
        _recognizer = sherpa_onnx.OfflineRecognizer.from_paraformer(
            paraformer=ONNX,
            tokens=TOKENS,
            num_threads=THREADS,
            provider="cpu",
            decoding_method="greedy_search",
        )
        print("[asr-api] Paraformer ready", flush=True)
    return _recognizer


def to_samples(raw: bytes) -> np.ndarray:
    """Any format -> 16k mono float32. ffmpeg handles decoding (incl. opus/m4a/webm)."""
    proc = subprocess.run(
        ["ffmpeg", "-v", "quiet", "-i", "pipe:0",
         "-f", "f32le", "-ac", "1", "-ar", str(SAMPLE_RATE), "-"],
        input=raw, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60,
    )
    if proc.returncode != 0 or not proc.stdout:
        raise ValueError(
            "audio decode failed: "
            + (proc.stderr.decode("utf-8", "replace")[:160] or "unrecognized format")
        )
    return np.frombuffer(proc.stdout, dtype=np.float32)


def transcribe(raw: bytes) -> dict:
    started = time.time()
    samples = to_samples(raw)
    seconds = len(samples) / SAMPLE_RATE
    if seconds < MIN_SECONDS:
        return {"text": "", "seconds": round(seconds, 2), "reason": "too short"}

    # The recognizer is not thread-safe, so it can only run serially; but one
    # stuck request must never block everything behind it, so a queue wait over
    # 15s returns 503 immediately, letting the panel retry or show a message.
    if not _lock.acquire(timeout=15):
        raise BusyError("transcription service is busy, please retry shortly")
    try:
        rec = get_recognizer()
        stream = rec.create_stream()
        stream.accept_waveform(SAMPLE_RATE, samples)
        # Append 0.3s of silence at the end: Paraformer tends to drop the last
        # characters of a truncated tail.
        stream.accept_waveform(SAMPLE_RATE, np.zeros(int(SAMPLE_RATE * 0.3), dtype=np.float32))
        rec.decode_stream(stream)
        text = (stream.result.text or "").strip()
    finally:
        _lock.release()
    return {
        "text": text,
        "seconds": round(seconds, 2),
        "ms": int((time.time() - started) * 1000),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "asr-api"
    protocol_version = "HTTP/1.1"

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        sys.stderr.write("[asr-api] %s\n" % (format % args))

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?")[0] == "/health":
            self._json(200, {"ok": True, "model": MODEL_DIR})
        else:
            self._json(404, {"ok": False})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?")[0] != "/transcribe":
            self._json(404, {"ok": False})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            self._json(400, {"ok": False, "error": "no audio data"})
            return
        if length > MAX_BYTES:
            self._json(413, {"ok": False, "error": "audio too large"})
            return
        raw = self.rfile.read(length)
        try:
            result = transcribe(raw)
        except ValueError as exc:
            self._json(400, {"ok": False, "error": str(exc)})
            return
        except BusyError as exc:
            self._json(503, {"ok": False, "error": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001
            self._json(500, {"ok": False, "error": str(exc)[:200]})
            return
        self._json(200, {"ok": True, **result})


def main() -> None:
    get_recognizer()          # load the model at startup so the first request isn't slow
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.daemon_threads = True
    print(f"[asr-api] listening on http://{HOST}:{PORT}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
