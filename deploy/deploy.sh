#!/usr/bin/env bash
# Build and ship Bottle Point to a server: Postgres, the API, the POS web app
# and the company console (a separate app on its own port and host name).
#
# Everything runs in its own Docker Compose project ("bottle-point") in
# ~/apps/bottle-point with its own network and volume. Nothing else on the
# server is touched: no sudo, no changes to the host's web server, and it
# refuses to start if another app already uses the ports it needs.
#
# Usage: ./deploy/deploy.sh
#        DEPLOY_HOST=user@host PUBLIC_URL=http://1.2.3.4:8085 CONSOLE_URL=http://1.2.3.4:8086 ./deploy/deploy.sh
#        WEB_PORT=8085 CONSOLE_PORT=8086 BIND=127.0.0.1 ./deploy/deploy.sh   (behind a reverse proxy)
#        SEED_DEMO=1 ./deploy/deploy.sh                  (load the demo data)
#        DEPLOY_REF=<commit or tag> ./deploy/deploy.sh   (default HEAD)
set -euo pipefail

HOST="${DEPLOY_HOST:-liban@156.67.25.84}"
WEB_PORT="${WEB_PORT:-8085}"
CONSOLE_PORT="${CONSOLE_PORT:-8086}"
BIND="${BIND:-0.0.0.0}"
PUBLIC_URL="${PUBLIC_URL:-http://${HOST#*@}:$WEB_PORT}"
CONSOLE_URL="${CONSOLE_URL:-http://${HOST#*@}:$CONSOLE_PORT}"
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
  git -C "$ROOT" archive "$REF" web console server | tar -x -C "$SRC"
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
      echo "Choose other ports with WEB_PORT and CONSOLE_PORT."
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
VITE_POS_URL="$PUBLIC_URL" npm run build

echo "Uploading release $RELEASE to $HOST..."
ssh "$HOST" "mkdir -p ~/$APP/web/releases/$RELEASE ~/$APP/console/releases/$RELEASE ~/$APP/conf ~/$APP/server"
tar -C "$SRC/web/dist" -czf - . | ssh "$HOST" "tar -xzf - -C ~/$APP/web/releases/$RELEASE"
tar -C "$SRC/console/dist" -czf - . | ssh "$HOST" "tar -xzf - -C ~/$APP/console/releases/$RELEASE"
tar -C "$SRC/server" --exclude=node_modules --exclude=.snapshot --exclude=dist --exclude=generated --exclude=.env --exclude=test --exclude=docs -czf - . \
  | ssh "$HOST" "rm -rf ~/$APP/server && mkdir -p ~/$APP/server && tar -xzf - -C ~/$APP/server"
ssh "$HOST" "cat > ~/$APP/docker-compose.yml" < "$ROOT/deploy/docker-compose.yml"
ssh "$HOST" "cat > ~/$APP/conf/default.conf" < "$ROOT/deploy/nginx.conf"
ssh "$HOST" "cat > ~/$APP/conf/console.conf" < "$ROOT/deploy/nginx-console.conf"

echo "Starting containers..."
ssh "$HOST" PUBLIC_URL="$PUBLIC_URL" CONSOLE_URL="$CONSOLE_URL" RELEASE="$RELEASE" SEED_DEMO="${SEED_DEMO:-}" \
  WEB_PORT="$WEB_PORT" CONSOLE_PORT="$CONSOLE_PORT" BIND="$BIND" bash -s <<'REMOTE'
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
TRUSTED_ORIGINS=$PUBLIC_URL,$CONSOLE_URL
# plain HTTP until there is a domain with HTTPS; set true after
COOKIE_SECURE=false
MPESA_MODE=mock
MPESA_CALLBACK_URL=$PUBLIC_URL/api/mpesa/callback
MPESA_CALLBACK_TOKEN=$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')
ENV
  FIRST=1
fi

# the API only answers browsers coming from addresses it trusts: make sure
# both apps are on the list (existing entries are kept)
origins="$(grep '^TRUSTED_ORIGINS=' api.env | cut -d= -f2-)"
for url in "$PUBLIC_URL" "$CONSOLE_URL"; do
  case ",$origins," in *",$url,"*) ;; *) origins="${origins:+$origins,}$url" ;; esac
done
sed -i "s|^TRUSTED_ORIGINS=.*|TRUSTED_ORIGINS=$origins|" api.env

# ports for docker compose
printf 'WEB_PORT=%s\nCONSOLE_PORT=%s\nBIND=%s\n' "$WEB_PORT" "$CONSOLE_PORT" "$BIND" > .env
chmod 644 conf/default.conf conf/console.conf .env

ln -sfn releases/$RELEASE web/current
ln -sfn releases/$RELEASE console/current
ls -1dt web/releases/* | tail -n +6 | xargs -r rm -rf
ls -1dt console/releases/* | tail -n +6 | xargs -r rm -rf

# the very first version ran as a single nginx container with this name
if docker inspect bottle-point-web >/dev/null 2>&1; then docker rm -f bottle-point-web >/dev/null; fi
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

if [ -n "${FIRST:-}" ] || [ -n "$SEED_DEMO" ]; then
  docker compose exec -T api npx tsx prisma/seed.ts </dev/null
fi
docker compose ps --format '{{.Service}} {{.Status}}' </dev/null
REMOTE

echo "POS      $PUBLIC_URL"
echo "Console  $CONSOLE_URL"
