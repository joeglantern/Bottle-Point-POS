// Every call the console makes to /api/console lives here. Pages never call fetch.
// Bodies are returned exactly as the server sends them. Dates are ISO strings,
// money is integer cents, percentages are basis points (150 = 1.5%).
//
// Shared shapes used in the comments below:
//   SubStatus  'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED'   (tenant status adds 'NONE')
//   InvStatus  'OPEN' | 'PAID' | 'VOID'   (the OVERDUE filter means OPEN and past dueAt; rows carry overdue: boolean)
//   Line       { description, quantity, unitCents, amountCents }
//   Actor      { id: string|null, name, kind: 'platform' | 'shop' | 'system' }
//   TenantSub  { id, status, plan: { id, code, name, model, interval, active, priceText }, trialEndsAt|null,
//                currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd, cancelledAt|null, discountBps,
//                customPriceCents|null, suspendedReason|null, suspendedAt|null }
//   Sub        { id, businessId, businessName, plan: { id, code, name, model, interval }, status, currentPeriodStart,
//                currentPeriodEnd, trialEndsAt|null, cancelAtPeriodEnd, cancelledAt|null, discountBps,
//                customPriceCents|null, suspendedReason|null, suspendedAt|null, createdAt,
//                nextAmountCents|null, nextInvoiceAt|null }
//   InvoiceRef { id, number, totalCents, status, dueAt } | null
//   InvoiceRow { id, number, business: { id, name }, subscriptionId|null, status, overdue, periodStart, periodEnd,
//                subtotalCents, taxCents, totalCents, paidCents, balanceCents, issuedAt, dueAt, paidAt|null, voidedAt|null }
//   Payment    { id, amountCents, method: 'MPESA'|'BANK'|'CARD'|'CASH'|'OTHER', reference|null, receivedAt, createdAt,
//                recordedBy: { id, name } | null }
//   Invoice    InvoiceRow plus { lines: Line[], notes|null, payments: Payment[],
//                client: { id, name, legalName|null, address|null, kraPin|null, email|null, phone|null } }
//   Plan       { id, code, name, description|null, model: 'FLAT'|'PER_BRANCH'|'PERCENT_OF_SALES'|'ONE_TIME',
//                interval: 'MONTH'|'YEAR'|'ONCE', priceCents, perBranchCents, percentBps, minimumCents, trialDays,
//                maxBranches|null, maxStaff|null, maxProducts|null, features: {}, active, public, sortOrder,
//                createdAt, updatedAt, priceText, clients }
//   Member     { id, name, email, role: 'SUPER_ADMIN'|'SUPPORT'|'BILLING', active, locked, lastSignInAt|null, createdAt }
//
// Errors: every failure throws ApiError. 400 bad_request (validation, see fields), 401 unauthorized,
// 403 forbidden, 404 not_found, 409 conflict codes (duplicate_username, duplicate_code, duplicate_email),
// 422 with a specific code (listed per call).

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details ?? null
    // Validation failures arrive as details { formErrors: string[], fieldErrors: { field: string[] } }.
    this.fields = {}
    const fe = details && typeof details === 'object' ? details.fieldErrors : null
    if (fe && typeof fe === 'object') {
      for (const [k, v] of Object.entries(fe)) {
        const first = Array.isArray(v) ? v[0] : v
        if (first) this.fields[k] = String(first)
      }
    }
    const form = details && Array.isArray(details.formErrors) ? details.formErrors.filter(Boolean) : []
    if (form.length && message === 'Invalid input.') this.message = form.join(' ')
  }
}

const OFFLINE = 'Could not reach the server. Check your connection and try again.'
const BASE = '/api/console'

let unauthorizedHandler = null
// Register what happens when the session has ended (any 401 except from sign in).
export function onUnauthorized(fn) {
  unauthorizedHandler = fn
}

function queryString(query) {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '') continue
    p.set(k, String(v))
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

async function request(method, path, { query, body, signal } = {}) {
  let res
  try {
    res = await fetch(BASE + path + queryString(query), {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal
    })
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    throw new ApiError(0, 'network', OFFLINE)
  }

  let data = null
  try {
    data = res.status === 204 ? null : await res.json()
  } catch {
    data = null
  }
  if (res.ok) return data

  const e = data && typeof data === 'object' ? data.error : null
  const fallback =
    res.status === 401 ? 'Please sign in again.'
    : res.status === 403 ? 'Your console role does not allow this.'
    : res.status === 404 ? 'That could not be found.'
    : res.status === 429 ? 'Too many attempts. Wait a moment and try again.'
    : res.status >= 500 ? 'The server had a problem. Try again in a moment.'
    : 'That did not work. Try again.'
  const error = new ApiError(res.status, e?.code ?? `http_${res.status}`, e?.message ?? fallback, e?.details)
  if (res.status === 401 && path !== '/session/login' && unauthorizedHandler) unauthorizedHandler(error)
  throw error
}

const get = (path, query, opts) => request('GET', path, { ...opts, query })
const post = (path, body, opts) => request('POST', path, { ...opts, body: body ?? {} })
const patch = (path, body, opts) => request('PATCH', path, { ...opts, body })
const del = (path, opts) => request('DELETE', path, opts)
const id = v => encodeURIComponent(v)

// Every function takes an optional last argument { signal } for cancelling.
export const api = {
  // ---- session ----

  /** POST /session/login { email, password } -> { ok: true }. 401 "Wrong email or password." */
  login: (email, password, opts) => post('/session/login', { email, password }, opts),
  /** POST /session/logout -> { ok: true } */
  logout: opts => post('/session/logout', {}, opts),
  /** GET /session/me -> { user: { id, name, email, role: 'SUPER_ADMIN'|'SUPPORT'|'BILLING' } } */
  me: opts => get('/session/me', undefined, opts),
  /** POST /session/password { currentPassword, newPassword (10+ chars) } -> { ok: true }. 400 when the current one is wrong. */
  changePassword: (currentPassword, newPassword, opts) => post('/session/password', { currentPassword, newPassword }, opts),

  // ---- overview and search (any role) ----

  /**
   * GET /overview -> { overview: {
   *   generatedAt, mrrCents, arrCents,
   *   counts: { TRIALING, ACTIVE, PAST_DUE, SUSPENDED, CANCELLED, NONE, total },
   *   trialsEndingSoon: [{ businessId, name, plan: { id, name }, trialEndsAt|null, daysLeft }],   (next 7 days)
   *   outstandingCents, outstandingCount, overdueCents, overdueCount, collectedThisMonthCents,
   *   newClientsThisMonth, churnedThisMonth,
   *   revenueByMonth: [{ month: 'YYYY-MM', invoicedCents, collectedCents }],   (12 rows, oldest first)
   *   salesByMonth: [{ month: 'YYYY-MM', salesCents, salesCount }],            (12 rows, oldest first)
   *   planMix: [{ planId, code, name, clients, mrrCents }],
   *   attention: [{ kind: 'past_due'|'suspended'|'trial_ending', businessId, name, status: SubStatus, reason, at|null, amountCents|null }],
   *   recentActivity: [{ id, at, action, summary, actor: Actor, business: { id, name }|null }] } }
   */
  overview: opts => get('/overview', undefined, opts),
  /**
   * GET /search?q= -> { tenants: [{ id, name, status, plan: { id, name }|null, owners: [{ name, username }] }],
   *   invoices: [{ id, number, businessName, status: InvStatus, overdue, totalCents, paidCents, balanceCents, issuedAt, dueAt }] }
   * At most 8 of each. An empty q answers with empty lists.
   */
  search: (q, opts) => get('/search', { q }, opts),

  // ---- clients (called tenants by the API). Reads: any role. Writes: SUPPORT or SUPER_ADMIN ----

  /**
   * GET /tenants?q&status&planId&sort&dir&limit&offset
   *   status: SubStatus | 'NONE'; sort: 'name' (default) | 'joined' | 'mrr' | 'sales'; dir: 'asc' | 'desc'
   *   (default asc for name, desc otherwise); limit 1 to 200 (default 50); offset.
   * -> { tenants: [{ id, name, status, plan: { id, name }|null, branches, staff, sales30dCents, mrrCents, createdAt, trialEndsAt|null }],
   *      total,   (rows matching q, planId and status)
   *      counts: { ALL, TRIALING?, ACTIVE?, PAST_DUE?, SUSPENDED?, CANCELLED?, NONE? } }   (per status, ignoring the status filter; absent means 0)
   */
  listTenants: (filters, opts) => get('/tenants', filters, opts),
  /**
   * POST /tenants { businessName, branchName, ownerName, ownerUsername, ownerPin?, planId, trialDays? (0 to 90), email?, phone? }
   * -> 201 { tenant: { id, name, email|null, phone|null, createdAt }, branch: { id, name }, owner: { id, name, username },
   *          subscription: TenantSub, invoice: { id, number, totalCents, status }|null,
   *          ownerPin: string|null }   (the generated PIN, shown once; null when one was supplied)
   * 409 duplicate_username.
   */
  createTenant: (body, opts) => post('/tenants', body, opts),
  /**
   * GET /tenants/:id -> { tenant: { id, name, legalName|null, email|null, phone|null, address|null, kraPin|null, createdAt,
   *   status, subscription: TenantSub|null, usage: { branches, staff, products },
   *   limits: { maxBranches|null, maxStaff|null, maxProducts|null }|null,
   *   sales30dCents, mrrCents, lastSaleAt|null, lastSignInAt|null, owners: [{ id, name, username }],
   *   nextInvoice: { periodStart, periodEnd, issueAt, lines: Line[], subtotalCents, taxCents, totalCents }|null,
   *   openInvoiceCents, openInvoiceCount, overdueInvoiceCount } }
   */
  getTenant: (tenantId, opts) => get(`/tenants/${id(tenantId)}`, undefined, opts),
  /** PATCH /tenants/:id { name?, legalName?, email?, phone?, address?, kraPin? } ('' or null clears) -> { tenant: { id, name, legalName, email, phone, address, kraPin } } */
  updateTenant: (tenantId, body, opts) => patch(`/tenants/${id(tenantId)}`, body, opts),
  /** POST /tenants/:id/suspend { reason (3 to 300 chars) } -> { subscription: TenantSub }. 422 no_subscription or already suspended or cancelled. */
  suspendTenant: (tenantId, reason, opts) => post(`/tenants/${id(tenantId)}/suspend`, { reason }, opts),
  /** POST /tenants/:id/reactivate -> { subscription: TenantSub }. 422 unless suspended. */
  reactivateTenant: (tenantId, opts) => post(`/tenants/${id(tenantId)}/reactivate`, {}, opts),
  /**
   * GET /tenants/:id/people -> { people: [{ id, name, username, role: 'OWNER'|'MANAGER'|'CASHIER', active, locked,
   *   branches: [{ id, name }], lastSignInAt|null, createdAt }] }
   */
  listPeople: (tenantId, opts) => get(`/tenants/${id(tenantId)}/people`, undefined, opts),
  /** POST /tenants/:id/people/:userId/reset-pin -> { user: { id, name, username }, ownerPin, sessionsEnded }. Owners only: 422 not_owner. */
  resetPin: (tenantId, userId, opts) => post(`/tenants/${id(tenantId)}/people/${id(userId)}/reset-pin`, {}, opts),
  /** POST /tenants/:id/sign-out-all -> { sessionsEnded } */
  signOutAll: (tenantId, opts) => post(`/tenants/${id(tenantId)}/sign-out-all`, {}, opts),
  /** GET /tenants/:id/notes -> { notes: [{ id, body, createdAt, author: { id, name } }] } newest first */
  listNotes: (tenantId, opts) => get(`/tenants/${id(tenantId)}/notes`, undefined, opts),
  /** POST /tenants/:id/notes { body (1 to 2000 chars) } -> 201 { note: { id, body, createdAt, author: { id, name } } } */
  addNote: (tenantId, body, opts) => post(`/tenants/${id(tenantId)}/notes`, { body }, opts),
  /** DELETE /tenants/:id/notes/:noteId -> { ok: true }. 403 unless you wrote it or are a super admin. */
  deleteNote: (tenantId, noteId, opts) => del(`/tenants/${id(tenantId)}/notes/${id(noteId)}`, opts),
  /**
   * GET /tenants/:id/activity?limit&before -> { activity: [{ id, at, action, entity, entityId|null, actor: Actor }],
   *   nextBefore: string|null }   (pass nextBefore back as before for the next page)
   */
  tenantActivity: (tenantId, query, opts) => get(`/tenants/${id(tenantId)}/activity`, query, opts),

  // ---- plans. Reads: any role. Writes: BILLING or SUPER_ADMIN ----

  /** GET /plans?includeArchived=true -> { plans: Plan[] } ordered by sortOrder then name. Archived plans have active: false. */
  listPlans: (includeArchived = false, opts) => get('/plans', includeArchived ? { includeArchived: 'true' } : undefined, opts),
  /** GET /plans/:id -> { plan: Plan } */
  getPlan: (planId, opts) => get(`/plans/${id(planId)}`, undefined, opts),
  /**
   * POST /plans { code (lowercase, digits, dashes; 2 to 40), name, model, description?, interval?, priceCents?, perBranchCents?,
   *   percentBps?, minimumCents?, trialDays? (default 14), maxBranches?, maxStaff?, maxProducts?, features?, public?, sortOrder? }
   * -> 201 { plan: Plan }. 409 duplicate_code. Per model rules come back as field errors:
   *   FLAT: MONTH or YEAR. PER_BRANCH: perBranchCents above 0, MONTH or YEAR.
   *   PERCENT_OF_SALES: percentBps 1 to 5000, MONTH only. ONE_TIME: interval ONCE.
   */
  createPlan: (body, opts) => post('/plans', body, opts),
  /** PATCH /plans/:id { any Plan field except code } -> { plan: Plan } */
  updatePlan: (planId, body, opts) => patch(`/plans/${id(planId)}`, body, opts),
  /** POST /plans/:id/archive -> { plan: Plan } */
  archivePlan: (planId, opts) => post(`/plans/${id(planId)}/archive`, {}, opts),
  /** POST /plans/:id/unarchive -> { plan: Plan } */
  unarchivePlan: (planId, opts) => post(`/plans/${id(planId)}/unarchive`, {}, opts),

  // ---- subscriptions. Reads: any role. Writes: BILLING or SUPER_ADMIN (extend trial: SUPPORT too) ----

  /** GET /subscriptions?status&planId&q&limit&offset -> { subscriptions: Sub[], total } ordered by client name */
  listSubscriptions: (filters, opts) => get('/subscriptions', filters, opts),
  /**
   * POST /tenants/:id/subscription/plan { planId, force? } -> { subscription: Sub, invoice: InvoiceRef }
   * 422 same_plan, subscription_cancelled, or over_plan_limits with details
   *   { over: [{ what: 'branches'|'staff'|'products', used, max }], usage, limits }; send force: true to go ahead anyway.
   */
  changePlan: (tenantId, planId, force = false, opts) => post(`/tenants/${id(tenantId)}/subscription/plan`, { planId, force }, opts),
  /** POST /tenants/:id/subscription/terms { discountBps?, customPriceCents? (null clears) } -> { subscription: Sub } */
  setTerms: (tenantId, terms, opts) => post(`/tenants/${id(tenantId)}/subscription/terms`, terms, opts),
  /** POST /tenants/:id/subscription/extend-trial { days (1 to 90) } -> { subscription: Sub }. 422 not_trialing. */
  extendTrial: (tenantId, days, opts) => post(`/tenants/${id(tenantId)}/subscription/extend-trial`, { days }, opts),
  /** POST /tenants/:id/subscription/cancel { atPeriodEnd: boolean, reason? } -> { subscription: Sub }. 422 already_cancelled, invalid_state. */
  cancelSubscription: (tenantId, body, opts) => post(`/tenants/${id(tenantId)}/subscription/cancel`, body, opts),
  /** POST /tenants/:id/subscription/resume -> { subscription: Sub, invoice: InvoiceRef }. 422 not_cancelled. */
  resumeSubscription: (tenantId, opts) => post(`/tenants/${id(tenantId)}/subscription/resume`, {}, opts),

  // ---- invoices and payments. Reads: any role. Writes: BILLING or SUPER_ADMIN ----

  /**
   * GET /invoices?status&businessId&q&from&to&limit&offset
   *   status: 'OPEN'|'PAID'|'VOID'|'OVERDUE'; q matches number or client name; from and to are YYYY-MM-DD on issuedAt (to is inclusive).
   * -> { invoices: InvoiceRow[], total, totals: { billedCents, collectedCents, outstandingCents } }   newest first
   */
  listInvoices: (filters, opts) => get('/invoices', filters, opts),
  /** URL of GET /invoices/export.csv with the same filters (no paging). Use as a plain link so the browser downloads it. */
  invoicesCsvUrl: filters => {
    const { limit, offset, ...rest } = filters ?? {}
    return `${BASE}/invoices/export.csv${queryString(rest)}`
  },
  /** GET /invoices/:id -> { invoice: Invoice } */
  getInvoice: (invoiceId, opts) => get(`/invoices/${id(invoiceId)}`, undefined, opts),
  /**
   * POST /tenants/:id/invoices { lines: [{ description, quantity (1 to 1000), unitCents }], dueInDays? (0 to 90, default 7), notes? }
   * -> 201 { invoice: Invoice }   (VAT is added by the server)
   */
  createInvoice: (tenantId, body, opts) => post(`/tenants/${id(tenantId)}/invoices`, body, opts),
  /**
   * POST /invoices/:id/payments { amountCents (above 0), method: 'MPESA'|'BANK'|'CARD'|'CASH'|'OTHER', reference?, receivedAt? (ISO, not in the future) }
   * -> 201 { invoice: Invoice, payment: Payment|null, subscriptionStatus: SubStatus|null }
   * 422 invoice_void, invoice_paid, invoice_not_open, overpayment.
   */
  recordPayment: (invoiceId, body, opts) => post(`/invoices/${id(invoiceId)}/payments`, body, opts),
  /** POST /invoices/:id/void { reason (1 to 500 chars) } -> { invoice: Invoice, subscriptionStatus: SubStatus|null }. 422 invoice_not_open, invoice_has_payments. */
  voidInvoice: (invoiceId, reason, opts) => post(`/invoices/${id(invoiceId)}/void`, { reason }, opts),

  // ---- billing run. Preview: any role. Run: BILLING or SUPER_ADMIN ----

  /** POST /billing/run -> { summary: { invoicesCreated, trialsConverted, markedPastDue, suspended, cancelled, errors: [{ businessId, message }] } } */
  runBilling: opts => post('/billing/run', {}, opts),
  /**
   * GET /billing/preview -> { preview: { at, totals: { invoices, invoiceTotalCents, trialsConverted, markedPastDue, suspended, cancelled },
   *   items: [{ businessId, businessName, plan: { id, name }, status, actions: [
   *     { type: 'convert_trial'|'advance_period', periodStart, periodEnd }
   *     | { type: 'invoice', periodStart, periodEnd, subtotalCents, taxCents, totalCents }
   *     | { type: 'cancel' }
   *     | { type: 'past_due'|'suspend', invoiceId, invoiceNumber, dueAt } ] }] } }
   */
  billingPreview: opts => get('/billing/preview', undefined, opts),

  // ---- team. Read: any role. Writes: SUPER_ADMIN only ----

  /** GET /team -> { team: Member[] } */
  listTeam: opts => get('/team', undefined, opts),
  /** POST /team { name, email, role } -> 201 { member: Member, temporaryPassword }   (shown once). 409 duplicate_email. */
  inviteTeamMember: (body, opts) => post('/team', body, opts),
  /** PATCH /team/:id { name?, role?, active? } -> { member: Member, sessionsEnded }. 422 cannot_change_self, last_super_admin. */
  updateTeamMember: (memberId, body, opts) => patch(`/team/${id(memberId)}`, body, opts),
  /** POST /team/:id/reset-password -> { member: Member, temporaryPassword, sessionsEnded } */
  resetTeamPassword: (memberId, opts) => post(`/team/${id(memberId)}/reset-password`, {}, opts),

  // ---- audit (any role) ----

  /**
   * GET /audit?from&to&userId&businessId&group&before&limit
   *   group: 'billing'|'clients'|'signin'|'team'|'shop'; from and to are YYYY-MM-DD (to is inclusive); before is a cursor.
   * -> { entries: [{ id, at, action, group, summary, actor: Actor, business: { id, name }|null, entity, entityId|null, data: object|null }],
   *      nextBefore: string|null }   newest first
   */
  listAudit: (filters, opts) => get('/audit', filters, opts)
}
