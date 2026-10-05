# Bottle Point

Point of sale for wines and spirits shops and local pubs. One business, many branches.

A sale is saved the moment it is recorded, and only counts as paid once a cashier confirms the payment and links it to the sale.

![Bottle Point](web/public/brand/bottle-point-lockup-light.png)

Live demo: http://156.67.25.84:8085 (sign in as Wanjiru, Brian, Otieno or Achieng, PIN `1234`)

## What is here

- `web/` the till, manager and owner screens (Vite, React). Works with USB and Bluetooth barcode scanners.
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

```
./deploy/deploy.sh
```

Builds the web app, uploads it and the API source to `~/apps/bottle-point` on the server, and runs Postgres, the API and nginx as the `bottle-point` Docker Compose project on port 8085. Nothing shared on the server is touched and no sudo is needed. Secrets (`db.env`, `api.env`) are generated on the server on the first deploy and never leave it. The demo data is loaded on the first deploy; `SEED_DEMO=1 ./deploy/deploy.sh` loads it again if it is missing.

Each web release goes into its own folder and the last five are kept. To roll back the web app, point `web/current` at an older release.

When a domain is ready: add a server block on the host nginx that proxies to `127.0.0.1:8085`, get a certificate with certbot, then in `api.env` set `BETTER_AUTH_URL` and `TRUSTED_ORIGINS` to the https address and `COOKIE_SECURE=true`, and close port 8085 to the public.
