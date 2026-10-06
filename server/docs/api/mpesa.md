# M-Pesa API

STK push (a prompt on the customer's phone) is the main way to take M-Pesa.
Typing the code from the customer's SMS is the fallback and lives in
`POST /api/sales/:id/pay` (verification `MANUAL_UNVERIFIED`); managers check
those codes here.

All `/api/mpesa/*` routes need a session, except the Safaricom callback.
Errors look like `{ error: { code, message, details? } }`. Money is integer cents.

Branch: list endpoints act on one branch, taken from `?branchId=`, the
`X-Branch-Id` header, or the user's only branch (owners must pick one).
Anything loaded by id that is not in the user's branches answers 404.

## The request object

```json
{
  "id": "ck...",
  "saleId": "ck...",
  "branchId": "ck...",
  "phone": "254712345678",
  "amountCents": 960000,
  "merchantRequestId": "29115-34620561-1",
  "checkoutRequestId": "ws_CO_191220191020363925",
  "status": "PENDING | SUCCESS | FAILED | CANCELLED | TIMEOUT",
  "resultCode": 0,
  "resultDesc": "Paid.",
  "receipt": "SJK4H7QW2P",
  "requestedById": "...",
  "shiftId": "... or null",
  "createdAt": "...",
  "updatedAt": "..."
}
```

`resultDesc` is always a sentence that can be shown to the cashier as is.
`resultCode` is null when the till or the server closed the request (cancel at
the till, timeout with no answer). Such a request still turns into `SUCCESS`
if Safaricom later confirms the money.

Statuses:

| status | meaning |
| --- | --- |
| PENDING | prompt sent, waiting for the customer |
| SUCCESS | money received. Normally a payment was added to the sale. If `resultDesc` says it "could not be added", the money arrived but the sale was cancelled, already paid, or the code was already used. A manager must handle it (audit `mpesa.unlinked_payment`). |
| FAILED | wrong PIN, not enough balance, M-Pesa unreachable, or amount mismatch (audit `mpesa.amount_mismatch`, no payment) |
| CANCELLED | the customer cancelled on the phone (resultCode 1032), or the till gave up (resultCode null) |
| TIMEOUT | the phone could not be reached (1037), or no answer after 3 minutes (resultCode null) |

## Realtime

- `mpesa:updated` `{ request }` to the sale's branch on every change.
- `sale:updated` `{ sale }` at the same time (the sale DTO includes `mpesaRequests`).
- `stock:updated` when an STK payment completes a sale.

## Endpoints

### POST /api/mpesa/stk
Cashier, manager, owner. Sends the prompt to the phone.

Body: `{ saleId: string, phone: string, amountCents?: int }`

- `phone`: `0712 345 678`, `+254712345678` and `254712345678` are all accepted and stored as `2547XXXXXXXX`.
- `amountCents`: defaults to what is still due. Must be more than 0, not more than what is due, and whole shillings (a multiple of 100).

Response `200 { request }` with status `PENDING`. Then wait for `mpesa:updated`.

Errors:
- 400 `bad_request` invalid body or phone
- 404 `not_found` sale missing or in another branch
- 422 `sale_not_payable` sale is paid, cancelled or refunded
- 422 `sale_empty` no items
- 422 `bad_amount` amount 0 or less
- 422 `overpayment` more than is due
- 422 `whole_shillings` amount has cents (also when the default due amount has cents: send an explicit amount)
- 409 `stk_pending` a prompt for this sale is still waiting. Cancel it or wait.
- 502 `mpesa_unavailable` Safaricom refused or did not answer. The request is stored as `FAILED` with the reason. Offer to retry or to type the SMS code.
- 502 `mpesa_misconfigured` the shop's own M-Pesa settings cannot be used (unreadable or missing keys). The request is stored as `FAILED`. The owner must check the settings.

### GET /api/mpesa/requests?saleId=&status=&branchId=
Any signed in user. Newest first, at most 200. Response `200 { requests: [request] }`.
Errors: 400 bad status, 403 branch not allowed or not chosen.

### GET /api/mpesa/requests/:id
Any signed in user. Response `200 { request }`. 404 if not in your branches.

### POST /api/mpesa/requests/:id/query
Cashier, manager, owner. Asks Safaricom for the result of a `PENDING` request
and applies it. If Safaricom is still waiting, or the request is no longer
pending, the request comes back unchanged. Body: none.
Response `200 { request }`. Errors: 404, 502 `mpesa_unavailable`, 502 `mpesa_misconfigured`.

### POST /api/mpesa/requests/:id/cancel
Cashier, manager, owner. The till stops waiting for a `PENDING` request
(status `CANCELLED`, resultDesc `Cancelled at the till`). This does not stop
the prompt on the phone: if the customer pays anyway, the money is still added
to the sale if it can take it, otherwise flagged as unlinked.
Response `200 { request }`. Errors: 404, 409 `not_pending`.

### POST /api/mpesa/requests/:id/simulate
Manager or owner, only where the shop's M-Pesa is a simulation: its own enabled
settings in mode MOCK, or no enabled settings and `MPESA_MODE=mock` (404
otherwise). For demos.
Body: `{ outcome: 'success' | 'failed' | 'cancelled' }`. Response `200 { request }`.
Errors: 400, 403, 404.

### GET /api/mpesa/unverified
Manager or owner. M-Pesa payments typed by hand that nobody has checked yet,
oldest first.

```json
{ "payments": [ {
  "id": "...", "saleId": "...", "saleNumber": 1042, "saleStatus": "PAID",
  "branchId": "...", "amountCents": 960000, "mpesaRef": "QWERTY1234",
  "phone": "254712345678", "receivedById": "...", "receivedByName": "Mary",
  "shiftId": "... or null", "createdAt": "..."
} ] }
```
Errors: 403.

### POST /api/mpesa/payments/:id/verify
Manager or owner. Body `{ ok: boolean, note?: string (max 300) }`.
`ok: true` sets `MANUAL_VERIFIED`, `false` sets `MANUAL_REJECTED`. Rejecting is
a flag for the records, it does not undo the sale (use a refund for that).

Response:
```json
{ "payment": { "id": "...", "saleId": "...", "method": "MPESA", "amountCents": 960000,
  "mpesaRef": "QWERTY1234", "phone": "...", "verification": "MANUAL_VERIFIED",
  "verifiedById": "...", "verifiedAt": "...", "receivedById": "...", "createdAt": "..." } }
```
Errors: 400, 403, 404 (not in your branches), 422 `not_mpesa`, 409 `already_verified`.

### POST /api/mpesa/callback/:token
Safaricom only, no session. Wrong token answers 404. With the right token the
answer is always `200 { "ResultCode": 0, "ResultDesc": "Accepted" }`, even for
bodies it cannot use, so Safaricom does not retry forever. Processing the same
callback twice is harmless.

## Mock mode (`MPESA_MODE=mock`)

No network calls. About `MPESA_MOCK_DELAY_MS` (default 2500) after the push,
the fake Safaricom answers, by the end of the phone number:

| ends in | result |
| --- | --- |
| 000 | FAILED, not enough balance |
| 111 | CANCELLED by the customer |
| 222 | never answers (stays PENDING until timeout) |
| anything else | SUCCESS with a random receipt |

## Settings per business

Each shop can use its own Paybill or Till. The owner saves them through
`GET / PUT /api/admin/mpesa`, `DELETE /api/admin/mpesa/secrets` and
`POST /api/admin/mpesa/test` (see the admin API docs). The keys are stored
encrypted (`lib/secrets.ts`) and never returned.

Which settings a request uses (`darajaFor(businessId)` in `lib/daraja.ts`):

- The business has an enabled `MpesaConfig`: its mode, shortcode, till number
  and keys are used, for the STK push and for every later status query of that
  request. Mode MOCK gives that shop the simulation whatever the server mode is.
- Otherwise the server wide settings below apply, exactly as before.

OAuth tokens are cached per business, mode and credentials, so a key or mode
change always signs in again. The callback URL and token are server wide for
every shop: answers are matched by CheckoutRequestID.

A status query uses the client that sent the request while the server still
remembers it (in memory), and the business's current settings after a restart.

If the stored keys cannot be decrypted, or an enabled live configuration lacks
a key or shortcode, `POST /api/mpesa/stk` and the query answer
`502 mpesa_misconfigured`: "M-Pesa is not set up correctly, ask the owner to
check the settings." The request is marked FAILED like any other failed push.

Test hooks: `setDaraja(client)` swaps the server wide client,
`setDarajaFetch(fetch)` sets the fetch used by per business clients.

## Server wide settings

| variable | meaning |
| --- | --- |
| MPESA_MODE | mock, sandbox or production |
| MPESA_CONSUMER_KEY / MPESA_CONSUMER_SECRET | Daraja app credentials |
| MPESA_SHORTCODE / MPESA_PASSKEY | Lipa na M-Pesa Online shortcode and passkey |
| MPESA_TRANSACTION_TYPE | CustomerPayBillOnline (paybill) or CustomerBuyGoodsOnline (till) |
| MPESA_PARTY_B | till number for Buy Goods, empty means the shortcode |
| MPESA_CALLBACK_URL / MPESA_CALLBACK_TOKEN | public callback base URL and the secret appended to it |
| MPESA_MOCK_DELAY_MS | mock answer delay, 0 or less turns the automatic answer off |
