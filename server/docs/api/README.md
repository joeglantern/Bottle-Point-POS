# API reference

One API serves the till and the console. Every response is JSON. Errors look like:

```json
{ "error": { "code": "overpayment", "message": "Only 4800 is still due on this sale.", "details": null } }
```

| Status | Meaning |
|---|---|
| 400 | The request is malformed or fails validation (`details.fieldErrors` names the fields) |
| 401 | Not signed in, or the session does not belong to this address |
| 402 | The subscription is suspended or cancelled (`subscription_*`), or the plan does not allow it (`plan_limit`, `plan_feature`) |
| 403 | Signed in, but your role or branch does not allow it |
| 404 | Not found, including anything that belongs to another business |
| 409 | A conflict: a duplicate, a stale edit, an M-Pesa code already used, a pending request |
| 422 | Valid request, but not allowed in the current state (each comes with its own `code`) |
| 423 | Locked after too many wrong PINs or passwords |
| 429 | Too many attempts |

Conventions: money is integer cents (`*Cents`), percentages are basis points (`*Bps`), dates are ISO strings, a "day" is a day in Nairobi. Lists take `limit` and an `offset` or a `before` cursor.

## Shop API (on a shop's address)

| Area | Path | Reference |
|---|---|---|
| Sign in | `/api/session` | Below |
| Sales, payments, receipts | `/api/sales` | [sales.md](sales.md) |
| M-Pesa STK push and typed code checks | `/api/mpesa` | [mpesa.md](mpesa.md) |
| Shifts, approvals, reports, products, stock, customers, staff and branches | `/api/shifts`, `/api/approvals`, `/api/reports`, `/api/products`, `/api/stock`, `/api/customers`, `/api/admin` | The route files in `server/src/routes/` (each validates with a Zod schema at the top) |
| Owner settings and billing | `/api/admin/...` | [settings.md](settings.md) |
| Offline tills: registering, syncing, issues | `/api/offline` | [../../../docs/offline.md](../../../docs/offline.md#api) |
| Live updates | `/socket.io` | [../../../docs/architecture.md](../../../docs/architecture.md#live-updates) |

### Sign in

- `GET /api/session/tenant` (public) -> `{ tenant: { name, slug }, tenantMode }` for this address, or 404 `no_shop`.
- `POST /api/session/pin` `{ username, pin }` -> `{ ok }` and the session cookie. 401 wrong username or PIN (also staff of another shop), 403 switched off, 404 no shop at this address, 423 locked.
- `GET /api/session/me` -> `{ user: { id, name, username, role, businessId, branchIds, subscriptionStatus }, branches: [{ id, name }] }`
- `POST /api/session/logout` -> `{ ok }`

## Console API (on the console's address)

`/api/console`: [console.md](console.md).

## Health

`GET /api/health` -> `{ ok: true }` when the API can reach the database.
