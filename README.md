# Muscovado

**A mobile-first, general-purpose chat frontend** — voice input, text input,
inline image display, conversation history. The backend is pluggable: the repo
ships a reference implementation that drives
[Hermes Agent](https://github.com/NousResearch/hermes-agent).

The frontend is not tied to any particular service. It speaks one simple
contract: send a message, receive a streamed answer, display images.

```
┌──────────────┐
│ Mobile       │
│ browser      │   voice / text / images
│  ┌────────┐  │          │
│  │  chat  │  │          ▼
│  └────────┘  │   NDJSON stream
└──────┬───────┘
       │
       ▼
┌──────────────────────────────────────┐
│ Any backend (reference: server/)     │
│  auth · history · streaming · images │
└──────────────────┬───────────────────┘
                   ▼
             Hermes Agent / your model
```

---

## What this is

A working chat frontend focused on the problems that actually show up when you
build conversational AI for a phone browser:

- **One control, not a row of buttons** — tap to type, hold to speak, hold and
  swipe up to cancel
- **Server-side speech recognition** — no dependency on the browser's built-in
  `SpeechRecognition`, which is unavailable on many networks
- **Streaming markdown rendering** — headings, lists, tables, fenced code
- **A 28px activity bar** while waiting, showing what the backend is doing
- **Conversation sidebar** with context continuation
- **Image display** — images returned by the backend slide out from the top
  edge of the input bar
- **Tuned for iOS Safari** — consistent full-screen background and keyboard
  tracking

Genericity comes from the **protocol**, not the code layout. Implement the
[backend contract](#backend-contract) and the frontend works unchanged.

## What this is not

An honest list, so nobody is surprised:

| Capability | Status |
|---|---|
| Text chat + streaming markdown | ✅ complete |
| Voice input (server-side ASR) | ✅ complete |
| History + context continuation | ✅ complete |
| Image **display** (images from the backend) | ✅ complete |
| Image **upload** (user sends images to the model) | ❌ **not implemented** |
| Multiple images in the preview | ❌ one at a time |
| Frontend state persistence | ❌ reload starts a new chat |
| Multi-user / roles | ❌ single password |
| Streaming ASR (words appear as you speak) | ❌ record, then transcribe |

Image upload is the biggest gap. The preview panel and the `/api/image` read
path already exist; what's missing is the upload path — pick image → encode →
send with the message → hand it to the model.

---

## Reference backend

The repo ships a complete, working Hermes backend:

```
server/authd.py    auth + static files + streaming /api/chat + /api/asr proxy
server/asr_api.py  local speech recognition (sherpa-onnx Paraformer)
```

It also handles the parts that are annoying in production:

- **Password auth** — scrypt hashing, session tokens stored only as SHA-256,
  CSRF + Origin validation, per-IP and global brute-force throttling,
  fail-closed
- **Streaming transport** — chunked encoding with stall detection, so
  intermediary buffering can't swallow the end of a response
- **Local speech** — audio never leaves the machine

---

## Backend contract

The frontend depends on these endpoints only. Implement them to plug in your
own model.

| Endpoint | Description |
|---|---|
| `GET /api/session` | Returns `{csrf}`; required on later writes |
| `GET /api/sessions` | `{sessions:[{id,title,at}]}` |
| `GET /api/history?id=<sid>` | `{messages:[{role,text}]}` |
| `POST /api/chat` | Send a message, receive an **NDJSON stream** |
| `POST /api/asr` | Raw audio bytes in, `{text}` out |
| `GET /api/image?t=<token>` | Image bytes |

### Stream events

One JSON object per line from `POST /api/chat`:

```jsonc
{"type":"init","session_id":"..."}              // session established
{"type":"step","kind":"tool","name":"search"}   // optional: activity step
{"type":"answer_start"}                          // first token is coming
{"type":"delta","text":"..."}                    // content chunk, repeatable
{"type":"done","session_id":"...","images":[{"url":"api/image?t=..."}]}
{"type":"error","message":"..."}
```

> **Terminate with chunked encoding** (or an explicit end marker) rather than
> relying on connection close. If the FIN is swallowed by nginx, frp, or a
> carrier proxy, the client waits forever: the answer is fully rendered but the
> UI still thinks it is busy. See `docs/ARCHITECTURE.md`.

---

## Quick start (reference backend)

Requirements: **Hermes Agent installed** (`hermes chat` answers prompts),
Python 3.10+, Linux.

```bash
git clone https://github.com/islath/muscovado.git ~/muscovado
cd ~/muscovado

python3 server/config_gen.py init     # generate config, edit paths to match yours
vim server/config.json
python3 server/set_password.py        # set the access password (interactive)
bash deploy/install.sh                # install as a systemd user service

curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9120/login   # expect 200
```

Open `http://127.0.0.1:9120/`.

- **Public access** (HTTPS, usable from your phone anywhere):
  see [`docs/DEPLOY.md`](docs/DEPLOY.md)
- **Voice input** (optional): DEPLOY section 4.2 — install `sherpa-onnx` plus a
  Paraformer model. Without it everything else still works; there is just no
  voice.

---

## Customising

**Theme** — CSS variables at the top of `web/app.css`. Dark, single theme.

**Language** — UI strings live in `web/app.js`, `web/index.html`, and
`web/composer.js`. There is no i18n layer yet; the UI is Chinese only.

**Backend** — implement the [backend contract](#backend-contract) and point the
frontend at it. All requests are relative; the `API` constant at the top of
`web/app.js` is the single place to change.

**Model** — the reference backend shells out to
`hermes chat --format stream-json`. To use a different CLI or HTTP API, translate
its output into the stream events above.

---

## Layout

```
web/                    static frontend, no dependencies, no build step
  index.html            markup
  app.css               styles (dark, mobile-first, iOS tuning)
  app.js                message flow / API / streaming markdown / gestures
  composer.js           input bar and audio capture
  markdown.js           markdown renderer (dependency-free, tolerant of partial input)

server/                 reference backend, standard library only
  authd.py              auth + static + chat bridge + ASR proxy
  asr_api.py            speech transcription (sherpa-onnx Paraformer)
  set_password.py       set the access password
  config_gen.py         generate config.json
  dev_proxy.py          local development (mounts under /ai)
  fix_session_titles.py batch-rename generated session titles

deploy/                 systemd units, nginx snippet, install script
docs/
  DEPLOY.md             deployment guide, with a troubleshooting table
  ARCHITECTURE.md       design rationale and pitfalls
```

---

## Security notes

The reference backend assumes **a single user on a machine you control**:

- **One password**, no accounts or roles
- Listens on `127.0.0.1` only; public access must go through a reverse proxy
- **HTTPS required** — the session cookie is `Secure`, and browsers only allow
  microphone access in a secure context
- Changing the password invalidates all existing sessions
- The only state worth backing up is `server/state/secret.json` and
  `server/state/authd.db`

If you want a multi-user service, the auth layer needs to be rewritten. Do not
expose this directly to the internet as-is.

---

## License

MIT — see [LICENSE](LICENSE).
