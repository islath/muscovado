#!/usr/bin/env bash
# One-shot install as systemd user services (Linux)
#
#   bash deploy/install.sh
#
# Two manual steps remain after install (deliberately left to you):
#   1. python3 server/set_password.py   to set the access password
#   2. follow docs/DEPLOY.md to set up nginx / frp (only if you need public access)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"

# The repo directory may not be called muscovado; substitute the real path for %h/muscovado at install time.
for name in muscovado muscovado-asr; do
    src="$REPO/deploy/$name.service"
    [ -f "$src" ] || continue
    sed "s|%h/muscovado|$REPO|g" "$src" > "$UNIT_DIR/$name.service"
    echo "Wrote $UNIT_DIR/$name.service"
done

# Keep services running after logout
if command -v loginctl >/dev/null 2>&1; then
    sudo loginctl enable-linger "$USER" || echo "(failed to enable linger; you can run it yourself: sudo loginctl enable-linger $USER)"
fi

systemctl --user daemon-reload
systemctl --user enable --now muscovado

echo
echo "Started. To check:"
echo "  systemctl --user status muscovado"
echo "  curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:9120/login"
echo
echo "A 503 means no password is set yet: python3 $REPO/server/set_password.py"
echo "To install voice: first prepare the venv and models per docs/DEPLOY.md section 4.2, then"
echo "  systemctl --user enable --now muscovado-asr"
