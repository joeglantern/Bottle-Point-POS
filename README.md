# Bottle Point

Point of sale for wines and spirits shops and local pubs. One business, many branches.

A sale is saved the moment it is recorded, and only counts as paid once a cashier confirms the payment and links it to the sale.

![Bottle Point](web/public/brand/bottle-point-lockup-light.png)

Production: every client has its own address, `<name>.pos.flarehub.co.ke` (for example https://nyrolix.pos.flarehub.co.ke). The company console is at https://console.pos.flarehub.co.ke.

## Documentation

Start at [docs/README.md](docs/README.md): the [shop guide](docs/shop-guide.md), [scanners and printers](docs/hardware.md), the [console guide](docs/console-guide.md), [operations](docs/operations.md), [architecture](docs/architecture.md), [security](docs/security.md) and the [API reference](server/docs/api/README.md).

## What is here

- `web/` the till, manager and owner screens (Vite, React). Works with USB and Bluetooth barcode scanners.
- `console/` the company console for running Bottle Point as a service: clients, plans, subscriptions, invoices, team (Vite, React)
- `server/` the API (Node, Hono, Better Auth, Prisma, PostgreSQL, Socket.IO)
- `deploy/` Docker Compose, nginx config and the deploy script
- `PLAN.md` architecture, data model, security and roadmap
- `server/docs/api/` endpoint references

## Run locally

Needs Node 22 and Docker.

```
cd server
cp .env.example .env          # then set BETTER_AUTH_SECRET and MPESA_CALLBACK_TOKEN
npm install
npm run db:up                 # Postgres in Docker on 127.0.0.1:5544
npm run db:deploy             # apply migrations
npm run db:seed               # demo business, every PIN is 1234
npm run dev                   # API on http://localhost:3000

cd ../web
npm install
npm run dev                   # http://localhost:5173, /api is proxied to the API
```

## Tests

```
cd server
npm test                      # unit and integration tests against a throwaway database
npm run smoke                 # end to end over HTTP and WebSockets, needs the API running and seeded

cd web
npm run e2e                   # drives the real app in Chrome as each role
```

## M-Pesa

`MPESA_MODE=mock` (the default) simulates Safaricom so the whole flow can be shown without keys. A phone ending in 000 fails, 111 cancels, 222 never answers, anything else pays.

For the sandbox or production, set `MPESA_MODE`, `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY` and a public HTTPS `MPESA_CALLBACK_URL`. Typing the code from the customer's SMS stays available as a fallback, and a manager checks those codes.

## Deploy

Production runs on kiptoosvr behind the CRM's Caddy, which already owns ports 80 and 443. Bottle Point adds only its own site file (`bottle-point.caddy`) to that Caddy's `conf.d` folder, and its containers listen only on the Docker bridge, never on a public port.

```
DEPLOY_HOST=kiptoo DOMAIN=pos.flarehub.co.ke CADDY_CONF_DIR=/home/liban/flare-crm/infra/docker/caddy/conf.d CADDY_CONTAINER=crm-caddy-1 ./deploy/deploy.sh
```

DNS: `pos` and `*.pos` A records on flarehub.co.ke point at the server, so any client address works without new DNS records. Each address gets its HTTPS certificate when it is added to the Caddy site file, which happens on every deploy and by running this after onboarding a new client:

```
ssh kiptoo 'bash ~/apps/bottle-point/sites.sh'
```

`FRESH=yes-delete-all-data` wipes Bottle Point's own database and secrets first. It never touches anything else on the server.

The demo data generator (`npm run db:seed` in `server/`) is for local development only. Deploys never run it.
