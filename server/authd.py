#!/usr/bin/env python3
"""authd -- Muscovado backend: session auth + Hermes integration.

Design notes
--------------
Auth
  * Passwords are stored only as scrypt hashes (secret.json, 0600); plaintext
    never touches disk.
  * Successful login issues a random session token; the server stores only its
    SHA-256 digest. Cookie is HttpOnly + Secure + SameSite=Strict + Path=/ai.
  * Constant-time comparison. Wrong password, locked account and no-password
    configured all run one equivalent scrypt operation, so response timing
    cannot be used to probe "is the password right".

Brute-force defense
  * Per IP: 5 failures in 15 min -> locked; more failures, longer lock
    (exponential, capped at 24h).
  * Global: 20 failures in 10 min -> site-wide cooldown of 30 min (blocks
    distributed IP rotation).
  * All failure responses share a uniform delay and never reveal whether the
    password was wrong or the account is locked.

Injection defense
  * Hermes is invoked with subprocess argv arrays and stdin, never through a shell.
  * All SQL is parameterized; static file names go through a whitelist, never
    string-concatenated paths.
  * Inputs are length/character validated, rejecting NUL and control characters.

Bypass defense
  * A single chokepoint does auth: apart from the PUBLIC list, any path
    (including static assets) without a valid session gets 401/302. There is no
    directly reachable side door.
  * The service listens on 127.0.0.1 only; the real client IP comes from
    nginx-injected X-Real-IP.
  * State-changing requests validate Origin/Referer plus a CSRF header.
  * Uniform security response headers (CSP / no framing / nosniff / HSTS).

Run
  python3 authd.py            # foreground
  python3 authd.py --port N
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# ─────────────────────────── Config ───────────────────────────

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# Frontend static directory: defaults to ../web (repo layout); can be overridden by config.json
SITE_DIR = os.environ.get("MUSCOVADO_WEB_DIR") or os.path.join(
    os.path.dirname(BASE_DIR), "web"
)
STATE_DIR = os.path.join(BASE_DIR, "state")
DB_PATH = os.path.join(STATE_DIR, "authd.db")
SECRET_PATH = os.path.join(STATE_DIR, "secret.json")

# Optional config file: pulls domain/paths out of the code, making it easier for
# others to deploy and for the project to be open-sourced.
# Without it, the defaults below apply -- existing deployments are unaffected.
_CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
CONFIG: dict = {}
if os.path.exists(_CONFIG_PATH):
    try:
        with open(_CONFIG_PATH, encoding="utf-8") as _fh:
            CONFIG = json.load(_fh)
    except (OSError, ValueError) as _exc:      # surface a bad config loudly; don't silently use defaults
        raise SystemExit(f"failed to read config.json: {_exc}")

HOST = CONFIG.get("host", "127.0.0.1")
PORT = int(CONFIG.get("port", 9120))

COOKIE_NAME = "ai_session"
COOKIE_PATH = CONFIG.get("cookie_path", "/ai")
COOKIE_SECURE = bool(CONFIG.get("cookie_secure", True))
SESSION_TTL = 30 * 24 * 3600          # 30 days


def _secure_attr() -> str:
    """The cookie's Secure attribute. Disabled only for local http debugging."""
    return " Secure;" if COOKIE_SECURE else ""

# Allowed frontend origins (the nginx public domain). Used to validate Origin/Referer.
ALLOWED_ORIGINS = set(CONFIG.get("allowed_origins") or ["https://example.com"])

# Static asset whitelist: only these files can be read, ruling out path traversal
# and leaking server-side files.
STATIC_FILES = {
    "index.html": "text/html; charset=utf-8",
    "app.css": "text/css; charset=utf-8",
    "app.js": "application/javascript; charset=utf-8",
    "markdown.js": "application/javascript; charset=utf-8",
    "composer.js": "application/javascript; charset=utf-8",
}

# Paths reachable without logging in
PUBLIC_PATHS = {"/login", "/login.html", "/favicon.ico"}

# Brute-force parameters
# Note: with a very short password these are the only barrier, so they are
# stricter than typical values.
#   * 3 failures per IP locks it; first lock 30 min, then exponential up to 24 h
#   * 10 failures site-wide triggers a 1-hour cooldown (blocks distributed IP rotation)
FAIL_WINDOW = 15 * 60
FAIL_LIMIT = 3
LOCK_BASE = 30 * 60
LOCK_MAX = 24 * 3600
GLOBAL_WINDOW = 10 * 60
GLOBAL_FAIL_LIMIT = 10
GLOBAL_LOCK = 60 * 60

# Talking to Hermes
HERMES_BIN = CONFIG.get("hermes_bin") or os.path.expanduser("~/.local/bin/hermes")
HERMES_CWD = CONFIG.get("hermes_cwd") or os.path.expanduser("~")
HERMES_PATH = CONFIG.get("hermes_path") or (
    os.path.dirname(HERMES_BIN) + ":/usr/local/bin:/usr/bin:/bin"
)
CHAT_TIMEOUT = 180
CHAT_MAX_CHARS = 4000
# Clients may pass a backend session key to continue a conversation; only this
# prefix + alphanumerics is accepted, ruling out arbitrary session names.
CHAT_SESSION_RE = re.compile(r"^aipanel-[a-z0-9]{6,24}$")
# Hermes' own session id looks like 20261022_200622_f4dfd5; used for --resume of an existing session
HERMES_SID_RE = re.compile(r"^[0-9]{8}_[0-9]{6}_[0-9a-f]{6}$")
CHAT_SLOTS = threading.Semaphore(2)

# Local ASR transcription service (asr_api.py, loopback only)
ASR_API = "http://127.0.0.1:9131"
ASR_MAX_BYTES = 8 * 1024 * 1024
ASR_TIMEOUT = 120

# Hermes' session store (opened read-only so its own writes are undisturbed)
STATE_DB = CONFIG.get("hermes_state_db") or os.path.expanduser("~/.hermes/state.db")

# -- Images: directories and formats allowed to be served --
# Images are only taken from these directories, and the real path must land
# inside one of them (guards against ../ traversal).
IMAGE_DIRS = CONFIG.get("image_dirs") or [
    os.path.expanduser("~/.hermes/images"),
    os.path.expanduser("~/.hermes/cache"),
    os.path.expanduser("~/Pictures"),
]
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp"}
IMAGE_MIME = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
    ".bmp": "image/bmp",
}
# Images that newly appeared during this turn also count (screenshots/charts generated by Hermes)
IMAGE_SCAN_DIRS = CONFIG.get("image_scan_dirs") or [
    os.path.expanduser("~/.hermes/images"),
    os.path.expanduser("~/.hermes/cache"),
]
IMAGE_SECRET_PATH = os.path.join(STATE_DIR, "image.key")

_DB_LOCK = threading.Lock()
_SCRYPT = dict(n=2 ** 15, r=8, p=1, dklen=32, maxmem=96 * 1024 * 1024)


# ─────────────────────────── Utilities ───────────────────────────


def now() -> int:
    return int(time.time())


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    os.makedirs(STATE_DIR, exist_ok=True)
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                created    INTEGER NOT NULL,
                expires    INTEGER NOT NULL,
                last_seen  INTEGER NOT NULL,
                ip         TEXT,
                ua         TEXT
            );
            CREATE TABLE IF NOT EXISTS attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ip TEXT NOT NULL,
                ts INTEGER NOT NULL,
                ok INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_attempts_ts ON attempts(ts);
            CREATE INDEX IF NOT EXISTS idx_attempts_ip ON attempts(ip, ts);
            """
        )


def load_secret() -> dict | None:
    try:
        with open(SECRET_PATH, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        return None


def scrypt_hash(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, **_SCRYPT)


def verify_password(password: str, secret: dict | None) -> bool:
    """Constant-time check. With secret None it still runs an equivalent operation
    so there is no timing side channel."""
    salt = bytes.fromhex(secret["salt"]) if secret else b"\x00" * 16
    expected = bytes.fromhex(secret["hash"]) if secret else b"\x00" * _SCRYPT["dklen"]
    got = scrypt_hash(password or "", salt)
    return hmac.compare_digest(got, expected) and secret is not None


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def client_ip(handler: BaseHTTPRequestHandler) -> str:
    """Trust only the nginx-injected X-Real-IP (the service listens on loopback
    only, so it cannot be forged from outside)."""
    ip = handler.headers.get("X-Real-IP") or ""
    ip = ip.strip()
    if re.fullmatch(r"[0-9a-fA-F:.]{2,45}", ip or ""):
        return ip
    return handler.client_address[0]


# ────────────────── Brute force: failure log and lock checks ──────────────────


def record_attempt(ip: str, ok: bool) -> None:
    with _DB_LOCK, db() as conn:
        conn.execute("INSERT INTO attempts(ip, ts, ok) VALUES(?,?,?)", (ip, now(), int(ok)))
        # Also prune records older than a day so the table doesn't grow forever
        conn.execute("DELETE FROM attempts WHERE ts < ?", (now() - 86400,))


def lock_state(ip: str) -> tuple[bool, int]:
    """Returns (locked, seconds remaining)."""
    with _DB_LOCK, db() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM attempts WHERE ip=? AND ok=0 AND ts>?",
            (ip, now() - FAIL_WINDOW),
        ).fetchone()
        fails = row["c"] if row else 0

        if fails >= FAIL_LIMIT:
            # Lock start = time of the FAIL_LIMIT-th failure
            row = conn.execute(
                "SELECT ts FROM attempts WHERE ip=? AND ok=0 ORDER BY ts ASC LIMIT 1 OFFSET ?",
                (ip, FAIL_LIMIT - 1),
            ).fetchone()
            start = row["ts"] if row else now()
            over = fails - FAIL_LIMIT
            duration = min(LOCK_BASE * (2 ** over), LOCK_MAX)
            remain = start + duration - now()
            if remain > 0:
                return True, remain

        grow = conn.execute(
            "SELECT COUNT(*) AS c FROM attempts WHERE ok=0 AND ts>?", (now() - GLOBAL_WINDOW,)
        ).fetchone()["c"]
        if grow >= GLOBAL_FAIL_LIMIT:
            row = conn.execute(
                "SELECT ts FROM attempts WHERE ok=0 AND ts>? ORDER BY ts ASC LIMIT 1 OFFSET ?",
                (now() - GLOBAL_WINDOW, GLOBAL_FAIL_LIMIT - 1),
            ).fetchone()
            start = row["ts"] if row else now()
            remain = start + GLOBAL_LOCK - now()
            if remain > 0:
                return True, remain
    return False, 0


# ─────────────────────────── Sessions ───────────────────────────


def create_session(ip: str, ua: str) -> str:
    token = secrets.token_urlsafe(32)
    ts = now()
    with _DB_LOCK, db() as conn:
        conn.execute(
            "INSERT INTO sessions(token_hash, created, expires, last_seen, ip, ua) VALUES(?,?,?,?,?,?)",
            (sha256_hex(token), ts, ts + SESSION_TTL, ts, ip, ua[:200]),
        )
    return token


def session_valid(token: str) -> bool:
    if not token or len(token) < 20:
        return False
    with _DB_LOCK, db() as conn:
        row = conn.execute(
            "SELECT expires FROM sessions WHERE token_hash=?", (sha256_hex(token),)
        ).fetchone()
        if not row:
            return False
        if row["expires"] <= now():
            conn.execute("DELETE FROM sessions WHERE token_hash=?", (sha256_hex(token),))
            return False
        conn.execute(
            "UPDATE sessions SET last_seen=? WHERE token_hash=?", (now(), sha256_hex(token))
        )
    return True


def drop_session(token: str) -> None:
    with _DB_LOCK, db() as conn:
        conn.execute("DELETE FROM sessions WHERE token_hash=?", (sha256_hex(token),))


def csrf_for(token: str) -> str:
    """CSRF token is derived from the session token: no extra storage, and it
    dies with the session."""
    return hmac.new(token.encode("utf-8"), b"csrf-v1", hashlib.sha256).hexdigest()[:48]


# ─────────────────────────── Hermes invocation ───────────────────────────


ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")
META_RE = re.compile(r"^\s*(session_id|会话|Session)\s*[:：].*$", re.IGNORECASE)


def clean_reply(raw: str) -> tuple[str, str]:
    text = ANSI_RE.sub("", raw or "")
    session_id = ""
    keep = []
    for line in text.splitlines():
        if META_RE.match(line):
            m = re.search(r"([0-9]{8}_[0-9]{6}_[0-9a-f]+)", line)
            if m:
                session_id = m.group(1)
            continue
        keep.append(line)
    return "\n".join(keep).strip(), session_id


def _hermes_argv(session_name: str | None, resume_id: str | None) -> list[str]:
    argv = [
        HERMES_BIN, "chat",
        "--query-file", "-",
        "--oneshot",
        "--format", "stream-json",
        "-Q",
    ]
    # Optional: preload a skill so Hermes knows where images should be stored and
    # how to reference them. Set "hermes_skills": ["your-skill-name"] in
    # config.json, otherwise this argument is omitted.
    for _skill in (CONFIG.get("hermes_skills") or []):
        argv += ["--skills", str(_skill)]
    if resume_id:
        argv += ["--resume", resume_id]
    else:
        argv += ["--continue", session_name, "--create-if-missing"]
    return argv


HERMES_ENV = {
    "PATH": HERMES_PATH,
    "HOME": os.path.expanduser("~"),
    "LANG": "en_US.UTF-8",
    "TERM": "dumb",
    "NO_COLOR": "1",
}


def tool_brief(payload) -> str:
    """Flatten a tool's input into one human-readable line for the frontend's
    thinking panel.

    That row is only one line tall, so dumping the whole JSON is pointless --
    just take the most informative field.
    """
    if not isinstance(payload, dict):
        return ""
    for key in ("query", "command", "code", "path", "url", "text", "prompt"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            one = " ".join(val.split())
            return one[:90] + ("…" if len(one) > 90 else "")
    keys = [k for k in payload.keys() if k not in ("timeout", "limit")]
    return ", ".join(keys[:4])


def result_brief(payload) -> str:
    """Summary of a tool result: just the leading snippet, newlines collapsed."""
    if not isinstance(payload, str):
        return ""
    one = " ".join(payload.split())
    return one[:80] + ("…" if len(one) > 80 else "")


def ask_hermes_stream(prompt: str, session_name: str | None, resume_id: str | None = None):
    """Call the real Hermes in streaming mode, yielding event dicts one by one.

    Text goes in via stdin and arguments are an argv array -- never through a shell.
    Events: {"type":"init"|"delta"|"done"|"error", ...}
    """
    if not CHAT_SLOTS.acquire(timeout=CHAT_TIMEOUT):
        yield {"type": "error", "error": "backend is busy, please try again later"}
        return
    proc = None
    started = time.time()
    try:
        proc = subprocess.Popen(
            _hermes_argv(session_name, resume_id),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=HERMES_CWD,
            env=HERMES_ENV,
            # Must use the default buffering (-1), not bufsize=1:
            # in binary mode bufsize=1 is ignored with a RuntimeWarning and falls
            # back to full buffering, so chunks pile up in the buffer and never
            # come out -- long answers "print a few words then hang".
            # bufsize=0 is also wrong: it makes stdout a raw FileIO with no read1.
            # -1 + read1() is the correct pairing: return whatever is available
            # instead of waiting for a full buffer.
            bufsize=-1,
        )
        assert proc.stdin and proc.stdout
        try:
            proc.stdin.write(prompt.encode("utf-8"))
            proc.stdin.close()
        except (BrokenPipeError, OSError):
            pass

        session_id = resume_id or ""
        acc: list[str] = []
        # Read line by line, but with read1: yield whatever is there instead of
        # waiting to fill a buffer.
        # `for raw in proc.stdout` returns a single byte at a time with bufsize=0;
        # readline() on an unbuffered stream can also block until the buffer fills.
        # read1 + assembling lines ourselves is the most reliable "forward as it arrives" form.
        pending = b""

        def handle_line(line: str):
            """Parse one stream-json line. Returns (events, finished)."""
            nonlocal session_id
            if not line.startswith("{"):
                # Non-JSON lines (warnings, trailing session_id line, ...) are ignored
                return [], False
            try:
                evt = json.loads(line)
            except ValueError:
                return [], False
            etype = evt.get("type")
            if etype == "system":
                session_id = evt.get("session_id") or session_id
                return [{"type": "init", "session_id": session_id,
                         "model": evt.get("model", "")}], False
            if etype == "tool_use":
                # Hermes calls tools while it is "thinking". Push these to the
                # frontend as thinking steps, otherwise the send-to-first-token
                # gap of several to tens of seconds is a blank screen.
                return [{
                    "type": "step", "kind": "tool",
                    "name": evt.get("name") or "tool",
                    "detail": tool_brief(evt.get("input")),
                }], False
            if etype == "tool_result":
                return [{
                    "type": "step", "kind": "result",
                    "name": evt.get("name") or "tool",
                    "detail": result_brief(evt.get("output")),
                }], False
            if etype == "text":
                piece = evt.get("text") or ""
                if not piece:
                    return [], False
                # On the first character send answer_start so the frontend collapses the thinking panel
                out = [{"type": "answer_start"}] if not acc else []
                acc.append(piece)
                out.append({"type": "delta", "text": piece})
                return out, False
            if etype == "result":
                session_id = evt.get("session_id") or session_id
                return [{
                    "type": "done", "session_id": session_id,
                    "ms": int((time.time() - started) * 1000),
                    "tokens": evt.get("tokens") or {},
                    "images": collect_images("".join(acc), started),
                }], True
            return [], False

        while True:
            chunk = proc.stdout.read1(65536)
            if not chunk:
                break
            pending += chunk
            while b"\n" in pending:
                raw, pending = pending.split(b"\n", 1)
                events, finished = handle_line(raw.decode("utf-8", "replace").strip())
                for ev in events:
                    yield ev
                if finished:
                    proc.wait(timeout=10)
                    return

        # Finish: handle any trailing line without a newline
        if pending.strip():
            for ev in handle_line(pending.decode("utf-8", "replace").strip())[0]:
                yield ev

        proc.wait(timeout=15)
        err = (proc.stderr.read() or b"").decode("utf-8", "replace").strip() if proc.stderr else ""
        # Diagnosing "the answer stops halfway": exit code, chunk count and byte count must be visible
        sys.stderr.write(
            "[chat] exit=%s pieces=%d chars=%d stderr=%r\n"
            % (proc.returncode, len(acc), len("".join(acc)), err[:200])
        )
        if proc.returncode and proc.returncode != 0:
            yield {"type": "error", "error": err[:300] or "Hermes returned an error"}
            return
        yield {
            "type": "done",
            "session_id": session_id,
            "ms": int((time.time() - started) * 1000),
            "tokens": {},
            "images": collect_images("".join(acc), started),
        }
    except subprocess.TimeoutExpired:
        yield {"type": "error", "error": "Hermes response timed out"}
    except Exception as exc:  # noqa: BLE001
        yield {"type": "error", "error": str(exc)[:300]}
    finally:
        if proc and proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass
        CHAT_SLOTS.release()


def rename_session(sid: str, title: str) -> None:
    """Rename the auto-generated aipanel-xxx title to the user's first sentence.

    Runs in a background thread so it doesn't block the reply; failure is harmless.
    """
    title = " ".join((title or "").split())[:18]
    if not title or not HERMES_SID_RE.match(sid or ""):
        return
    try:
        subprocess.run(
            [HERMES_BIN, "sessions", "rename", sid, title],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            cwd=HERMES_CWD,
            env=HERMES_ENV,
            timeout=30,
        )
    except Exception:  # noqa: BLE001 - a failed rename doesn't matter
        pass


def list_sessions(limit: int = 40) -> list[dict]:
    """List real Hermes sessions (read-only on state.db, most recent activity first)."""
    if not os.path.exists(STATE_DB):
        return []
    try:
        conn = sqlite3.connect(f"file:{STATE_DB}?mode=ro", uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT id, title, message_count, source, last_activity_at, started_at, model
            FROM sessions
            WHERE COALESCE(hidden,0)=0 AND COALESCE(archived,0)=0
            ORDER BY COALESCE(last_activity_at, started_at, 0) DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        conn.close()
    except sqlite3.Error:
        return []
    out = []
    for row in rows:
        ts = row["last_activity_at"] or row["started_at"] or 0
        out.append({
            "id": row["id"],
            "title": row["title"] or "(untitled)",
            "msgs": row["message_count"] or 0,
            "source": row["source"] or "",
            "at": int(ts * 1000) if ts else 0,
            "model": row["model"] or "",
        })
    return out


def session_history(sid: str, limit: int = 120) -> list[dict]:
    """Read the conversation of a Hermes session (keeping only visible user/assistant text)."""
    if not HERMES_SID_RE.match(sid) or not os.path.exists(STATE_DB):
        return []
    try:
        conn = sqlite3.connect(f"file:{STATE_DB}?mode=ro", uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT role, content, timestamp
            FROM messages
            WHERE session_id=? AND role IN ('user','assistant')
              AND COALESCE(active,1)=1
              AND content IS NOT NULL AND TRIM(content) <> ''
            ORDER BY timestamp ASC
            """,
            (sid,),
        ).fetchall()
        conn.close()
    except sqlite3.Error:
        return []
    msgs = [{"role": r["role"], "text": (r["content"] or "")[:4000], "at": int((r["timestamp"] or 0) * 1000)}
            for r in rows]
    return msgs[-limit:]


def _image_secret() -> bytes:
    """Signing key for image tokens; generated on first use and written to disk (0600)."""
    try:
        with open(IMAGE_SECRET_PATH, "rb") as fh:
            key = fh.read()
            if len(key) >= 16:
                return key
    except FileNotFoundError:
        pass
    key = secrets.token_bytes(32)
    os.makedirs(STATE_DIR, exist_ok=True)
    fd = os.open(IMAGE_SECRET_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(key)
    return key


def _safe_image_path(path: str) -> str | None:
    """Resolve a path to its real form and confirm it is an image inside an allowed directory."""
    try:
        real = os.path.realpath(path)
    except OSError:
        return None
    if not os.path.isfile(real):
        return None
    if os.path.splitext(real)[1].lower() not in IMAGE_EXTS:
        return None
    for root in IMAGE_DIRS:
        root_real = os.path.realpath(root)
        if real == root_real or real.startswith(root_real + os.sep):
            return real
    return None


def image_token(path: str) -> str | None:
    """Encode a path as an unforgeable short token (HMAC-signed, no server-side state)."""
    real = _safe_image_path(path)
    if not real:
        return None
    raw = real.encode("utf-8")
    mac = hmac.new(_image_secret(), raw, hashlib.sha256).hexdigest()[:24]
    body = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    return body + "." + mac


def path_from_token(tok: str) -> str | None:
    if not tok or "." not in tok:
        return None
    body, _, mac = tok.rpartition(".")
    try:
        pad = "=" * (-len(body) % 4)
        raw = base64.urlsafe_b64decode(body + pad)
    except (ValueError, TypeError):
        return None
    expect = hmac.new(_image_secret(), raw, hashlib.sha256).hexdigest()[:24]
    if not hmac.compare_digest(mac, expect):
        return None
    try:
        path = raw.decode("utf-8")
    except UnicodeDecodeError:
        return None
    return _safe_image_path(path)


MD_IMG_RE = re.compile(r"!\[[^\]]*\]\(\s*([^)\s]+)\s*\)")
MEDIA_RE = re.compile(r"MEDIA:\s*([^\s\"'）)]+)")
BARE_IMG_RE = re.compile(
    r"(/[\w.\-/]+\.(?:png|jpe?g|gif|webp|avif|bmp))", re.IGNORECASE
)


def images_in_text(text: str) -> list[str]:
    """Find the images Hermes wants to show in its reply.

    Recognizes three forms: markdown images, the MEDIA: prefix, and bare absolute paths.
    """
    found: list[str] = []
    for pattern in (MD_IMG_RE, MEDIA_RE, BARE_IMG_RE):
        for match in pattern.finditer(text or ""):
            candidate = match.group(1)
            if candidate.startswith("data:"):
                continue
            real = _safe_image_path(candidate)
            if real and real not in found:
                found.append(real)
    return found


def recent_images(since_ts: float, limit: int = 6) -> list[str]:
    """Find images written during this turn (Hermes screenshots, or charts whose
    paths never made it into the reply text)."""
    cutoff = since_ts - 2.0
    hits: list[tuple[float, str]] = []
    for root in IMAGE_SCAN_DIRS:
        if not os.path.isdir(root):
            continue
        for dirpath, _dirnames, filenames in os.walk(root):
            # Skip obviously deep cache subdirectories to avoid scanning too much
            if dirpath.count(os.sep) - root.count(os.sep) > 2:
                continue
            for name in filenames:
                if os.path.splitext(name)[1].lower() not in IMAGE_EXTS:
                    continue
                full = os.path.join(dirpath, name)
                try:
                    mtime = os.path.getmtime(full)
                except OSError:
                    continue
                if mtime >= cutoff:
                    hits.append((mtime, full))
    hits.sort(reverse=True)
    out: list[str] = []
    for _mtime, full in hits:
        real = _safe_image_path(full)
        if real and real not in out:
            out.append(real)
        if len(out) >= limit:
            break
    return out


def collect_images(text: str, turn_start: float) -> list[dict]:
    """Merge images named in the text with images newly created this turn, for the frontend."""
    ordered = images_in_text(text)
    for path in recent_images(turn_start):
        if path not in ordered:
            ordered.append(path)
    out = []
    for path in ordered[:6]:
        tok = image_token(path)
        if not tok:
            continue
        out.append({
            "url": "api/image?t=" + tok,
            "name": os.path.basename(path),
        })
    return out


def hermes_status() -> dict:
    """Probe the real Hermes dashboard health endpoint; return elapsed ms for the
    latency indicator at the top."""
    import urllib.request

    started = time.time()
    try:
        with urllib.request.urlopen("http://127.0.0.1:9119/api/health", timeout=4) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return {
            "ok": bool(data.get("ok")),
            "version": data.get("version", ""),
            "ms": int((time.time() - started) * 1000),
        }
    except Exception as exc:  # noqa: BLE001 - treat any failure as offline
        return {"ok": False, "version": "", "ms": int((time.time() - started) * 1000), "error": str(exc)[:120]}


# ─────────────────────────── Login page ───────────────────────────

LOGIN_PAGE = """<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>Muscovado</title>
<style>
  :root { --bg:#070b14; --line:rgba(255,255,255,.10); --text:#e8eef8;
          --cyan:#38e8d0; --rose:#ff5f7e; }
  html,body{height:100%}
  body{margin:0;background:var(--bg);color:var(--text);
       display:flex;align-items:center;justify-content:center;
       padding:24px;box-sizing:border-box;
       font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",sans-serif;}
  form{width:100%;max-width:300px;text-align:center}
  h1{margin:0 0 26px;font-size:22px;font-weight:600;letter-spacing:.3px;
     text-align:center}
  input{display:block;width:100%;box-sizing:border-box;padding:13px 14px;
        border-radius:14px;border:1px solid var(--line);
        background:rgba(255,255,255,.04);color:var(--text);
        font-size:16px;text-align:center;outline:none;transition:border-color .2s,background .2s}
  input:focus{border-color:rgba(56,232,208,.55);background:rgba(56,232,208,.06)}
  button{display:block;width:100%;margin-top:14px;padding:13px;border-radius:14px;border:0;
         background:linear-gradient(135deg,var(--cyan),#8b7dff);color:#04121a;
         font-size:15px;font-weight:700;letter-spacing:1px;cursor:pointer;
         transition:opacity .2s,transform .12s}
  button:active{transform:scale(.985)}
  button[disabled]{opacity:.55;cursor:default}
  .msg{margin-top:14px;font-size:12.5px;line-height:1.6;min-height:18px;
       color:var(--rose);text-align:center}
</style></head>
<body>
<form id="f" autocomplete="off">
  <h1>Muscovado</h1>
  <input id="pw" name="password" type="password" inputmode="text"
         autocomplete="current-password" autocapitalize="off" autocorrect="off"
         spellcheck="false" aria-label="Access password" required autofocus>
  <button id="go" type="submit">Enter</button>
  <div class="msg" id="msg"></div>
</form>
<script>
(function () {
  var f = document.getElementById('f'),
      pw = document.getElementById('pw'),
      go = document.getElementById('go'),
      msg = document.getElementById('msg');

  f.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (go.disabled) return;
    var value = pw.value;
    if (!value) return;

    go.disabled = true;
    msg.textContent = '';
    try {
      var res = await fetch('login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password: value })
      });
      var data = await res.json().catch(function () { return {}; });
      if (res.ok && data.ok) {
        location.replace('./');
        return;
      }
      msg.textContent = data.error || 'Incorrect password';
    } catch (err) {
      msg.textContent = 'Network error, please try again';
    }
    pw.value = '';
    go.disabled = false;
    pw.focus();
  });
})();
</script>
</body></html>
"""


# ─────────────────────────── HTTP handling ───────────────────────────


class Handler(BaseHTTPRequestHandler):
    server_version = "muscovado"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    # ---- Basic responses ----

    def _headers(self, status: int, ctype: str, length: int, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; "
            "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; "
            "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        )
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()

    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None, head_only=False) -> None:
        self._headers(status, ctype, len(body), extra)
        if not head_only:
            self.wfile.write(body)

    def _json(self, status: int, payload: dict, extra: dict | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8", extra)

    def _redirect(self, location: str, extra: dict | None = None) -> None:
        self._send(302, b"", "text/plain; charset=utf-8", {"Location": location, **(extra or {})})

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - fixed signature
        sys.stderr.write("[authd] %s %s\n" % (client_ip(self), format % args))

    # ---- Request parsing ----

    def _cookie_token(self) -> str:
        raw = self.headers.get("Cookie") or ""
        try:
            jar = SimpleCookie(raw)
        except Exception:  # noqa: BLE001
            return ""
        morsel = jar.get(COOKIE_NAME)
        return morsel.value if morsel else ""

    def _authed(self) -> bool:
        return session_valid(self._cookie_token())

    def _origin_ok(self) -> bool:
        """Validate that Origin / Referer belongs to an allowed source.

        ALLOWED_ORIGINS supports three forms:
          Exact origin   https://panel.example.com
          Wildcard sub   https://*.example.com
          Local any port http://127.0.0.1:*   (recommended for local debugging only)
        """
        origin = (self.headers.get("Origin") or "").strip()

        def allowed(value: str) -> bool:
            for rule in ALLOWED_ORIGINS:
                if rule == value:
                    return True
                if "*" in rule:
                    # Treat * as a single wildcard segment; the rest must match exactly
                    head, _, tail = rule.partition("*")
                    if value.startswith(head) and value.endswith(tail) and len(value) >= len(head) + len(tail):
                        return True
            return False

        if origin:
            return allowed(origin)
        referer = (self.headers.get("Referer") or "").strip()
        if referer:
            # Referer is a full URL (with path); strip to the origin part before comparing
            m = re.match(r"^([a-z][a-z0-9+.-]*://[^/]+)", referer, re.I)
            return allowed(m.group(1)) if m else False
        # Neither present: reject state-changing requests (a normal same-origin
        # browser request always carries one of them)
        return False

    def _csrf_ok(self) -> bool:
        token = self._cookie_token()
        if not token:
            return False
        given = (self.headers.get("X-CSRF") or "").strip()
        return bool(given) and hmac.compare_digest(given, csrf_for(token))

    def _read_json(self, limit: int = 64 * 1024) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return {}
        if length <= 0 or length > limit:
            return {}
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8", "replace"))
        except (ValueError, OSError):
            return {}
        return payload if isinstance(payload, dict) else {}

    # ---- Routing ----

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET(head_only=True)

    def do_GET(self, head_only: bool = False) -> None:  # noqa: N802
        path = urlparse(self.path).path.rstrip("/") or "/"

        # Login page: public
        if path in ("/login", "/login.html"):
            if self._authed():
                self._redirect("./")
                return
            self._send(200, LOGIN_PAGE.encode("utf-8"), "text/html; charset=utf-8",
                       {"Cache-Control": "no-store"}, head_only)
            return

        if path == "/favicon.ico":
            self._send(204, b"", "image/x-icon", {"Cache-Control": "public, max-age=86400"}, head_only)
            return

        # Everything below requires a valid session
        if not self._authed():
            if path.startswith("/api/"):
                self._json(401, {"ok": False, "error": "not logged in"})
            else:
                self._redirect("login")
            return

        token = self._cookie_token()

        if path == "/api/status":
            self._json(200, {"ok": True, "hermes": hermes_status()})
            return

        if path == "/api/sessions":
            self._json(200, {"ok": True, "sessions": list_sessions()})
            return

        if path == "/api/image":
            qs = parse_qs(urlparse(self.path).query)
            token = (qs.get("t") or [""])[0]
            real = path_from_token(token)
            if not real:
                self._json(404, {"ok": False, "error": "image not found or access denied"})
                return
            try:
                with open(real, "rb") as fh:
                    body = fh.read()
            except OSError:
                self._json(404, {"ok": False, "error": "read failed"})
                return
            ext = os.path.splitext(real)[1].lower()
            self._send(
                200, body,
                IMAGE_MIME.get(ext, "application/octet-stream"),
                {"Cache-Control": "private, max-age=600"},
                head_only,
            )
            return

        if path == "/api/history":
            qs = parse_qs(urlparse(self.path).query)
            sid = (qs.get("id") or [""])[0]
            if not HERMES_SID_RE.match(sid):
                self._json(400, {"ok": False, "error": "invalid session id"})
                return
            self._json(200, {"ok": True, "messages": session_history(sid)})
            return

        if path == "/api/session":
            self._json(200, {"ok": True, "csrf": csrf_for(token)})
            return

        # Static assets (whitelist)
        name = "index.html" if path in ("/", "") else path.lstrip("/")
        ctype = STATIC_FILES.get(name)
        if not ctype:
            self._json(404, {"ok": False, "error": "not found"})
            return
        full = os.path.join(SITE_DIR, name)
        try:
            with open(full, "rb") as fh:
                body = fh.read()
        except OSError:
            self._json(404, {"ok": False, "error": "not found"})
            return
        cache = "no-store" if name == "index.html" else "private, max-age=60"
        self._send(200, body, ctype, {"Cache-Control": cache}, head_only)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.rstrip("/") or "/"

        if path == "/login":
            self._handle_login()
            return

        # Every other POST must satisfy all of: logged in + legitimate origin + correct CSRF
        if not self._authed():
            self._json(401, {"ok": False, "error": "not logged in"})
            return
        if not self._origin_ok() or not self._csrf_ok():
            self._json(403, {"ok": False, "error": "request validation failed"})
            return

        if path == "/api/logout":
            drop_session(self._cookie_token())
            self._json(200, {"ok": True}, {
                "Set-Cookie": f"{COOKIE_NAME}=; Path={COOKIE_PATH}; Max-Age=0; "
                              f"HttpOnly;{_secure_attr()} SameSite=Strict",
            })
            return

        if path == "/api/chat":
            self._handle_chat()
            return

        if path == "/api/asr":
            self._handle_asr()
            return

        self._json(404, {"ok": False, "error": "not found"})

    # ---- Business logic ----

    def _handle_login(self) -> None:
        ip = client_ip(self)
        started = time.time()

        def uniform_delay() -> None:
            # Uniform response pacing so timing can't be used to tell
            # "right/wrong password" or "is it locked"
            elapsed = time.time() - started
            target = 0.55 + secrets.randbelow(150) / 1000.0
            if elapsed < target:
                time.sleep(target - elapsed)

        locked, remain = lock_state(ip)
        if locked:
            # Still run one scrypt pass to keep the cost equal to the normal failure path
            verify_password("x" * 12, load_secret())
            record_attempt(ip, False)
            uniform_delay()
            self._json(429, {
                "ok": False,
                "error": f"too many attempts, please try again in {max(1, remain // 60)} minutes",
            })
            return

        payload = self._read_json()
        password = payload.get("password")
        if not isinstance(password, str) or not password or len(password) > 200:
            verify_password("x" * 12, load_secret())
            record_attempt(ip, False)
            uniform_delay()
            self._json(400, {"ok": False, "error": "incorrect password"})
            return

        secret = load_secret()
        if secret is None:
            verify_password(password, None)
            uniform_delay()
            self._json(503, {"ok": False, "error": "no password configured on the server"})
            return

        if not verify_password(password, secret):
            record_attempt(ip, False)
            uniform_delay()
            self._json(401, {"ok": False, "error": "incorrect password"})
            return

        record_attempt(ip, True)
        token = create_session(ip, self.headers.get("User-Agent") or "")
        uniform_delay()
        self._json(200, {"ok": True}, {
            "Set-Cookie": (
                f"{COOKIE_NAME}={token}; Path={COOKIE_PATH}; Max-Age={SESSION_TTL}; "
                f"HttpOnly;{_secure_attr()} SameSite=Strict"
            ),
            "Cache-Control": "no-store",
        })

    def _ndjson_start(self) -> None:
        """Start an NDJSON stream.

        Use HTTP/1.1 chunked encoding rather than "no Content-Length + Connection: close".
        The latter requires the browser to detect end-of-body from the connection
        closing -- if the FIN is swallowed or delayed by an intermediary
        (frp / nginx / carrier proxy), read() hangs forever: the content is fully
        displayed, yet the frontend still sits in "busy" and can't even send the
        next message. Chunked has an explicit terminating block ("0" chunk) and
        does not depend on connection state.
        """
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        # Tell nginx / intermediaries not to buffer so the browser receives chunks as they come
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self._chunked = True

    def _ndjson_write(self, payload: dict) -> None:
        body = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        try:
            if getattr(self, "_chunked", False):
                self.wfile.write(b"%x\r\n" % len(body) + body + b"\r\n")
            else:
                self.wfile.write(body)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            raise

    def _ndjson_end(self) -> None:
        """Send the chunked terminating block. Without it the browser keeps waiting for another chunk."""
        if not getattr(self, "_chunked", False):
            return
        try:
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _handle_asr(self) -> None:
        """Receive audio recorded by the phone and forward it to the local asr_api for transcription.

        Forwarding happens over loopback only (asr_api listens on 127.0.0.1); the audio is
        never written to disk or retained.
        """
        import urllib.error
        import urllib.request

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            self._json(400, {"ok": False, "error": "no audio data"})
            return
        if length > ASR_MAX_BYTES:
            self._json(413, {"ok": False, "error": "recording too large"})
            return
        audio = self.rfile.read(length)
        _t0 = time.time()

        req = urllib.request.Request(
            ASR_API + "/transcribe",
            data=audio,
            headers={"Content-Type": self.headers.get("Content-Type") or "application/octet-stream"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=ASR_TIMEOUT) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            try:
                detail = json.loads(exc.read().decode("utf-8")).get("error", "")
            except Exception:  # noqa: BLE001
                detail = ""
            self._json(502, {"ok": False, "error": detail or f"transcription service returned {exc.code}"})
            return
        except Exception as exc:  # noqa: BLE001
            self._json(502, {"ok": False, "error": "transcription service unavailable: " + str(exc)[:120]})
            return

        text = payload.get("text", "") or ""
        # Log one line with size and timing: when debugging "voice did nothing"
        # you must be able to tell apart "never uploaded", "uploaded but
        # recognized nothing", and "slow to recognize".
        sys.stderr.write(
            "[asr] %s bytes=%d audio=%.1fs asr=%dms total=%dms chars=%d\n"
            % (client_ip(self), len(audio), payload.get("seconds", 0) or 0,
               payload.get("ms", 0) or 0, int((time.time() - _t0) * 1000), len(text))
        )

        self._json(200, {
            "ok": bool(payload.get("ok")),
            "text": text,
            "seconds": payload.get("seconds", 0),
            "ms": payload.get("ms", 0),
        })

    def _handle_chat(self) -> None:
        payload = self._read_json(limit=64 * 1024)
        message = payload.get("message")
        if not isinstance(message, str):
            self._json(400, {"ok": False, "error": "invalid parameter"})
            return
        message = message.replace("\x00", "").strip()
        if not message:
            self._json(400, {"ok": False, "error": "content is empty"})
            return
        if len(message) > CHAT_MAX_CHARS:
            self._json(413, {"ok": False, "error": f"content too long (limit {CHAT_MAX_CHARS} characters)"})
            return

        # rid: id of an existing Hermes session to continue (sent when opening a past session)
        rid = payload.get("rid")
        resume_id = rid if isinstance(rid, str) and HERMES_SID_RE.match(rid) else None

        # bk: new local session key, used to create/continue a same-named session in Hermes
        bk = payload.get("bk")
        session_name = bk if isinstance(bk, str) and CHAT_SESSION_RE.match(bk) else (
            "aipanel-" + secrets.token_hex(8)
        )

        self._ndjson_start()
        final_sid = ""
        try:
            for evt in ask_hermes_stream(message, session_name, resume_id):
                if evt.get("session_id"):
                    final_sid = evt["session_id"]
                self._ndjson_write(evt)
        except (BrokenPipeError, ConnectionResetError):
            # Browser disconnected (page switch / network loss); the Hermes process is
            # already cleaned up inside the generator
            pass
        finally:
            # Whether we finish normally or with an exception, the chunked
            # terminator must be sent, otherwise the browser waits for another
            # chunk forever and the frontend never sees the stream end.
            self._ndjson_end()

        # After the first turn of a new session, use the user's first sentence as the
        # title (done in the background, doesn't block the response)
        if final_sid and not resume_id:
            threading.Thread(
                target=rename_session, args=(final_sid, message), daemon=True
            ).start()


# ─────────────────────────── Startup ───────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(description="Muscovado: auth and backend service")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--host", default=HOST)
    args = parser.parse_args()

    os.makedirs(STATE_DIR, exist_ok=True)
    os.chmod(STATE_DIR, 0o700)
    init_db()

    if load_secret() is None:
        sys.stderr.write(
            "[authd] warning: no password configured yet, logins will be rejected.\n"
            "[authd] run this first: python3 %s/set_password.py\n" % BASE_DIR
        )
    if not os.path.exists(HERMES_BIN):
        sys.stderr.write(f"[authd] warning: hermes executable not found at {HERMES_BIN}\n")
    if not os.path.exists(os.path.join(SITE_DIR, "index.html")):
        sys.stderr.write(f"[authd] warning: no index.html in site directory ({SITE_DIR})\n")
    if "https://example.com" in ALLOWED_ORIGINS:
        # The most common deployment accident: you change the password and can log
        # in, but every POST returns 403, and the page only says "request
        # validation failed" -- hard to connect to this setting.
        sys.stderr.write(
            "[authd] warning: allowed_origins is still the template default https://example.com,\n"
            "         so the browser's Origin won't match and every action after login will 403.\n"
            "         Set it to your actual access URL, e.g. https://your-domain.com\n"
            "         For local debugging, wildcard forms like http://127.0.0.1:* work.\n"
        )

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    sys.stderr.write(f"[authd] listening on http://{args.host}:{args.port} site dir {SITE_DIR}\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
