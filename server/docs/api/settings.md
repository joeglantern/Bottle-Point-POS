# Settings API (shop owner)

Base path `/api/admin`, on the shop's own address, with a shop session. Code in `server/src/routes/settings/`. Everything is scoped to the signed in person's business. Errors are `{ "error": { "code", "message", "details" } }`; validation errors carry `details.fieldErrors`.

Who may call it: **OWNER** unless stated. MANAGER may read `GET /business`. Every role may call `GET /billing/status`.

Paths under `/api/admin/billing` stay reachable when the business is suspended or cancelled; everything else answers 402 then.

## Business details

### `GET /business` (MANAGER, OWNER)
-> `{ business: { id, name, legalName|null, email|null, phone|null, address|null, kraPin|null, receiptFooter|null, vatRateBps, trackStock } }`

### `PATCH /business`
Any of: `name` (2 to 80), `legalName` (up to 120), `email`, `phone` (free text, up to 40), `address` (up to 200), `kraPin` (letter, 9 digits, letter; upper cased), `receiptFooter` (up to 200), `vatRateBps` (0 to 5000; 1600 = 16%, 0 = not VAT registered), `trackStock` (boolean; off hides stock figures everywhere: products come back with `qty: null`, and `GET /api/session/me` returns `user.trackStock`. On, selling more than is in stock answers 422 `out_of_stock`, checked when items are added and again, under a lock, when the sale is paid), `requireMpesaCode` (boolean; off lets `POST /api/sales/:id/pay` take an `MPESA` payment without `mpesaRef`; on, that answers 422 `mpesa_code_required`). An empty string clears a text field.
-> `{ business }`. Audit `business.updated` with the changed field names.

Receipts (`GET /api/sales/:id/receipt`) include `business: { name, legalName, address, phone, email, kraPin, receiptFooter, vatRateBps }` and `vatCents`.

## M-Pesa

### `GET /mpesa`
-> `{ config: { enabled, mode: MOCK|SANDBOX|PRODUCTION, shortcode|null, partyB|null, transactionType: CustomerPayBillOnline|CustomerBuyGoodsOnline, consumerKeyHint|null, consumerSecretHint|null, passkeyHint|null, updatedAt|null, usingPlatformDefault } }`

Hints are the last four characters of a stored secret. The secrets themselves are never returned.

### `PUT /mpesa`
`{ enabled, mode, transactionType, shortcode? (5 to 7 digits), partyB? (5 to 10 digits, the till number for Buy Goods), consumerKey?, consumerSecret?, passkey? }`. Omitted, empty or null secrets keep the stored ones. Enabling SANDBOX or PRODUCTION needs a shortcode and all three secrets (stored or sent), else 422 listing what is missing. Buy Goods needs `partyB`.
-> `{ config }`. Audit `mpesa.config_updated` with which fields changed, never values.

### `DELETE /mpesa/secrets`
Wipes the stored keys and switches the settings off. -> `{ config }`

### `POST /mpesa/test`
Tries to get a Daraja token with the stored settings. -> `{ ok, message }` in plain words. MOCK always answers ok and says it is a simulation. Limited to 5 a minute per business (429).

When a shop has enabled settings, STK pushes and queries for its sales use them; otherwise the server-wide settings apply.

## Activity log

### `GET /audit?from=&to=&userId=&branchId=&group=&limit=&before=`
`from`, `to`: YYYY-MM-DD (Nairobi). `group`: `sales | payments | stock | staff | settings | signin`. `limit` 1 to 200 (default 50). `before`: the `nextBefore` of the previous page.
-> `{ entries: [{ id (string), at, action, group, summary, actor: { id|null, name }|null, branch: { id, name }|null, data }], nextBefore: string|null }`, newest first.

Only this business's entries. Flarehub team actions show as actor "Bottle Point support" with the person's identity removed. Sensitive fields are stripped from `data`.

## Devices

### `GET /sessions`
-> `{ sessions: [{ id, user: { id, name, role }, createdAt, lastSeenAt, device (for example "Chrome on Android"), ip|null, current }], total }`. Session tokens are never returned.

### `DELETE /sessions/:id`
Signs that device out. Not your own current session (422). -> `{ ok: true }`

### `POST /users/:id/sign-out`
Signs a staff member out everywhere. -> `{ signedOut }`

## Exports (CSV)

`GET /export/sales.csv`, `/export/sale-lines.csv`, `/export/payments.csv`, `/export/stock.csv`, `/export/products.csv`, each with `?from=&to=&branchId=` (dates apply to the first three; default the current Nairobi month; at most 366 days).

UTF-8 with a byte order mark (opens correctly in Excel), money in shillings with two decimals, dates and times in Nairobi. Cells that start with `= + - @`, tab or carriage return get a leading `'` so spreadsheets do not run them. If the plan's `features.exports` is `false`: 402 `plan_feature`. Audit `export.created`.

## Billing

### `GET /billing/status` (every role)
-> `{ status: TRIALING|ACTIVE|PAST_DUE|SUSPENDED|CANCELLED|NONE, suspendedReason|null, trialEndsAt|null, daysLeftInTrial|null }`. The till shows a strip or the "Selling is paused" screen from this.

### `GET /billing`
-> `{ subscription: { status, trialEndsAt, currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd, suspendedReason, discountBps }|null, plan: { name, code, priceText, limits: { maxBranches, maxStaff, maxProducts } }|null, usage: { branches, staff, products }, nextInvoice: { periodStart, periodEnd, issuedOn, lines, subtotalCents, taxCents, totalCents, salesCents|null, isEstimate, note|null }|null, outstandingCents, invoices: [last 24: { id, number, issuedAt, dueAt, periodStart, periodEnd, totalCents, paidCents, status, overdue }] }`

### `GET /billing/invoices/:id`
-> `{ invoice: { id, number, status, issuedAt, dueAt, periodStart, periodEnd, lines, subtotalCents, taxCents, totalCents, paidCents, balanceCents, overdue, paidAt, voidedAt, payments: [{ id, amountCents, method, reference, receivedAt }], client } }`. Another business's invoice answers 404.

### `GET /billing/plans`
-> `{ plans: [{ code, name, description, model, interval, priceText, trialDays, limits, features, current }] }`: active public plans, for comparing. Changing plan is done through Flarehub.

## Plan limits

Adding or reactivating a branch, a staff member or a product checks the plan's limits in the same transaction. Over the limit: 402 `plan_limit` with `details: { what, used, max }`. No subscription means no limits.
