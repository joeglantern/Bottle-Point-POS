# Bottle Point documentation

Bottle Point is a point of sale for wine and spirits shops and pubs in Kenya, run as a service by Flarehub. Each client shop gets its own address (for example `https://nyrolix.pos.flarehub.co.ke`), and the Flarehub team runs every client from the console at `https://console.pos.flarehub.co.ke`.

| Document | For | What it covers |
|---|---|---|
| [Shop guide](shop-guide.md) | Shop owners, managers, cashiers | Signing in, shifts, selling, M-Pesa, refunds, stock, reports, settings |
| [Scanners and printers](hardware.md) | Whoever sets up a till | Which barcode scanners and receipt printers work, and how to set them up on each kind of device |
| [Selling without internet](offline.md) | Everyone, and developers | What works offline, what managers check afterwards, and how syncing guarantees nothing is lost or recorded twice |
| [Console guide](console-guide.md) | The Flarehub team | Onboarding a client, plans, billing, suspensions, the team, the audit log |
| [Operations](operations.md) | Whoever runs the servers | Servers, deploying, a new client's address, backups and restore, secrets, logs, troubleshooting |
| [Architecture](architecture.md) | Developers | How the parts fit together, the data model, money and tenancy rules, realtime |
| [Security](security.md) | Developers and operators | Sign in, permissions, isolation between clients, secrets, what is logged |
| [API reference](../server/docs/api/README.md) | Developers | Every endpoint with request and response fields |

Quick facts:

- **Code:** `web/` the till (React), `console/` the company console (React), `server/` the API (Node, Hono, Prisma, PostgreSQL, Socket.IO), `deploy/` everything the servers run.
- **Production server:** kiptoosvr (34.72.212.250), behind the CRM's Caddy. See [Operations](operations.md).
- **Tests:** about 1,150 backend tests (`cd server && npm test`), a browser walkthrough of the till (`cd web && npm run e2e`), a responsive and touch check (`npm run e2e:responsive`), and the console walkthrough (`cd console && npm run e2e`).
- **Writing style for anything a user reads:** plain words, sentence case, no em dashes.
