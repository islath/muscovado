# Deployment Guide

From a machine with [Hermes Agent](https://github.com/NousResearch/hermes-agent) installed to a working panel in a mobile browser. Following these steps takes about 20 minutes.

For the design rationale and why things are built this way, see [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 0. Topology

```
mobile browser ──HTTPS──► public nginx ──► frp ──► your machine's authd ──► Hermes
                          (TLS + proxy only)        (business logic and data stay local)
```

The public machine **stores no business data**. Without a VPS you can use it on the LAN only — skip sections 5 and 6.

---

## 1. Prerequisites

```bash
which hermes
echo "hello" | hermes chat --query-file - --oneshot     # any answer is fine
python3 --version                                       # >= 3.10
```

Optional:

| Dependency | Purpose | Without it |
|---|---|---|
| ffmpeg | Audio decoding | Voice unavailable |
| Paraformer model | Speech transcription | Voice unavailable |
| nginx + frp + VPS | Public access | LAN use only |

---

## 2. Get the code and configure

```bash
git clone https://github.com/islath/muscovado.git ~/muscovado
cd ~/muscovado
python3 server/config_gen.py init
vim server/config.json
```

### Must-change keys

```jsonc
{
  // The origin as seen in the browser's address bar, with scheme, no path or trailing slash
  "allowed_origins": ["https://panel.example.com"],
  "cookie_path": "/ai",          // must match the reverse-proxy mount point
  "cookie_secure": true,         // set false only for plain-http LAN debugging
  "hermes_bin": "/home/YOUR_USER/.local/bin/hermes",
  "hermes_cwd": "/home/YOUR_USER",
  "hermes_state_db": "/home/YOUR_USER/.hermes/state.db"
}
```

> **`allowed_origins` is the most common trap.** When it is wrong the symptom is: login succeeds with the correct password, but every message fails with "request validation failed" (403), because it does not match the `Origin` the browser actually sends.
>
> - Production: `https://your-domain.com` (without `/ai`)
> - Wildcard subdomains: `https://*.example.com`
> - Local debugging: `http://127.0.0.1:*`
>
> If the service still sees the template default at startup, it logs an explicit warning.

---

## 3. Set the password

```bash
python3 server/set_password.py
```

**Do not** put the password in a command-line argument, environment variable or config file — it would end up in shell history and the process list. This script reads it interactively and writes only the scrypt hash to `server/state/secret.json` (0600).

In a single-password system the password strength is the only barrier. Use at least 12 characters and avoid dictionary words.

---

## 4. Start the backend

```bash
bash deploy/install.sh
```

The script substitutes your actual repo path into the systemd units → installs them to `~/.config/systemd/user/` → enables linger (so the service survives logout) → starts it.

Verify:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9120/login
```

| Response | Meaning |
|---|---|
| `200` | OK |
| `503` | No password set yet (fail-closed in effect) → go back to section 3 |

Logs:

```bash
journalctl --user -u muscovado -f
```

### 4.2 Voice (optional)

The transcription service runs separately because it needs `sherpa-onnx`, which we do not want polluting the main environment.

```bash
# 1) venv
python3 -m venv ~/asr/.venv
~/asr/.venv/bin/pip install sherpa-onnx numpy

# 2) Model: sherpa-onnx-paraformer-zh-small-2024-03-09
#    Extract to ~/asr/models/<model-dir>/; you need model.int8.onnx and tokens.txt
#    In China: export HF_ENDPOINT=https://hf-mirror.com

# 3) Start
systemctl --user enable --now muscovado-asr
curl -s http://127.0.0.1:9131/health
```

The model path and port are controlled by `PARA_MODELS` / `PARA_DIR` / `ASR_API_PORT` in the systemd unit; edit those lines when using your own model directory.

Voice is independent of everything else: without it, press-to-talk reports "microphone unavailable" and keyboard input works as usual.

---

## 5. Public entry point

> For LAN-only use, skip to section 6.

### 5.1 frp

On the local machine, `~/.config/frp/frpc.toml`:

```toml
serverAddr = "YOUR_VPS_ADDRESS"
serverPort = 7000
auth.token = "replace-with-your-own"

[[proxies]]
name = "muscovado"
type = "tcp"
localIP = "127.0.0.1"
localPort = 9120
remotePort = 59120
```

The matching port on the VPS in `frps.toml` **should only be reachable by nginx**; do not open it to the internet in the firewall.

### 5.2 nginx

Put the contents of `deploy/nginx.conf` inside the `server {}` block and change the `proxy_pass` port (the example uses frp's 59120; without frp use `http://127.0.0.1:9120/`).

Also declare the rate-limit zones in the `http {}` context:

```nginx
limit_req_zone  $binary_remote_addr zone=muscovado:10m rate=10r/s;
limit_conn_zone $binary_remote_addr zone=muscovado_conn:10m;
```

**Three things you must get right**

1. **The `^~` in `location ^~ /ai/` is not optional.** The common `location ~* \\.(css|js)$` in the same server will claim `/ai/app.css`, causing 404s on static assets.
2. **`proxy_pass` must end with a slash**, so that `/ai/api/chat` becomes `/api/chat` on the backend.
3. **`client_max_body_size` must be at least 10m.** The default 1m only fits a few seconds of audio; a slightly longer recording is cut off by nginx, the frontend shows "transcription stuck", and the only trace in the log is a single 413 — hard to connect.

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 5.3 Certificate

```bash
sudo certbot --nginx -d your-domain.com
```

---

## 6. First-run checklist

| Check | Expected |
|---|---|
| Visit `/ai/` while logged out | Redirected to the login page |
| Wrong password | "Incorrect password"; repeated failures lock the IP |
| Correct password | Main UI opens, sidebar shows past sessions |
| Send a message | Thinking panel appears first, then text streams in |
| Answer contains markdown | Headings / tables / code blocks render correctly |
| Hold the composer and speak | Microphone permission prompt; text appears on release (requires HTTPS) |

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Login returns 503 | No password set | `python3 server/set_password.py` |
| Everything is 403 after login | `allowed_origins` does not match the real origin | Fix `config.json`, restart the service |
| Logged in, then bounced back | `cookie_path` does not match the mount point | Set it to `/ai` |
| Page 404 / missing styles | `^~` missing in nginx | See 5.2 |
| Transcription hangs | `client_max_body_size` too small | Raise to `10m` |
| No microphone permission prompt | Not served over HTTPS | TLS is required |
| Only a few characters appear | Hermes invocation failed | Check `[chat] exit=` lines in `journalctl --user -u muscovado -f` |
| Images do not display | Directory not allow-listed | Add it to `image_dirs` |

---

## 7. Maintenance

```bash
journalctl --user -u muscovado -f               # logs
python3 server/set_password.py                  # change password (existing sessions invalidated immediately)
systemctl --user restart muscovado              # after editing config.json
git pull && systemctl --user restart muscovado  # update
```

**Backups** only need two files:

```
server/state/secret.json    # password hash
server/state/authd.db       # session table
```

Losing them only means logging in again; Hermes's conversation history (in `~/.hermes/state.db`) is unaffected.

---

## 8. Security checklist

- [ ] `server/state/` is mode 0600 and not in git
- [ ] `server/config.json` is not in git
- [ ] The service listens on `127.0.0.1` only
- [ ] The frp-mapped port is not open to the internet
- [ ] The site is served over HTTPS
- [ ] Password is ≥ 12 characters and not a dictionary word
- [ ] You have tried a wrong password and confirmed the lockout works

---

## 9. Local development

```bash
python3 server/authd.py          # backend, in the foreground so logs are visible
python3 server/dev_proxy.py      # in another terminal, port 9122, emulates the /ai mount point
```

Open `http://127.0.0.1:9122/ai/`.

In `config.json`, set `allowed_origins` to `http://127.0.0.1:*` and `cookie_secure` to `false`.

Changes under `web/` just need a refresh (static files are served by authd); **changes to `authd.py` require restarting the process**.

`dev_proxy.py` passes the browser's `Origin` through unchanged, so both sides must agree on the configuration.
