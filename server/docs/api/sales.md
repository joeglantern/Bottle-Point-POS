# Sales API

Mounted at `/api/sales`. Every endpoint needs a session (cookie). Any role (CASHIER, MANAGER, OWNER) may call them.
Money is always integer cents. Errors have the shape `{ error: { code, message, details? } }`.

## Branch scoping

- List and create act on one branch, picked from `?branchId=`, then the `x-branch-id` header, else the user's only branch.
  A branch the user cannot access gives 403 `forbidden`. An owner (several branches) who sends no branch gets 403 `Pick a branch first.`
- Endpoints with `:id` work on the sale's own branch. A sale in a branch the user cannot access gives 404 `not_found`
  (owners can reach every branch of their business, so they can act on any sale by id).

## SaleDTO

Same shape as the `sale:updated` socket payload (`toSaleDTO` in `src/rules/sale-core.ts`):

```
{ id, number, branchId, status: 'OPEN'|'SAVED'|'PAID'|'CANCELLED'|'REFUNDED', label, customer: {id,name,phone}|null,
  createdById, createdAt, updatedAt, version,
  subtotalCents, discountCents, totalCents, paidCents, dueCents,
  paidById, paidAt, cancelledAt, refundedAt,
  lines: [{ id, productId, name, unitCents, qty, lineCents }],
  payments: [{ id, method: 'CASH'|'MPESA', amountCents, tenderedCents, changeCents, mpesaRef, phone, verification, receivedById, createdAt }],
  mpesaRequests: [{ id, phone, amountCents, status, resultDesc, receipt, createdAt }] }
```

## Endpoints

### GET /api/sales
Query: `status?` (OPEN|SAVED|PAID|CANCELLED|REFUNDED), `date?` (YYYY-MM-DD, a Nairobi day on createdAt), `q?` (label contains, case insensitive, or sale number such as `1004` or `#1004`), `limit?` (1..500, default 100).
Response 200 `{ sales: SaleDTO[] }`, newest first. The till's unpaid list is `?status=SAVED` (shared by every cashier of the branch, across shifts).
Errors: 400 `bad_request` (bad query), 403 `forbidden`.

### POST /api/sales
Body `{ lines: [{ productId, qty }], label?: string|null, customerId?: string|null }`
- `lines` 1..200 items, `qty` integer 1..999. Duplicate productIds are merged (merged qty must still be at most 999).
- `label` up to 60 characters, trimmed, empty becomes null.
- Products must be active and belong to the business. Name and price are snapshotted on the line.
Creates the sale as SAVED with the next branch number (`Branch.nextSaleNo`, taken atomically).
Response 201 `{ sale }`. Emits `sale:updated` to the branch.
Errors: 400 `bad_request`, 403 `forbidden`, 422 `unknown_product` (details `{ productIds }`), 422 `unknown_customer`.

### GET /api/sales/:id
Response 200 `{ sale }`. Errors: 404 `not_found`.

### PUT /api/sales/:id/lines
Body `{ lines: [{ productId, qty }], version }` (lines 0..200). Replaces every line. Only while SAVED or OPEN.
- `version` must equal the sale's current `version`, else 409 `stale_sale` with `details: { sale: SaleDTO }` (the current sale).
- Products already on the sale keep their snapshot price and name. New products take today's price and must be active.
- If payments exist, the new total must stay above what is already paid (equal is refused too, so the sale never ends fully covered but unpaid). Lines may be empty only when nothing is paid yet.
Response 200 `{ sale }` (version bumped). Emits `sale:updated`.
Errors: 400 `bad_request`, 404 `not_found`, 409 `stale_sale`, 422 `sale_not_editable`, 422 `below_paid`, 422 `unknown_product`.

### PATCH /api/sales/:id
Body `{ label?: string|null, customerId?: string|null }` (at least one field). Only while SAVED or OPEN. Does not bump `version`.
Response 200 `{ sale }`. Emits `sale:updated`.
Errors: 400 `bad_request`, 404 `not_found`, 422 `sale_not_editable`, 422 `unknown_customer`.

### POST /api/sales/:id/pay
"Confirm receipt of payment", including split payments. All items are applied in one transaction: all or nothing.
Body `{ payments: Item[] }`, 1..4 items, where Item is
- `{ method: 'CASH', amountCents, tenderedCents? }` (tendered defaults to amount, must be >= amount)
- `{ method: 'MPESA', amountCents, mpesaRef, phone? }` (manual fallback: code typed from the customer's SMS, 10 letters or digits, upper cased; stored as `MANUAL_UNVERIFIED`. `phone` is normalised to 2547XXXXXXXX)

CASH needs the caller to have an open shift in the sale's branch; the payment is tied to it. MPESA is tied to the caller's open shift if there is one.
Partial payment is allowed: the sale stays SAVED with `dueCents > 0`. When payments cover the total the sale becomes PAID, stock is taken off once, and the sale is locked.
Response 200 `{ sale, changeCents }`, `changeCents` = sum of (tendered minus amount) over the cash items of this request.
Emits `sale:updated`, and `stock:updated` per product when the sale became PAID.
Errors:
- 400 `bad_request` (bad body)
- 404 `not_found`
- 409 `mpesa_code_used` (code already linked to any payment, any branch)
- 422 `mpesa_code_repeated` (same code twice in this request)
- 422 `sale_not_payable` (sale is PAID, CANCELLED or REFUNDED)
- 422 `sale_empty` (no lines)
- 422 `overpayment` (items add up to more than is due)
- 422 `short_cash` (tendered less than amount)
- 422 `no_open_shift` (cash without an open shift in this branch)

### GET /api/sales/:id/receipt
Only for PAID or REFUNDED sales. Response 200:
```
{ receipt: { businessName, branchName, saleId, number, status, label, customer, createdAt, paidAt, refundedAt,
    business: { name, legalName, address, phone, email, kraPin, receiptFooter, vatRateBps },
    createdBy: { id, name }|null, paidBy: { id, name }|null,
    lines: [{ productId, name, qty, unitCents, lineCents }],
    subtotalCents, discountCents, totalCents, vatCents, paidCents,
    payments: [{ method, amountCents, tenderedCents, changeCents, mpesaRef, phone, verification, receivedBy: {id,name}|null, createdAt }],
    changeCents } }
```
- `business` is the shop's own details as the owner set them in Admin (`PATCH /api/admin/business`), read at the time the receipt is requested. `name` is a string and equals `businessName` (kept for older screens). `legalName`, `address`, `phone`, `email`, `kraPin` and `receiptFooter` are `string|null`: print a line only when it is set. `vatRateBps` is an integer in basis points (1600 = 16%, 0 = the shop is not registered for VAT).
- `vatCents` (integer cents) is the VAT already contained in `totalCents` at `business.vatRateBps`. Prices include VAT, so it is shown for information and never added to the total: `vatCents = totalCents - round(totalCents * 10000 / (10000 + vatRateBps))`, rounded half up, worked in whole numbers so it is exact to the cent. It is 0 when the rate is 0. Example: a total of 536000 at 1600 holds 73931 of VAT. The amount before VAT is `totalCents - vatCents`.
Errors: 404 `not_found`, 422 `sale_not_paid`.

## Realtime

- `sale:updated` `{ sale: SaleDTO }` to the sale's branch room after create, line edit, patch and pay.
- `stock:updated` `{ branchId, productId, qty, reorderAt }` to the branch after a sale becomes PAID.
