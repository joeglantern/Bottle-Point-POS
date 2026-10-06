#!/usr/bin/env bash
# Nightly backup of the Bottle Point database, run on the server by a systemd
# user timer that deploy.sh installs. Keeps the last 14 days.
#
#   ~/apps/bottle-point/backups/bottlepoint-YYYYmmdd-HHMMSS.sql.gz
#
# Restore (overwrites the live database, stop and think first):
#   cd ~/apps/bottle-point
#   gunzip -c backups/<file>.sql.gz | docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
#
# These files hold every client's data. Copy them off the server regularly
# (see docs/operations.md): a backup on the same disk does not survive the
# server being lost.
set -euo pipefail
cd ~/apps/bottle-point
mkdir -p backups
chmod 700 backups
name="backups/bottlepoint-$(date -u +%Y%m%d-%H%M%S).sql.gz"
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' </dev/null | gzip -9 > "$name.part"
# an empty or tiny dump means something went wrong: keep the old ones
if [ "$(stat -c %s "$name.part")" -lt 1000 ]; then
  echo "$(date -Is) backup looked empty, kept previous backups" >&2
  rm -f "$name.part"
  exit 1
fi
mv "$name.part" "$name"
chmod 600 "$name"
find backups -name 'bottlepoint-*.sql.gz' -mtime +14 -delete
echo "$(date -Is) wrote $name ($(du -h "$name" | cut -f1))"
