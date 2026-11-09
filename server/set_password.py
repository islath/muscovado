#!/usr/bin/env python3
"""Set / reset the Muscovado access password.

Usage
    python3 server/set_password.py

The password is entered interactively in the terminal: it is never echoed and
never passed as a command-line argument, so it stays out of shell history and
never shows up in logs or conversations. Only the scrypt hash is written to disk.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import secrets
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.path.join(BASE_DIR, "state")
SECRET_PATH = os.path.join(STATE_DIR, "secret.json")

MIN_LEN = 10
SCRYPT = dict(n=2 ** 15, r=8, p=1, dklen=32, maxmem=96 * 1024 * 1024)


def strength_note(password: str) -> str:
    kinds = sum(
        1
        for test in (
            any(c.islower() for c in password),
            any(c.isupper() for c in password),
            any(c.isdigit() for c in password),
            any(not c.isalnum() for c in password),
        )
        if test
    )
    if len(password) >= 16 and kinds >= 2:
        return "strong"
    if len(password) >= 12 and kinds >= 2:
        return "medium"
    return "weak"


def main() -> int:
    parser = argparse.ArgumentParser(description="Set the Muscovado access password")
    parser.add_argument(
        "--stdin", action="store_true",
        help="read the password from stdin (for scripts/automation; it passes "
             "through a pipe, so use with care)",
    )
    parser.add_argument(
        "--min-length", type=int, default=MIN_LEN,
        help=f"minimum length, default {MIN_LEN}; lower it only if you "
             "understand the risk",
    )
    args = parser.parse_args()

    if args.stdin:
        first = sys.stdin.readline().rstrip("\n")
        second = first
    else:
        print(f"Setting Muscovado access password (at least {args.min_length} "
              f"characters, 16+ mixed characters recommended)")
        first = getpass.getpass("New password: ")
        second = getpass.getpass("Repeat password: ")

    if len(first) < args.min_length:
        print(f"Error: password must be at least {args.min_length} characters", file=sys.stderr)
        return 1
    if first != second:
        print("Error: passwords do not match", file=sys.stderr)
        return 1

    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(first.encode("utf-8"), salt=salt, **SCRYPT)

    os.makedirs(STATE_DIR, exist_ok=True)
    os.chmod(STATE_DIR, 0o700)

    payload = {
        "algo": "scrypt",
        "n": SCRYPT["n"],
        "r": SCRYPT["r"],
        "p": SCRYPT["p"],
        "salt": salt.hex(),
        "hash": digest.hex(),
        "updated": int(__import__("time").time()),
    }

    # Write to a temp file, then atomically replace, so an interruption
    # never leaves half a file behind.
    tmp = SECRET_PATH + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)
    os.replace(tmp, SECRET_PATH)
    os.chmod(SECRET_PATH, 0o600)

    print(f"Wrote {SECRET_PATH} (mode 0600), password strength: {strength_note(first)}")
    print("If the service is running, restart it to clear existing sessions:")
    print("    systemctl --user restart muscovado")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
