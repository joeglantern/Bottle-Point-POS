#!/usr/bin/env bash
# Build and ship Bottle Point (web + API + Postgres) to the server.
#
# Everything runs in its own Docker Compose project in ~/apps/bottle-point,
# so the host nginx and the other sites on that box are not touched, and no
# sudo is needed (the deploy user is in the docker group).
#
# Usage: ./deploy/deploy.sh
#        DEPLOY_HOST=user@host PUBLIC_URL=http://1.2.3.4:8085 ./deploy/deploy.sh
#        SEED_DEMO=1 ./deploy/deploy.sh     (load the demo business and PINs)
#        DEPLOY_REF=<commit or tag> ./deploy/deploy.sh   (default HEAD)
set -euo pipefail

HOST="${DEPLOY_HOST:-liban@156.67.25.84}"
PUBLIC_URL="${PUBLIC_URL:-http://${HOST#*@}:8085}"
APP="apps/bottle-point"
RELEASE="$(date +%Y%m%d%H%M%S)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# What gets shipped is a commit, not whatever happens to be on disk, so half
# finished work never reaches a server. DEPLOY_REF=working ships the folder
# as it is.
REF="${DEPLOY_REF:-HEAD}"
if [ "$REF" = working ]; then
  SRC="$ROOT"
  echo "Deploying the working folder as it is"
else
  SRC="$(mktemp -d)"
  trap 'rm -rf "$SRC"' EXIT
  git -C "$ROOT" archive "$REF" web server | tar -x -C "$SRC"
  echo "Deploying $(git -C "$ROOT" log -1 --format='%h %s' "$REF")"
fi

echo "Building the web app..."
cd "$SRC/web"
[ -d node_modules ] || npm ci --no-audit --no-fund
npm run build

echo "Uploading release $RELEASE to $HOST..."
ssh "$HOST" "mkdir -p ~/$APP/web/releases/$RELEASE ~/$APP/conf ~/$APP/server"
tar -C dist -czf - . | ssh "$HOST" "tar -xzf - -C ~/$APP/web/releases/$RELEASE"
tar -C "$SRC/server" --exclude=node_modules --exclude=.snapshot --exclude=dist --exclude=generated --exclude=.env --exclude=test --exclude=docs -czf - . \
  | ssh "$HOST" "rm -rf ~/$APP/server && mkdir -p ~/$APP/server && tar -xzf - -C ~/$APP/server"
ssh "$HOST" "cat > ~/$APP/docker-compose.yml" < "$ROOT/deploy/docker-compose.yml"
ssh "$HOST" "cat > ~/$APP/conf/default.conf" < "$ROOT/deploy/nginx.conf"

echo "Starting containers..."
ssh "$HOST" PUBLIC_URL="$PUBLIC_URL" RELEASE="$RELEASE" SEED_DEMO="${SEED_DEMO:-}" bash -s <<'REMOTE'
set -euo pipefail
cd ~/apps/bottle-point
umask 077

# secrets are created once on the server and never leave it
if [ ! -f db.env ]; then
  printf 'POSTGRES_USER=bottlepoint
POSTGRES_DB=bottlepoint
POSTGRES_PASSWORD=%s
' "$(head -c 24 /dev/urandom | base64 | tr -d '/+=')" > db.env
fi
DB_PASSWORD="$(grep '^POSTGRES_PASSWORD=' db.env | cut -d= -f2-)"
if [ ! -f api.env ]; then
  cat > api.env <<ENV
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://bottlepoint:$DB_PASSWORD@db:5432/bottlepoint
BETTER_AUTH_SECRET=$(head -c 32 /dev/urandom | base64)
BETTER_AUTH_URL=$PUBLIC_URL
TRUSTED_ORIGINS=$PUBLIC_URL
# plain HTTP until there is a domain with HTTPS; set true after
COOKIE_SECURE=false
MPESA_MODE=mock
MPESA_CALLBACK_URL=$PUBLIC_URL/api/mpesa/callback
MPESA_CALLBACK_TOKEN=$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')
ENV
  FIRST=1
fi
chmod 644 conf/default.conf

ln -sfn releases/$RELEASE web/current
ls -1dt web/releases/* | tail -n +6 | xargs -r rm -rf

# the first version ran as a single nginx container on the same port
if docker inspect bottle-point-web >/dev/null 2>&1; then docker rm -f bottle-point-web >/dev/null; fi
rm -rf releases current

# commands get </dev/null: this script itself arrives on stdin and docker
# would otherwise swallow the rest of it
docker compose up -d --build --remove-orphans </dev/null
for i in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q api)")" = healthy ] && break
  sleep 2
done
docker compose exec -T web nginx -s reload </dev/null >/dev/null 2>&1 || true

if [ -n "${FIRST:-}" ] || [ -n "$SEED_DEMO" ]; then
  docker compose exec -T api npx tsx prisma/seed.ts </dev/null
fi
docker compose ps --format '{{.Service}} {{.Status}}' </dev/null
REMOTE

echo "Live at $PUBLIC_URL"
