#!/usr/bin/env bash
# One time setup on a fresh Ubuntu server. Run on the server with sudo.
# scp deploy/server-setup.sh deploy/nginx.conf liban@156.67.25.84:~ && ssh liban@156.67.25.84 'sudo bash server-setup.sh'
set -euo pipefail

DEPLOY_USER="${SUDO_USER:-liban}"

apt-get update
apt-get install -y nginx ufw

mkdir -p /var/www/bottle-point/releases
chown -R "$DEPLOY_USER":"$DEPLOY_USER" /var/www/bottle-point

cp "$(dirname "$0")/nginx.conf" /etc/nginx/sites-available/bottle-point
ln -sfn /etc/nginx/sites-available/bottle-point /etc/nginx/sites-enabled/bottle-point
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo "Server ready. Run deploy/deploy.sh from your machine."
