# Operations

How Bottle Point runs in production, and what to do when something needs attention.

## Where it runs

| | |
|---|---|
| Server | kiptoosvr, 34.72.212.250, Ubuntu 26.04, user `liban` (SSH key `~/.ssh/kiptoosvr_key`, shortcut `ssh kiptoo`) |
| Folder | `~/apps/bottle-point` |
| Docker project | `bottle-point`: containers `db`, `api`, `web`, `console`, volume `bottle-point_pgdata` |
| Web traffic | The CRM's Caddy (`crm-caddy-1`) owns ports 80 and 443. Bottle Point adds only its own site file, `~/flare-crm/infra/docker/caddy/conf.d/bottle-point.caddy`. |
| Internal ports | `172.17.0.1:8191` till, `172.17.0.1:8192` console. Not reachable from the internet. |
| DNS | `pos.flarehub.co.ke` and `*.pos.flarehub.co.ke` A records point at 34.72.212.250 |
| Addresses | `https://<client>.pos.flarehub.co.ke` for each client, `https://console.pos.flarehub.co.ke` for the team, `https://pos.flarehub.co.ke` shows "No shop here" and receives M-Pesa callbacks |

Nothing Bottle Point does touches the CRM or the other apps on the server. The only changes outside `~/apps/bottle-point` are its own Caddy site file, two systemd user timers, and "linger" for the `liban` user (so those timers run when nobody is logged in; undo with `sudo loginctl disable-linger liban`).

## Files on the server

```
~/apps/bottle-point/
  docker-compose.yml     the four containers
  .env                   ports and the domain, read by compose and the scripts
  db.env                 database password            (secret, chmod 600)
  api.env                API settings and secrets      (secret, chmod 600)
  conf/default.conf      nginx for the till
  conf/console.conf      nginx for the console
  web/releases/<time>/   till builds, web/current points at the live one (last 5 kept)
  console/releases/      console builds, same pattern
  server/                API source; the api image is built from it
  sites.sh               writes the Caddy site file
  backup.sh              nightly database backup
  backups/               the backups (chmod 700)
  sites.log              what sites.sh changed
```

`db.env` and `api.env` are created on the first deploy and never leave the server. Changing `BETTER_AUTH_SECRET` signs everyone out and makes every stored M-Pesa key unreadable, so do not change it casually.

## Deploying

From the project folder on your computer, with everything committed (the script ships the commit, not unsaved files):

```
DEPLOY_HOST=kiptoo DOMAIN=pos.flarehub.co.ke \
CADDY_CONF_DIR=/home/liban/flare-crm/infra/docker/caddy/conf.d CADDY_CONTAINER=crm-caddy-1 \
./deploy/deploy.sh
```

It builds the till and the console, uploads them with the API source, rebuilds the API image on the server, applies database migrations, restarts the containers, rewrites the Caddy site file, and installs the timers. The script refuses to start if another app already uses its ports.

Options: `DEPLOY_REF=<commit>` ships an older commit. `FRESH=yes-delete-all-data` wipes Bottle Point's database and secrets first. That deletes every client's data, so only use it on a new server.

### Rolling back

- **The till or console screens:** point `current` at an older release and nothing else changes:
  `ssh kiptoo 'cd ~/apps/bottle-point && ls web/releases && ln -sfn releases/<older> web/current'`
- **The API:** deploy the previous commit with `DEPLOY_REF=<commit>`. Database migrations only ever add, so an older API runs against a newer database.

## A new client

1. Onboard them in the console (Clients, New client). That creates the business, its first branch, the owner and the address.
2. Within about a minute the `bottle-point-sites` timer sees the new address, adds it to the Caddy site file and reloads Caddy, which fetches the HTTPS certificate. No DNS change is needed because of the wildcard record.
3. Send the owner their address, username and the PIN the console showed once.

To force it straight away: `ssh kiptoo 'bash ~/apps/bottle-point/sites.sh'`. If Caddy rejects the file, the script restores the previous one and Caddy keeps serving everything as before.

## Console users

The first super admin exists already. To add one from the server (prints a generated password once):

```
ssh kiptoo 'cd ~/apps/bottle-point && docker compose exec -T api npx tsx scripts/create-platform-admin.ts someone@flarehub.co.ke "Full Name" SUPPORT'
```

Normally do it in the console instead (Team, Add someone). To reset a forgotten super admin password, add `--reset-password` to the command above.

## Backups

The `bottle-point-backup` timer runs `backup.sh` every night at 02:30 server time (UTC). It writes a compressed dump of the whole database to `~/apps/bottle-point/backups/` and keeps the last 14 days.

**Off-site copies.** Every night at 05:15 server time (03:15 UTC), the second server (156.67.25.84, a different provider) pulls the newest backup into `~/bottle-point-offsite/` and keeps 30 days. Its log is `~/bottle-point-offsite/pull.log`. The pull runs from that server's crontab with `deploy/offsite-pull.sh`.

The pulling key is locked on the live server to one command, `serve-backup.sh`, which only prints the newest backup. It cannot open a shell, read other files or delete anything. Because the second server pulls, someone who breaks into the live server cannot reach or delete the off-site copies. The key's line in `~/.ssh/authorized_keys` on kiptoo ends with `bottle-point-offsite`. Remove that line to revoke it.

Check the copies:

```
ssh liban@156.67.25.84 'tail -3 ~/bottle-point-offsite/pull.log; ls -lh ~/bottle-point-offsite'
```

Restore drill, done on 7 October 2026: the off-site copy was loaded into a throwaway Postgres container on the second server and the client data came back intact. To get a copy onto your own computer as well:

```
scp 'kiptoo:apps/bottle-point/backups/*' ./bottle-point-backups/
```

Run a backup now: `ssh kiptoo 'bash ~/apps/bottle-point/backup.sh'`

Restore. This overwrites the live database, so take a fresh backup first:

```
ssh kiptoo
cd ~/apps/bottle-point
bash backup.sh
gunzip -c backups/<the one to restore>.sql.gz | docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
docker compose restart api
```

Test a restore every few months on a copy, not on production.

## Logs and health

```
ssh kiptoo
cd ~/apps/bottle-point
docker compose ps                         # all four should be Up, api (healthy)
docker compose logs api --tail 100        # API errors, billing runs, M-Pesa
docker compose logs web --tail 50         # till requests
tail sites.log                            # client addresses added
systemctl --user list-timers              # sites (every minute) and backup (nightly)
curl -s https://pos.flarehub.co.ke/api/health
```

## M-Pesa in production

Production starts in simulation (`MPESA_MODE=mock` in `api.env`). A simulated prompt would mark a sale paid with no money received, so in production the till hides **M-Pesa prompt** and the API refuses it (`mpesa_not_set_up`) for any shop still on the simulation. Cash and typed M-Pesa codes always work. `MPESA_SIMULATION=allow` in `api.env` turns simulated prompts back on, for a training server only. Each shop turns on real M-Pesa in its own Settings, M-Pesa, with its Daraja keys; nothing on the server changes. The callback address Safaricom uses is `https://pos.flarehub.co.ke/api/mpesa/callback/<token>`. The token is in `api.env` (`MPESA_CALLBACK_TOKEN`) and must stay secret.

To switch the server-wide fallback from simulation to a real account, set `MPESA_MODE`, `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE` and `MPESA_PASSKEY` in `api.env`, then `docker compose up -d api`.

## Troubleshooting

| Symptom | Check |
|---|---|
| A client address shows a certificate error | Is the client in the console with that exact address? `tail sites.log`, then run `sites.sh` by hand and read its message. |
| A client's address was changed | The old address keeps a certificate and forwards to the new one (former addresses are listed with the current ones in `bottle-point.caddy`). |
| "No shop here" on a client address | The address in the console does not match the link. The address is the client's web name, lowercase. |
| Staff say "Wrong username or PIN" but the details are right | They may be on another client's address, or locked after 5 wrong PINs (5 minutes; the owner or the console can reset the PIN). |
| Everything shows "Selling is paused" | The client is suspended or cancelled. See the client in the console. |
| Live updates stop (unpaid list, M-Pesa status) | The green dot at the top of the till turns red when the socket drops. Check `docker compose logs api`. Caddy and nginx both pass WebSockets through. |
| The server ran out of disk | `docker system df`, old backups in `backups/`, old releases are pruned automatically. |
| The CRM is affected | Bottle Point only owns `bottle-point.caddy`. Remove it and reload Caddy: `rm ~/flare-crm/infra/docker/caddy/conf.d/bottle-point.caddy && docker exec crm-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile` |
