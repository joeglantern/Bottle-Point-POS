#!/usr/bin/env bash
# Runs on a second server, once a night after the live server's backup, and
# keeps 30 days of copies there. It pulls rather than the live server pushing,
# so someone who breaks into the live server cannot reach or delete these.
#
#   ~/bottle-point-offsite/bottlepoint-YYYYmmdd.sql.gz
#   ~/bottle-point-offsite/pull.log
set -euo pipefail
dir="$HOME/bottle-point-offsite"
key="$dir/pull_key"
src="${OFFSITE_SOURCE:-liban@34.72.212.250}"
cd "$dir"
name="bottlepoint-$(date -u +%Y%m%d).sql.gz"
ssh -i "$key" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20 "$src" </dev/null > "$name.part"
# a copy that is tiny or not a valid gzip file is a failed pull: keep the old ones
if [ "$(stat -c %s "$name.part")" -lt 1000 ] || ! gzip -t "$name.part" 2>/dev/null; then
  echo "$(date -Is) pull FAILED, kept previous copies" >> pull.log
  rm -f "$name.part"
  exit 1
fi
mv "$name.part" "$name"
chmod 600 "$name"
find . -maxdepth 1 -name 'bottlepoint-*.sql.gz' -mtime +30 -delete
echo "$(date -Is) copied $name ($(du -h "$name" | cut -f1))" >> pull.log
