#!/usr/bin/env bash
# Writes the Caddy site file for Bottle Point on a server whose ports 80 and
# 443 belong to another app's Caddy (kiptoosvr: the CRM's), then reloads that
# Caddy. Run on the server by deploy.sh, and again after a new client is
# onboarded so its address gets a certificate:
#
#   ssh kiptoo 'bash ~/apps/bottle-point/sites.sh'
#
# With --if-changed it does nothing unless the list of client addresses has
# changed since the last run. deploy.sh installs a once a minute systemd user
# timer that runs it that way, so a client onboarded in the console gets its
# certificate within about a minute with no one touching the server.
#
# It only ever writes its own file (bottle-point.caddy). If Caddy says the
# new config is invalid the file is removed again and Caddy keeps running
# exactly as before, so a mistake here cannot take the other sites down.
set -euo pipefail

cd ~/apps/bottle-point
source ./.env
: "${DOMAIN:?DOMAIN is not set in ~/apps/bottle-point/.env}"
: "${CADDY_CONF_DIR:?CADDY_CONF_DIR is not set}"
: "${CADDY_CONTAINER:?CADDY_CONTAINER is not set}"

# every client address in the database, plus former ones (they forward to
# the new address, so they still need a certificate)
slugs="$(docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT slug FROM \"Business\" WHERE slug IS NOT NULL UNION SELECT unnest(\"formerSlugs\") FROM \"Business\" ORDER BY 1"' </dev/null | tr -d '\r' | grep -E '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' || true)"
pos_hosts="$DOMAIN"
for s in $slugs; do pos_hosts="$pos_hosts, $s.$DOMAIN"; done

state=.sites-state
if [ "${1:-}" = "--if-changed" ] && [ -f "$state" ] && [ "$(cat "$state")" = "$pos_hosts" ]; then
  exit 0
fi

target="$CADDY_CONF_DIR/bottle-point.caddy"
backup="$(mktemp)"
[ -f "$target" ] && cp "$target" "$backup" || : > "$backup"

cat > "$target" <<CADDY
# Bottle Point. Written by ~/apps/bottle-point/sites.sh, do not edit by hand:
# it is rewritten on every deploy and whenever a client is added.
# The apps listen only on the Docker bridge (host.docker.internal), never on
# a public port.

(bottle_point_headers) {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		-Server
	}
}

# The POS: the bare domain (shows "no shop here", takes M-Pesa callbacks)
# and one address per client.
$pos_hosts {
	import bottle_point_headers
	reverse_proxy host.docker.internal:${WEB_PORT}
}

# The company console.
console.$DOMAIN {
	import bottle_point_headers
	reverse_proxy host.docker.internal:${CONSOLE_PORT}
}
CADDY
chmod 644 "$target"

if docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/bp-caddy.log 2>&1; then
  docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  printf '%s' "$pos_hosts" > "$state"
  echo "$(date -Is) Caddy serves: $pos_hosts, console.$DOMAIN"
else
  echo "Caddy rejected the Bottle Point site file. Restoring the previous one; nothing else changed."
  tail -5 /tmp/bp-caddy.log
  if [ -s "$backup" ]; then cp "$backup" "$target"; else rm -f "$target"; fi
  exit 1
fi
rm -f "$backup"
