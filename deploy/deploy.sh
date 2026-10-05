#!/usr/bin/env bash
# Build the web app and ship it to the server.
#
# The app runs in its own nginx container on PORT, so it does not touch the
# host nginx or any other site on the box. Needs the deploy user to be in the
# docker group, no sudo.
#
# Usage: ./deploy/deploy.sh
#        DEPLOY_HOST=user@host PORT=8085 ./deploy/deploy.sh
set -euo pipefail

HOST="${DEPLOY_HOST:-liban@156.67.25.84}"
PORT="${PORT:-8085}"
APP_DIR="apps/bottle-point"
CONTAINER="bottle-point-web"
RELEASE="$(date +%Y%m%d%H%M%S)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Building..."
cd "$ROOT/web"
[ -d node_modules ] || npm ci --no-audit --no-fund
npm run build

echo "Uploading release $RELEASE to $HOST..."
ssh "$HOST" "mkdir -p ~/$APP_DIR/releases/$RELEASE ~/$APP_DIR/conf"
tar -C dist -czf - . | ssh "$HOST" "tar -xzf - -C ~/$APP_DIR/releases/$RELEASE"
ssh "$HOST" "cat > ~/$APP_DIR/conf/default.conf" < "$ROOT/deploy/nginx.conf"

echo "Switching to the new release..."
ssh "$HOST" bash -s <<REMOTE
set -euo pipefail
cd ~/$APP_DIR
ln -sfn releases/$RELEASE current
ls -1dt releases/* | tail -n +6 | xargs -r rm -rf

if ! docker inspect $CONTAINER >/dev/null 2>&1; then
  docker run -d --name $CONTAINER --restart unless-stopped \
    -p $PORT:80 \
    -v "\$HOME/$APP_DIR:/srv:ro" \
    -v "\$HOME/$APP_DIR/conf/default.conf:/etc/nginx/conf.d/default.conf:ro" \
    nginx:alpine >/dev/null
else
  docker exec $CONTAINER nginx -s reload
fi
REMOTE

echo "Live at http://${HOST#*@}:$PORT"
