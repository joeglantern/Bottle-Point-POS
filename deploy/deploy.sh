#!/usr/bin/env bash
# Build and ship Bottle Point to a server: Postgres, the API, the POS web app
# and the company console.
#
# Everything runs in its own Docker Compose project ("bottle-point") in
# ~/apps/bottle-point with its own network and volume. Nothing else on the
# server is touched: no sudo, no changes to other apps' files, and it refuses
# to start if another app already uses the ports it needs.
#
# With a domain (production), each client is served at <name>.<domain>, the
# console at console.<domain>, behind the server's existing Caddy:
#
#   DEPLOY_HOST=kiptoo DOMAIN=pos.flarehub.co.ke \
#   CADDY_CONF_DIR=/home/liban/flare-crm/infra/docker/caddy/conf.d CADDY_CONTAINER=crm-caddy-1 \
#   ./deploy/deploy.sh
#
# Options:
#   FRESH=yes-delete-all-data   wipe Bottle Point's own database and secrets first (clean start)
#   DEPLOY_REF=<commit or tag>  what to ship (default HEAD)
#   WEB_PORT, CONSOLE_PORT      ports on the server (default 8191 and 8192 with a domain)
set -euo pipefail

HOST="${DEPLOY_HOST:-liban@156.67.25.84}"
DOMAIN="${DOMAIN:-}"
if [ -n "$DOMAIN" ]; then
  : "${CADDY_CONF_DIR:?set CADDY_CONF_DIR to the folder the server's Caddy imports}"
  : "${CADDY_CONTAINER:?set CADDY_CONTAINER to the name of the server's Caddy container}"
  WEB_PORT="${WEB_PORT:-8191}"
  CONSOLE_PORT="${CONSOLE_PORT:-8192}"
  # reachable only from the server itself and its containers, never the internet
  BIND="${BIND:-172.17.0.1}"
  PUBLIC_URL="https://$DOMAIN"
  CONSOLE_URL="https://console.$DOMAIN"
else
  WEB_PORT="${WEB_PORT:-8085}"
  CONSOLE_PORT="${CONSOLE_PORT:-8086}"
  BIND="${BIND:-0.0.0.0}"
  PUBLIC_URL="${PUBLIC_URL:-http://${HOST#*@}:$WEB_PORT}"
  CONSOLE_URL="${CONSOLE_URL:-http://${HOST#*@}:$CONSOLE_PORT}"
fi
APP="apps/bottle-point"
RELEASE="$(date +%Y%m%d%H%M%S)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -n "${FRESH:-}" ] && [ "$FRESH" != "yes-delete-all-data" ]; then
  echo "FRESH must be exactly yes-delete-all-data"; exit 1
fi

# What gets shipped is a commit, not whatever happens to be on disk.
REF="${DEPLOY_REF:-HEAD}"
if [ "$REF" = working ]; then
  SRC="$ROOT"
  echo "Deploying the working folder as it is"
else
  SRC="$(mktemp -d)"
  trap 'rm -rf "$SRC"' EXIT
  git -C "$ROOT" archive "$REF" web console server deploy | tar -x -C "$SRC"
  echo "Deploying $(git -C "$ROOT" log -1 --format='%h %s' "$REF")"
fi

# Check the server before building anything.
ssh "$HOST" WEB_PORT="$WEB_PORT" CONSOLE_PORT="$CONSOLE_PORT" bash -s <<'CHECK'
set -euo pipefail
command -v docker >/dev/null || { echo "Docker is not installed on this server."; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose is not available on this server."; exit 1; }
mine="$(docker ps --filter label=com.docker.compose.project=bottle-point --format '{{.Ports}}' 2>/dev/null || true)"
for port in "$WEB_PORT" "$CONSOLE_PORT"; do
  if ss -tln 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$port\$"; then
    if ! printf '%s' "$mine" | grep -q ":$port->"; then
      echo "Port $port is already used by something else on this server. Nothing was changed."
      exit 1
    fi
  fi
done
CHECK

echo "Building the POS web app..."
cd "$SRC/web"
[ -d node_modules ] || npm ci --no-audit --no-fund
npm run build

echo "Building the console..."
cd "$SRC/console"
[ -d node_modules ] || npm ci --no-audit --no-fund
VITE_POS_URL="$PUBLIC_URL" VITE_TENANT_BASE_DOMAIN="$DOMAIN" npm run build

echo "Uploading release $RELEASE to $HOST..."
ssh "$HOST" "mkdir -p ~/$APP/web/releases/$RELEASE ~/$APP/console/releases/$RELEASE ~/$APP/conf ~/$APP/server"
tar -C "$SRC/web/dist" -czf - . | ssh "$HOST" "tar -xzf - -C ~/$APP/web/releases/$RELEASE"
tar -C "$SRC/console/dist" -czf - . | ssh "$HOST" "tar -xzf - -C ~/$APP/console/releases/$RELEASE"
tar -C "$SRC/server" --exclude=node_modules --exclude=.snapshot --exclude=dist --exclude=generated --exclude=.env --exclude=test --exclude=docs -czf - . \
  | ssh "$HOST" "rm -rf ~/$APP/server && mkdir -p ~/$APP/server && tar -xzf - -C ~/$APP/server"
ssh "$HOST" "cat > ~/$APP/docker-compose.yml" < "$SRC/deploy/docker-compose.yml"
ssh "$HOST" "cat > ~/$APP/conf/default.conf" < "$SRC/deploy/nginx.conf"
ssh "$HOST" "cat > ~/$APP/conf/console.conf" < "$SRC/deploy/nginx-console.conf"
ssh "$HOST" "cat > ~/$APP/sites.sh" < "$SRC/deploy/sites.sh"

echo "Starting containers..."
ssh "$HOST" PUBLIC_URL="$PUBLIC_URL" CONSOLE_URL="$CONSOLE_URL" RELEASE="$RELEASE" FRESH="${FRESH:-}" DOMAIN="$DOMAIN" \
  WEB_PORT="$WEB_PORT" CONSOLE_PORT="$CONSOLE_PORT" BIND="$BIND" \
  CADDY_CONF_DIR="${CADDY_CONF_DIR:-}" CADDY_CONTAINER="${CADDY_CONTAINER:-}" bash -s <<'REMOTE'
set -euo pipefail
cd ~/apps/bottle-point
umask 077

# Clean start: only this project's own containers, volume and secrets.
if [ "$FRESH" = "yes-delete-all-data" ]; then
  echo "Deleting all Bottle Point data on this server (FRESH)..."
  docker compose down -v --remove-orphans </dev/null || true
  rm -f db.env api.env
fi

# secrets are created once on the server and never leave it
if [ ! -f db.env ]; then
  printf 'POSTGRES_USER=bottlepoint\nPOSTGRES_DB=bottlepoint\nPOSTGRES_PASSWORD=%s\n' "$(head -c 24 /dev/urandom | base64 | tr -d '/+=')" > db.env
fi
DB_PASSWORD="$(grep '^POSTGRES_PASSWORD=' db.env | cut -d= -f2-)"
if [ ! -f api.env ]; then
  if [ -n "$DOMAIN" ]; then ORIGINS="https://*.$DOMAIN,$PUBLIC_URL"; SECURE=true; else ORIGINS="$PUBLIC_URL,$CONSOLE_URL"; SECURE=false; fi
  cat > api.env <<ENV
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://bottlepoint:$DB_PASSWORD@db:5432/bottlepoint
BETTER_AUTH_SECRET=$(head -c 32 /dev/urandom | base64)
BETTER_AUTH_URL=$PUBLIC_URL
TRUSTED_ORIGINS=$ORIGINS
TENANT_BASE_DOMAIN=$DOMAIN
COOKIE_SECURE=$SECURE
MPESA_MODE=mock
MPESA_CALLBACK_URL=$PUBLIC_URL/api/mpesa/callback
MPESA_CALLBACK_TOKEN=$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')
ENV
fi

# settings docker compose and sites.sh read
printf 'WEB_PORT=%s\nCONSOLE_PORT=%s\nBIND=%s\nDOMAIN=%s\nCADDY_CONF_DIR=%s\nCADDY_CONTAINER=%s\n' \
  "$WEB_PORT" "$CONSOLE_PORT" "$BIND" "$DOMAIN" "$CADDY_CONF_DIR" "$CADDY_CONTAINER" > .env
chmod 644 conf/default.conf conf/console.conf .env
chmod 755 sites.sh

ln -sfn releases/$RELEASE web/current
ln -sfn releases/$RELEASE console/current
ls -1dt web/releases/* | tail -n +6 | xargs -r rm -rf
ls -1dt console/releases/* | tail -n +6 | xargs -r rm -rf
rm -rf releases current

# Only this compose project is touched. Commands get </dev/null because this
# script itself arrives on stdin and docker would otherwise swallow the rest.
docker compose up -d --build --remove-orphans </dev/null
for i in $(seq 1 90); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q api)")" = healthy ] && break
  sleep 2
done
docker compose exec -T web nginx -s reload </dev/null >/dev/null 2>&1 || true
docker compose exec -T console nginx -s reload </dev/null >/dev/null 2>&1 || true

if [ -n "$DOMAIN" ]; then bash ./sites.sh </dev/null; fi
docker compose ps --format '{{.Service}} {{.Status}} {{.Ports}}' </dev/null
REMOTE

echo "POS      $PUBLIC_URL"
echo "Console  $CONSOLE_URL"
