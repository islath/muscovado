# Contributing

## Before you change code

```bash
git clone https://github.com/islath/muscovado.git
cd muscovado
python3 server/config_gen.py init
# For local debugging, set these two in config.json:
#   "allowed_origins": ["http://127.0.0.1:*"]
#   "cookie_secure": false
python3 server/set_password.py

python3 server/authd.py        # terminal A
python3 server/dev_proxy.py    # terminal B → http://127.0.0.1:9122/ai/
```

Changes under `web/` only need a refresh; changes to `authd.py` require restarting the process.

## Before committing

- Python: `python3 -m py_compile server/*.py`
- JS: check the browser console for syntax errors (there is no build step and no node dependencies)
- Walk through manually: log in → send a message → markdown rendering → press-and-hold to speak → open and close the preview panel
- **Do not commit** `server/state/` or `server/config.json` (already in `.gitignore`)

## Code style

- Comments explain **why**, not what the syntax does
- The frontend has zero dependencies and zero build step; the backend uses the standard library only
- For security-related changes, describe the threat model in the PR description

## Reporting issues

Please include:

- The symptom ("only the thinking panel appears" and "a few characters appear then it stops" are different bugs)
- Browser and version (iOS Safari behaves very differently from desktop)
- The output of `journalctl --user -u muscovado -n 50` (**redact passwords and paths**)
