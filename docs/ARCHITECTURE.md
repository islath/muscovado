# Implementation Notes

This document explains **why** things are built the way they are. For deployment steps see [`DEPLOY.md`](DEPLOY.md).

The project has two parts:

- **web/** — a general-purpose chat frontend. It depends only on a set of HTTP endpoints (see "Backend protocol" in the README) and does not care what model the backend is wired to.
- **server/** — the reference backend. It connects the chat to a local Hermes Agent instance and additionally provides password authentication and local speech recognition.

Most of what follows covers the trade-offs in the reference backend; frontend-specific pitfalls are collected in section 5.

---

## 1. Why "run the workload locally, expose only an entry point"

Hermes lives on your own machine; the session store, models and tools are all local. Moving the workload to a public VPS just to enable remote access would mean handing over API keys, conversation data and even shell access.

So the public machine does exactly two things: TLS termination and reverse proxying. It stores no data; the only processes it needs are nginx and frps.

```
phone ──HTTPS──► VPS nginx ──► frp tunnel ──► local authd ──► Hermes / ASR
```

Traffic inside the tunnel is plain HTTP, but it only crosses an frp port you control, and frps is not exposed to the internet.

---

## 2. Authentication

### Password

`server/state/secret.json` stores only the salt and hash of `scrypt(n=2^15, r=8, p=1, maxmem=96MB)`, mode 0600. The plaintext password is never written to disk, never logged and never enters shell history (`set_password.py` reads it interactively via `getpass`).

### Sessions

On successful login the browser receives a 32-byte random token; **the server stores only its SHA-256**. Even if the database is stolen, the tokens in it cannot be used.

All four cookie attributes are required:

```
HttpOnly        unreadable from JS, blocks token theft via XSS
Secure          sent over HTTPS only
SameSite=Strict not sent on cross-site requests; first line of CSRF defence
Path=/ai        matches the mount point, so the cookie is not sent site-wide
```

### CSRF and origin checks

The CSRF token is derived from the session token (`HMAC(session token)`) and handed out by `GET /api/session`. Every POST must carry `X-CSRF`. In addition, the `Origin` header (falling back to `Referer`) must be in the `allowed_origins` allow-list — if both are missing, the request is rejected outright.

### Brute-force protection

- **Per IP**: 3 failures within 15 minutes trigger a lockout. The first lockout lasts 30 minutes, subsequent ones grow exponentially, capped at 24 hours.
- **Global**: 20 failures within 10 minutes put the whole site into a 60-minute cooldown, which stops distributed attempts that rotate IPs.
- **Timing side channels**: the wrong-password, locked-out and no-password-set paths all run **an equivalent-cost scrypt** plus a uniform delay. An attacker cannot distinguish "wrong password" from "locked out" by response time.

### fail-closed

With no `secret.json` present, login returns 503 rather than "no password configured, let them in".

### Injection / bypass hardening

| Risk | Mitigation |
|---|---|
| Command injection | Hermes is invoked with array arguments plus stdin, never through a shell |
| SQL injection | Everything is parameterised |
| Path traversal | Static files are served from an allow-list; images must resolve to a real path inside an allow-listed directory |
| Session-name injection | `sid` and `bk` are validated by strict regexes; arbitrary strings are rejected |
| Auth bypass | **Static assets also go through authd.** Serving css/js directly from nginx would be a bypass |
| Direct external access | Listens on `127.0.0.1` only; public access must go through the tunnel and nginx |
| Clickjacking | `X-Frame-Options: DENY` + CSP |
| MIME sniffing | `X-Content-Type-Options: nosniff` |

---

## 3. Chat

### Invocation

```
hermes chat --query-file - --oneshot --format stream-json [-Q] [--resume <sid>]
```

The message body goes in over stdin. Output is NDJSON, parsed line by line and translated into frontend events:

```
{"type":"init","session_id":"..."}             session established
{"type":"step","kind":"tool","name":"..."}     Hermes is calling a tool
{"type":"answer_start"}                       first token is coming
{"type":"delta","text":"..."}                  answer chunks × N
{"type":"done","session_id":"...","images":[]} finished
```

### Why streaming is mandatory

Hermes has a time-to-first-token of 6–15 seconds (system prompt plus tool table, roughly 16k tokens). Returning the whole answer at once means ten seconds of blank screen. In practice a medium-length answer produces over a thousand chunks.

### Context continuation

The first request of a new session omits `--resume`. Once the `session_id` arrives in the `init` event, every subsequent request passes `--resume`, and Hermes manages the context window itself.

### Session titles

New sessions are created with a random `bk`, which Hermes adopts as the title — the sidebar fills up with `aipanel-<hex>`. After the first turn completes, the backend calls `hermes sessions rename <sid> "<first 18 chars of the opening line>"` in the background. For historical sessions, `server/fix_session_titles.py --apply` fixes them in bulk.

---

## 4. Voice

```
long-press the composer for 180ms
  → composer.js classifies the gesture (long-press / tap / swipe-up to cancel)
  → WebAudio captures PCM: AudioContext → MediaStreamSource → ScriptProcessor
  → on release: merge Float32 buffers → linear downsample to 16k → build a WAV by hand
  → POST /api/asr (Cookie + X-CSRF + Origin)
  → authd validates, then forwards to 127.0.0.1:9131/transcribe
  → asr_api.py: ffmpeg decode → sherpa-onnx Paraformer → {text, seconds, ms}
  → the frontend fills in the text and sends it; a swipe-up cancel discards it without uploading
```

### Why not MediaRecorder

On iOS, repeatedly calling `new MediaRecorder` on **the same stream** fails silently: the first few `ondataavailable` calls deliver data normally, then nothing arrives and no error is raised, so the flow never reaches upload. The symptom is "it breaks after a few rounds". Both its state machine and its audio session are outside our control.

Capturing PCM with WebAudio and building the WAV ourselves means the capture chain is created once, and recording is controlled by a single boolean — no intermediate state machine.

### Why permission and the audio chain are separated

- **Permission**: `getUserMedia` is called 300ms after page load. On iOS this is usually rejected without a gesture, so the call is silent and does not bother the user.
- **Audio chain**: the `AudioContext` must be created inside the same user gesture that uses it. Created at page load, it is judged gesture-less and stays **permanently suspended** — a later `resume()` inside a touch handler does not revive it (reproduced in testing), and reusing it records silence.

So: acquire the stream at load time, build the audio graph at the moment of press. Each entry into recording also checks `state !== 'running'` and, if so, rebuilds once inside the same gesture.

### Points to remember

- `getUserMedia` must be the **first await** in `ensureCaptureChain`. If `await ctx.resume()` runs first, the call lands outside the gesture and iOS rejects it outright — the symptom is "pressing never brings up the permission prompt".
- **Stream acquisition and graph creation must be decided separately.** An earlier version was written as `if (!micLive()) { acquire stream; build graph }`; once the stream already existed from the early permission request, the whole block was skipped and `onaudioprocess` never fired a single byte. The symptom was "I clearly spoke, but it says no audio was recorded".
- The microphone is released automatically after 5 minutes idle (so the recording indicator is not left on) and on `pagehide`.
- The client enforces a hard 25-second transcription timeout, and the HUD shows elapsed seconds, so it never sits on "transcribing" forever.
- `asr_api` uses its recognizer serially; a request that waits more than 15 seconds gets a 503, so one stuck request cannot block everything behind it.

---

## 5. Frontend

### Gestures

| Gesture | Result |
|---|---|
| Tap the composer (< 320ms) | Enter keyboard input |
| Hold for 180ms | Start recording, HUD appears |
| Swipe up > 64px while recording | Cancel (nothing uploaded on release) |
| Swipe up on the input bar | Pull out the image preview |
| Swipe down inside the preview | Collapse it |
| Swipe right from the left edge | Open the session list |
| Swipe the session list left > 26% | Collapse it |

`composer.js` takes over all touch handling on the composer (the textarea has `pointer-events: none` while idle); otherwise iOS shows the magnifier/selection menu and `touchend` pops the keyboard automatically. The recording state is exposed to `app.js` via `window.__composer.S.mode`, and the preview gesture uses it to decide whether an upward swipe cancels voice or pulls out the preview.

### Markdown rendering

`markdown.js` is hand-written and dependency-free, for two reasons:

1. The page has to open instantly on networks in China and cannot wait on a CDN.
2. Streaming output must tolerate **half-written** input — the last line is often `## 1. Overv`, or a ``` fence is still unclosed. The renderer must display partial syntax as-is instead of swallowing content.

On security: all text is escaped first and then assembled into HTML by structure; **no raw HTML is ever passed through**. Links are restricted to `http/https/relative paths`, which blocks `javascript:`.

### Three streaming-render pitfalls

All three were found the hard way in testing; get them wrong and the symptom is "the answer stalls until you refresh":

1. **Do not use rAF's return value to decide whether a frame is queued.** `requestAnimationFrame` can return 0, and once it does, the code treats it as "a frame is already queued" and never schedules again — content piles up in memory. Use a separate boolean instead.
2. **On iOS rAF stops entirely** (backgrounding, screen lock, low-power mode). So besides rAF there is a 150ms fallback timer that forces a frame whenever "bytes received ≠ bytes rendered".
3. **Do not cache nodes inside the container.** Every render rewrites `innerHTML`, so a previously cached `<p>` becomes a detached node; writing to it is invisible on screen.

### Detecting end of stream

The server uses **chunked encoding** with an explicit final chunk, rather than "no Content-Length + close the connection". The latter forces the browser to infer the end of the body from connection close — and if the FIN is swallowed or delayed by an intermediary, `read()` hangs forever: the content is long since displayed, but the frontend still thinks it is busy and discards the next message.

The frontend adds two more safeguards: on a `done` event it calls `cancel()` on the reader, and if no data arrives for 90 seconds it disconnects and appends "the answer may be incomplete" to the bubble.

### Preview panel

- `.drawer-clip` is a clipping layer whose bottom edge sits on the top edge of the composer. The panel slides inside it, so the revealed part can only "grow" out of the top edge and never shows through beside the composer.
- Height is `auto` to fit the content; the empty state is a 16:9 card, and with an image the border hugs the image.
- While collapsed, the clipping layer is `pointer-events: none` (otherwise it swallows touches across the whole page); it is enabled only when open. **Anywhere the panel's `open` state changes must update the clipping layer in sync** — miss one place and "swipe down to collapse does nothing".

### iOS background-colour consistency

This took the most time of anything here. The conclusions:

- **Exactly one layer of page background**: `html` transparent, `body` the only coloured layer, `.app` transparent. Safari picks a single colour to tint the bottom bar/toolbar, and any edge-adjacent element with a background will pollute it.
- **No `theme-color`** (it no longer works on iOS 26+), and **no `apple-mobile-web-app-status-bar-style=black-translucent`** (26.1 layers on a dark scrim that cannot be turned off).
- The glow is contained inside `.app` and faded to zero top and bottom by a `mask-image`, so it never touches the physical edges.
- The composer has no background fill and no shadow, only a 1px border. It used to be filled with `var(--bg)`; it looks like the same colour, but the page in that band is tinted by the sidebar's shadow and is not exactly `--bg`, so the solid block read one shade darker and appeared as a rectangle.

---

## 6. Data flow overview

```
                     ┌──────────────┐
  browser ──cookie──►│  authd:9120  │
                     │              │
                     │ session check┼─ fail → 302/401
                     │ CSRF/Origin  │
                     └──────┬───────┘
                            │
        ┌───────────────────┼────────────────────┐
        ▼                   ▼                    ▼
   static files         /api/chat            /api/asr
   web/*.html/js/css    spawn hermes         forward to 9131
                        NDJSON stream        Paraformer
                            │
                            ▼
                     ~/.hermes/state.db
                     (read-only; session list and history)
```

---

## 7. Known limitations

**Frontend capability gaps**

- **Image upload is not implemented.** For now only images returned by the backend can be displayed; the user cannot send images to the model. What is missing is the upload path: pick an image → base64/binary → submit with `POST /api/chat` → backend converts it into a format the model accepts. The preview panel and the `/api/image` read channel already exist; only the uplink is absent.
- Only one image can be previewed at a time.
- The frontend has no persistence; refreshing returns to a new session.
- There is no i18n layer; UI strings are hard-coded (currently Chinese).

**Reference backend limitations**

- Single password, no multi-user support and no role-based permissions.
- The thinking panel shows **tool calls**, not the model's internal reasoning tokens — Hermes's `stream-json` does not expose the latter.
- Voice records the whole utterance and then uploads it for transcription; it is not live dictation.
- `--resume` relies on Hermes's own context management, so long sessions are progressively compacted.
