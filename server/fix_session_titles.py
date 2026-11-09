#!/usr/bin/env python3
"""Rename auto-generated aipanel-xxxx session titles to the user's first message.

The panel creates Hermes sessions with a random bk, so the title is just
aipanel-<hex> and is unrecognizable in the sidebar. This script renames each
session to its first user message.

    python3 fix_session_titles.py            # dry run: list only
    python3 fix_session_titles.py --apply    # actually rename
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import subprocess

STATE_DB = os.environ.get("HERMES_STATE_DB") or os.path.expanduser("~/.hermes/state.db")
HERMES_BIN = os.environ.get("HERMES_BIN") or os.path.expanduser("~/.local/bin/hermes")
TITLE_LEN = 18


def first_user_text(conn: sqlite3.Connection, sid: str) -> str:
    row = conn.execute(
        """
        SELECT content FROM messages
        WHERE session_id=? AND role='user'
          AND COALESCE(active,1)=1 AND TRIM(COALESCE(content,''))<>''
        ORDER BY timestamp ASC LIMIT 1
        """,
        (sid,),
    ).fetchone()
    return (row[0] or "") if row else ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Actually perform the renames")
    args = parser.parse_args()

    if not os.path.exists(STATE_DB):
        print("state.db not found")
        return 1

    conn = sqlite3.connect(f"file:{STATE_DB}?mode=ro", uri=True, timeout=10)
    rows = conn.execute(
        """
        SELECT id, title FROM sessions
        WHERE title LIKE 'aipanel-%'
        ORDER BY COALESCE(last_activity_at, 0) DESC
        """
    ).fetchall()

    todo = []
    for sid, _title in rows:
        text = " ".join(first_user_text(conn, sid).split())
        if not text:
            continue
        todo.append((sid, text[:TITLE_LEN]))
    conn.close()

    if not todo:
        print("No sessions need renaming")
        return 0

    print(f"{len(todo)} session(s) to rename:")
    for sid, title in todo:
        print(f"  {sid}  ->  {title}")

    if not args.apply:
        print("\n(dry run; pass --apply to actually rename)")
        return 0

    ok = 0
    for sid, title in todo:
        proc = subprocess.run(
            [HERMES_BIN, "sessions", "rename", sid, title],
            capture_output=True, text=True, timeout=40,
        )
        if proc.returncode == 0:
            ok += 1
        else:
            print(f"  failed {sid}: {(proc.stderr or proc.stdout).strip()[:120]}")
    print(f"\nDone: {ok}/{len(todo)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
