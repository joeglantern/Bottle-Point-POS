# Console API

Generated from `console/src/api.js` by `console/scripts/api-docs.py`. Edit the notes there, then run the script.

Base path `/api/console`, reachable only on the console address. JSON in and out. Every endpoint except `/session/login` needs a console session (cookie).
Errors are `{ "error": { "code", "message", "details" } }`.

Money is integer cents (`*Cents`), percentages are basis points (`*Bps`, 150 = 1.5%), dates are ISO strings. Reads are open to every console role; who may write is given per section.

## Shared shapes

```
Every call the console makes to /api/console lives here. Pages never call fetch.
Bodies are returned exactly as the server sends them. Dates are ISO strings,
money is integer cents, percentages are basis points (150 = 1.5%).

Shared shapes used in the comments below:
  SubStatus  'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED'   (tenant status adds 'NONE')
  InvStatus  'OPEN' | 'PAID' | 'VOID'   (the OVERDUE filter means OPEN and past dueAt; rows carry overdue: boolean)
  Line       { description, quantity, unitCents, amountCents }
  Actor      { id: string|null, name, kind: 'platform' | 'shop' | 'system' }
  TenantSub  { id, status, plan: { id, code, name, model, interval, active, priceText }, trialEndsAt|null,
               currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd, cancelledAt|null, discountBps,
               customPriceCents|null, suspendedReason|null, suspendedAt|null }
  Sub        { id, businessId, businessName, plan: { id, code, name, model, interval }, status, currentPeriodStart,
               currentPeriodEnd, trialEndsAt|null, cancelAtPeriodEnd, cancelledAt|null, discountBps,
               customPriceCents|null, suspendedReason|null, suspendedAt|null, createdAt,
               nextAmountCents|null, nextInvoiceAt|null }
  InvoiceRef { id, number, totalCents, status, dueAt } | null
  InvoiceRow { id, number, business: { id, name }, subscriptionId|null, status, overdue, periodStart, periodEnd,
               subtotalCents, taxCents, totalCents, paidCents, balanceCents, issuedAt, dueAt, paidAt|null, voidedAt|null }
  Payment    { id, amountCents, method: 'MPESA'|'BANK'|'CARD'|'CASH'|'OTHER', reference|null, receivedAt, createdAt,
               recordedBy: { id, name } | null }
  Invoice    InvoiceRow plus { lines: Line[], notes|null, payments: Payment[],
               client: { id, name, legalName|null, address|null, kraPin|null, email|null, phone|null } }
  Plan       { id, code, name, description|null, model: 'FLAT'|'PER_BRANCH'|'PERCENT_OF_SALES'|'ONE_TIME',
               interval: 'MONTH'|'YEAR'|'ONCE', priceCents, perBranchCents, percentBps, minimumCents, trialDays,
               maxBranches|null, maxStaff|null, maxProducts|null, features: {}, active, public, sortOrder,
               createdAt, updatedAt, priceText, clients }
  Member     { id, name, email, role: 'SUPER_ADMIN'|'SUPPORT'|'BILLING', active, locked, lastSignInAt|null, createdAt }

Errors: every failure throws ApiError. 400 bad_request (validation, see fields), 401 unauthorized,
403 forbidden, 404 not_found, 409 conflict codes (duplicate_username, duplicate_code, duplicate_email),
422 with a specific code (listed per call).
```

## Session

### `POST /session/login`

{ email, password } -> { ok: true }. 401 "Wrong email or password."

### `POST /session/logout`

-> { ok: true }

### `GET /session/me`

-> { user: { id, name, email, role: 'SUPER_ADMIN'|'SUPPORT'|'BILLING' } }

### `POST /session/password`

{ currentPassword, newPassword (10+ chars) } -> { ok: true }. 400 when the current one is wrong.


## Overview and search (any role)

### `GET /overview`

-> { overview: { generatedAt, mrrCents, arrCents, counts: { TRIALING, ACTIVE, PAST_DUE, SUSPENDED, CANCELLED, NONE, total }, trialsEndingSoon: [{ businessId, name, plan: { id, name }, trialEndsAt|null, daysLeft }], (next 7 days) outstandingCents, outstandingCount, overdueCents, overdueCount, collectedThisMonthCents, newClientsThisMonth, churnedThisMonth, revenueByMonth: [{ month: 'YYYY-MM', invoicedCents, collectedCents }], (12 rows, oldest first) salesByMonth: [{ month: 'YYYY-MM', salesCents, salesCount }], (12 rows, oldest first) planMix: [{ planId, code, name, clients, mrrCents }], attention: [{ kind: 'past_due'|'suspended'|'trial_ending', businessId, name, status: SubStatus, reason, at|null, amountCents|null }], recentActivity: [{ id, at, action, summary, actor: Actor, business: { id, name }|null }] } }

### `GET /search?q=`

-> { tenants: [{ id, name, status, plan: { id, name }|null, owners: [{ name, username }] }], invoices: [{ id, number, businessName, status: InvStatus, overdue, totalCents, paidCents, balanceCents, issuedAt, dueAt }] } At most 8 of each. An empty q answers with empty lists.


## Clients (called tenants by the API). Reads: any role. Writes: SUPPORT or SUPER_ADMIN

### `GET /tenants?q&status&planId&sort&dir&limit&offset`

status: SubStatus | 'NONE'; sort: 'name' (default) | 'joined' | 'mrr' | 'sales'; dir: 'asc' | 'desc' (default asc for name, desc otherwise); limit 1 to 200 (default 50); offset. -> { tenants: [{ id, name, slug|null, url|null, status, plan: { id, name }|null, branches, staff, sales30dCents, mrrCents, createdAt, trialEndsAt|null }], total, (rows matching q, planId and status) counts: { ALL, TRIALING?, ACTIVE?, PAST_DUE?, SUSPENDED?, CANCELLED?, NONE? } } (per status, ignoring the status filter; absent means 0)

### `POST /tenants`

{ businessName, slug (the web address: 3 to 40 lowercase letters, digits or dashes, not reserved), branchName, ownerName, ownerUsername, ownerPin?, planId? (omit to start without billing), trialDays? (0 to 90), email?, phone? } -> 201 { tenant: { id, name, slug, url (https://<slug>.<domain>), email|null, phone|null, createdAt }, branch: { id, name }, owner: { id, name, username }, subscription: TenantSub|null (null without a plan), invoice: { id, number, totalCents, status }|null, ownerPin: string|null } (the generated PIN, shown once; null when one was supplied) 409 duplicate_username, duplicate_slug.

### `GET /tenants/:id`

-> { tenant: { id, name, slug|null, url|null, legalName|null, email|null, phone|null, address|null, kraPin|null, createdAt, status, subscription: TenantSub|null, usage: { branches, staff, products }, limits: { maxBranches|null, maxStaff|null, maxProducts|null }|null, sales30dCents, mrrCents, lastSaleAt|null, lastSignInAt|null, owners: [{ id, name, username }], nextInvoice: { periodStart, periodEnd, issueAt, lines: Line[], subtotalCents, taxCents, totalCents }|null, openInvoiceCents, openInvoiceCount, overdueInvoiceCount } }

### `PATCH /tenants/:id`

{ name?, slug? (super admin only, moves the client's address), legalName?, email?, phone?, address?, kraPin? } ('' or null clears) -> { tenant: { id, name, slug, url, legalName, email, phone, address, kraPin } }. 409 duplicate_slug.

### `POST /tenants/:id/suspend`

{ reason (3 to 300 chars) } -> { subscription: TenantSub }. 422 no_subscription or already suspended or cancelled.

### `POST /tenants/:id/reactivate`

-> { subscription: TenantSub }. 422 unless suspended.

### `GET /tenants/:id/people`

-> { people: [{ id, name, username, role: 'OWNER'|'MANAGER'|'CASHIER', active, locked, branches: [{ id, name }], lastSignInAt|null, createdAt }] }

### `POST /tenants/:id/people/:userId/reset-pin`

-> { user: { id, name, username }, ownerPin, sessionsEnded }. Owners only: 422 not_owner.

### `POST /tenants/:id/sign-out-all`

-> { sessionsEnded }

### `GET /tenants/:id/notes`

-> { notes: [{ id, body, createdAt, author: { id, name } }] } newest first

### `POST /tenants/:id/notes`

{ body (1 to 2000 chars) } -> 201 { note: { id, body, createdAt, author: { id, name } } }

### `DELETE /tenants/:id/notes/:noteId`

-> { ok: true }. 403 unless you wrote it or are a super admin.

### `GET /tenants/:id/activity?limit&before`

-> { activity: [{ id, at, action, entity, entityId|null, actor: Actor }], nextBefore: string|null } (pass nextBefore back as before for the next page)


## Plans. Reads: any role. Writes: BILLING or SUPER_ADMIN

### `GET /plans?includeArchived=true`

-> { plans: Plan[] } ordered by sortOrder then name. Archived plans have active: false.

### `GET /plans/:id`

-> { plan: Plan }

### `POST /plans`

{ code (lowercase, digits, dashes; 2 to 40), name, model, description?, interval?, priceCents?, perBranchCents?, percentBps?, minimumCents?, trialDays? (default 14), maxBranches?, maxStaff?, maxProducts?, features?, public?, sortOrder? } -> 201 { plan: Plan }. 409 duplicate_code. Per model rules come back as field errors: FLAT: MONTH or YEAR. PER_BRANCH: perBranchCents above 0, MONTH or YEAR. PERCENT_OF_SALES: percentBps 1 to 5000, MONTH only. ONE_TIME: interval ONCE.

### `PATCH /plans/:id`

{ any Plan field except code } -> { plan: Plan }

### `POST /plans/:id/archive`

-> { plan: Plan }

### `POST /plans/:id/unarchive`

-> { plan: Plan }


## Subscriptions. Reads: any role. Writes: BILLING or SUPER_ADMIN (extend trial: SUPPORT too)

### `GET /subscriptions?status&planId&q&limit&offset`

-> { subscriptions: Sub[], total } ordered by client name

### `POST /tenants/:id/subscription/plan`

{ planId, force? } -> { subscription: Sub, invoice: InvoiceRef } 422 same_plan, subscription_cancelled, or over_plan_limits with details { over: [{ what: 'branches'|'staff'|'products', used, max }], usage, limits }; send force: true to go ahead anyway.

### `POST /tenants/:id/subscription/terms`

{ discountBps?, customPriceCents? (null clears) } -> { subscription: Sub }

### `POST /tenants/:id/subscription/extend-trial`

{ days (1 to 90) } -> { subscription: Sub }. 422 not_trialing.

### `POST /tenants/:id/subscription/cancel`

{ atPeriodEnd: boolean, reason? } -> { subscription: Sub }. 422 already_cancelled, invalid_state.

### `POST /tenants/:id/subscription/resume`

-> { subscription: Sub, invoice: InvoiceRef }. 422 not_cancelled.


## Invoices and payments. Reads: any role. Writes: BILLING or SUPER_ADMIN

### `GET /invoices?status&businessId&q&from&to&limit&offset`

status: 'OPEN'|'PAID'|'VOID'|'OVERDUE'; q matches number or client name; from and to are YYYY-MM-DD on issuedAt (to is inclusive). -> { invoices: InvoiceRow[], total, totals: { billedCents, collectedCents, outstandingCents } } newest first

- `invoicesCsvUrl`: URL of GET /invoices/export.csv with the same filters (no paging). Use as a plain link so the browser downloads it.
### `GET /invoices/:id`

-> { invoice: Invoice }

### `POST /tenants/:id/invoices`

{ lines: [{ description, quantity (1 to 1000), unitCents }], dueInDays? (0 to 90, default 7), notes? } -> 201 { invoice: Invoice } (VAT is added by the server)

### `POST /invoices/:id/payments`

{ amountCents (above 0), method: 'MPESA'|'BANK'|'CARD'|'CASH'|'OTHER', reference?, receivedAt? (ISO, not in the future) } -> 201 { invoice: Invoice, payment: Payment|null, subscriptionStatus: SubStatus|null } 422 invoice_void, invoice_paid, invoice_not_open, overpayment.

### `POST /invoices/:id/void`

{ reason (1 to 500 chars) } -> { invoice: Invoice, subscriptionStatus: SubStatus|null }. 422 invoice_not_open, invoice_has_payments.


## Billing run. Preview: any role. Run: BILLING or SUPER_ADMIN

### `POST /billing/run`

-> { summary: { invoicesCreated, trialsConverted, markedPastDue, suspended, cancelled, errors: [{ businessId, message }] } }

### `GET /billing/preview`

-> { preview: { at, totals: { invoices, invoiceTotalCents, trialsConverted, markedPastDue, suspended, cancelled }, items: [{ businessId, businessName, plan: { id, name }, status, actions: [ { type: 'convert_trial'|'advance_period', periodStart, periodEnd } | { type: 'invoice', periodStart, periodEnd, subtotalCents, taxCents, totalCents } | { type: 'cancel' } | { type: 'past_due'|'suspend', invoiceId, invoiceNumber, dueAt } ] }] } }


## Team. Read: any role. Writes: SUPER_ADMIN only

### `GET /team`

-> { team: Member[] }

### `POST /team`

{ name, email, role } -> 201 { member: Member, temporaryPassword } (shown once). 409 duplicate_email.

### `PATCH /team/:id`

{ name?, role?, active? } -> { member: Member, sessionsEnded }. 422 cannot_change_self, last_super_admin.

### `POST /team/:id/reset-password`

-> { member: Member, temporaryPassword, sessionsEnded }


## Audit (any role)

### `GET /audit?from&to&userId&businessId&group&before&limit`

group: 'billing'|'clients'|'signin'|'team'|'shop'; from and to are YYYY-MM-DD (to is inclusive); before is a cursor. -> { entries: [{ id, at, action, group, summary, actor: Actor, business: { id, name }|null, entity, entityId|null, data: object|null }], nextBefore: string|null } newest first

