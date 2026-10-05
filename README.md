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

First time, on the server:

```
scp deploy/server-setup.sh deploy/nginx.conf liban@156.67.25.84:~
ssh liban@156.67.25.84 'sudo bash server-setup.sh'
```

Every release after that, from your machine:

```
./deploy/deploy.sh
```

Each release goes into its own folder under `/var/www/bottle-point/releases` and `current` is switched over in one step, so rolling back is just pointing `current` at the previous folder. The last five releases are kept.
