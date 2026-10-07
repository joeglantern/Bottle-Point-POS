#!/bin/sh
# Runs on the live server. The off-site copy's SSH key is locked to this one
# command (see docs/operations.md), so that key can read the newest backup and
# nothing else: no shell, no other files, no deleting.
f=$(ls -1t "$HOME"/apps/bottle-point/backups/bottlepoint-*.sql.gz 2>/dev/null | head -n 1)
[ -n "$f" ] || { echo "no backup yet" >&2; exit 1; }
cat "$f"
