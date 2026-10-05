#!/usr/bin/env bash
# Build the web app and ship it to the server.
# Usage: ./deploy/deploy.sh            (defaults to liban@156.67.25.84)
#        DEPLOY_HOST=user@host ./deploy/deploy.sh
set -euo pipefail

HOST="${DEPLOY_HOST:-liban@156.67.25.84}"
APP_DIR="/var/www/bottle-point"
RELEASE="$(date +%Y%m%d%H%M%S)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Building..."
cd "$ROOT/web"
npm ci
npm run build

echo "Uploading release $RELEASE to $HOST..."
tar -C dist -czf - . | ssh "$HOST" "mkdir -p $APP_DIR/releases/$RELEASE && tar -xzf - -C $APP_DIR/releases/$RELEASE"

echo "Switching current release..."
ssh "$HOST" "ln -sfn $APP_DIR/releases/$RELEASE $APP_DIR/current && ls -1dt $APP_DIR/releases/* | tail -n +6 | xargs -r rm -rf"

echo "Done. Live at http://${HOST#*@}"
