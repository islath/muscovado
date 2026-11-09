#!/usr/bin/env python3
"""Muscovado config generator.

Pulls the paths and allowed origins that used to be hard-coded in authd.py out
into config.json, so the app can be deployed on any machine with Hermes
installed.

Usage:
    python3 server/config_gen.py init          # write config.json from the defaults below
    python3 server/config_gen.py init --force  # overwrite
    python3 server/config_gen.py show          # print the active config

config.json must not be committed (already excluded in .gitignore).
authd.py prefers it at startup and falls back to built-in defaults when it is
missing, so older deployments keep working without the extra file.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")

TEMPLATE = {
    # Full public origin used for Origin/Referer checks.
    # Mounted under /ai/ behind a reverse proxy: use https://your-domain.
    # No domain: use http://IP:port
    "allowed_origins": ["https://example.com"],
    # Cookie Path; must match the reverse-proxy mount point, otherwise the cookie is sent to the whole domain
    "cookie_path": "/ai",
    # Whether to mark the cookie Secure. Only disable for http-based local debugging
    "cookie_secure": True,
    # Hermes executable
    "hermes_bin": os.path.expanduser("~/.local/bin/hermes"),
    # Hermes session DB (opened read-only)
    "hermes_state_db": os.path.expanduser("~/.hermes/state.db"),
    # cwd and PATH used when invoking Hermes (Hermes resolves project context from cwd)
    "hermes_cwd": os.path.expanduser("~"),
    "hermes_path": os.path.expanduser("~/.local/bin") + ":/usr/local/bin:/usr/bin:/bin",
    # Local ASR service (leave empty if voice is not installed; the panel is then text-only)
    "asr_api": "http://127.0.0.1:9131",
    # Directories allowed to serve images (whitelist; resolved paths are checked for traversal)
    "image_dirs": [
        os.path.expanduser("~/.hermes/images"),
        os.path.expanduser("~/.hermes/cache"),
        os.path.expanduser("~/Pictures"),
    ],
    # Directories scanned for newly generated images
    "image_scan_dirs": [
        os.path.expanduser("~/.hermes/images"),
        os.path.expanduser("~/.hermes/cache"),
    ],
    # Optional: Hermes skills preloaded on every turn (e.g. where images live and how to reference them)
    "hermes_skills": [],
    "host": "127.0.0.1",
    "port": 9120,
}


def init(force: bool = False) -> int:
    if os.path.exists(CONFIG_PATH) and not force:
        print(f"Already exists: {CONFIG_PATH} (use --force to overwrite)")
        return 1
    with open(CONFIG_PATH, "w", encoding="utf-8") as fh:
        json.dump(TEMPLATE, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.chmod(CONFIG_PATH, 0o600)
    print(f"Generated: {CONFIG_PATH}")
    print("Edit allowed_origins / cookie_path / port as needed, then restart muscovado.")
    return 0


def show() -> int:
    if not os.path.exists(CONFIG_PATH):
        print(f"No {CONFIG_PATH}; authd will use built-in defaults.")
        return 0
    with open(CONFIG_PATH, encoding="utf-8") as fh:
        print(fh.read())
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Muscovado config generator")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_init = sub.add_parser("init", help="Generate config.json")
    p_init.add_argument("--force", action="store_true", help="Overwrite an existing file")
    sub.add_parser("show", help="Show the active config")
    args = ap.parse_args()
    if args.cmd == "init":
        return init(args.force)
    if args.cmd == "show":
        return show()
    return 1


if __name__ == "__main__":
    sys.exit(main())
