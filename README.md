# Bottle Point

Point of sale for wines and spirits shops and local pubs. One business, many branches.

A sale is saved the moment it is recorded, and only counts as paid once a cashier confirms the payment and links it to the sale.

![Bottle Point](web/public/brand/bottle-point-lockup-light.png)

## What is here

- `web/` the till, manager portal and owner view (Vite, React). Works with USB and Bluetooth barcode scanners out of the box
- `deploy/` nginx config and scripts for the server
- `docs/` brand files
- `PLAN.md` architecture, data model, security and roadmap

The backend (Node, Better Auth, Prisma, PostgreSQL) is next. See `PLAN.md`.

## Run locally

```
cd web
npm install
npm run dev
```

Open http://localhost:5173 and sign in as any user with PIN `1234`.

## Deploy

Live at http://156.67.25.84:8085 until a domain is set up.

```
./deploy/deploy.sh
```

That builds the app, uploads it to `~/apps/bottle-point/releases/<timestamp>` on the server and points `current` at it. It runs in its own `nginx:alpine` container (`bottle-point-web`) on port 8085, so the host nginx and the other sites on that server are not touched, and no sudo is needed. The last five releases are kept. To roll back, point `current` at an older release:

```
ssh liban@156.67.25.84 'cd ~/apps/bottle-point && ln -sfn releases/<older> current'
```

When a domain is ready, add a server block on the host nginx that proxies to `127.0.0.1:8085`, run certbot for it, then close 8085 to the public.
