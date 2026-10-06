// Helpers for the owner's activity log and devices pages: which group an
// action belongs to, what is safe to show from an audit row, a plain words
// summary of it, and a short device name from a browser user agent.

export const SUPPORT_NAME = 'Bottle Point support'

export const AUDIT_GROUPS = ['sales', 'payments', 'stock', 'staff', 'settings', 'signin'] as const
export type AuditGroup = (typeof AUDIT_GROUPS)[number]

// Every entry is an action prefix. `exclude` wins over `include`, which is how
// "sale.pay" lands in payments while the rest of "sale." stays in sales.
export const GROUP_RULES: Record<AuditGroup, { include: string[]; exclude: string[] }> = {
  sales: { include: ['sale.', 'shift.', 'approval.', 'customer.'], exclude: ['sale.pay', 'sale.refund'] },
  payments: { include: ['mpesa.', 'payment.', 'sale.pay', 'sale.refund'], exclude: ['mpesa.config', 'mpesa.secrets', 'mpesa.settings'] },
  stock: { include: ['stock.', 'product.'], exclude: [] },
  staff: { include: ['user.'], exclude: ['user.signed_out'] },
  settings: {
    include: ['business.', 'branch.', 'settings.', 'mpesa.config', 'mpesa.secrets', 'mpesa.settings', 'mpesa_config.', 'export.', 'console.', 'billing.', 'subscription.', 'invoice.'],
    exclude: []
  },
  signin: { include: ['auth.', 'session.', 'user.signed_out'], exclude: [] }
}

export function groupOf(action: string): AuditGroup | null {
  for (const g of AUDIT_GROUPS) {
    const r = GROUP_RULES[g]
    if (r.include.some(p => action.startsWith(p)) && !r.exclude.some(p => action.startsWith(p))) return g
  }
  return null
}

// Rows written by the platform (console staff or the billing run).
export const isPlatformAction = (action: string) => action.startsWith('console.') || action.startsWith('billing.')

// Notes the platform staff keep about a client are for their eyes only, so
// the rows about them never reach the client's own activity log.
export const HIDDEN_PREFIXES = ['console.note.']

const words = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

// Does this key name look like it holds a secret? "pin" only counts as a whole
// word, so "shipping" or "openingFloatCents" are left alone.
export function looksSecret(key: string) {
  const flat = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (/(password|passkey|token|secret|hash|cookie)/.test(flat)) return true
  if (/keys?$/.test(flat)) return true
  return words(key).some(w => w === 'pin' || w === 'pins' || w === 'key' || w === 'keys')
}

// Keys that name who at the platform did something.
const STAFF_KEY = /^(staff|admin|actor|author|operator|agent|support|by|user|platform (user|staff|admin))\b|\b[a-z]+ by\b|email/

export type Scrub = { staff?: boolean; needles?: string[] }

// A copy of audit data with secrets removed. With `staff`, anything that could
// identify a platform staff member goes too: keys that name a person, and any
// text holding one of the `needles` (staff ids, names and emails).
export function cleanData(value: unknown, opts: Scrub = {}): unknown {
  const needles = (opts.needles ?? []).map(n => n.toLowerCase()).filter(n => n.length > 1)
  const walk = (v: unknown): unknown => {
    if (v === null || v === undefined) return v
    if (typeof v === 'string') {
      if (opts.staff && needles.some(n => v.toLowerCase().includes(n))) return undefined
      return v
    }
    if (Array.isArray(v)) return v.map(walk).filter(x => x !== undefined)
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
        if (looksSecret(k)) continue
        if (opts.staff && STAFF_KEY.test(words(k).join(' '))) continue
        const w = walk(inner)
        if (w !== undefined) out[k] = w
      }
      return out
    }
    return v
  }
  const out = walk(value)
  return out === undefined ? null : out
}

// "KSh 4,800" from cents. Cents are shown only when there are any.
export function ksh(cents: unknown) {
  const n = typeof cents === 'number' && Number.isFinite(cents) ? Math.round(cents) : 0
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const rest = abs % 100
  return `${sign}KSh ${whole}${rest ? '.' + String(rest).padStart(2, '0') : ''}`
}

export type SummaryInput = {
  action: string
  data: unknown
  // who did it, already resolved: a staff name, "Bottle Point support", or null for the system
  who: string | null
  saleNumber?: number | null
  // name of the person the row is about, for actions on a user
  subjectName?: string | null
}

const rec = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {})
const KIND: Record<string, string> = { CANCEL: 'cancellation', REFUND: 'refund', DISCOUNT: 'discount' }

// One plain sentence for an audit row. Unknown actions get a readable
// generic sentence built from the action name.
export function summarize(i: SummaryInput): string {
  const d = rec(i.data)
  const who = i.who ?? 'The system'
  const number = i.saleNumber ?? (typeof d.saleNumber === 'number' ? d.saleNumber : typeof d.number === 'number' ? d.number : null)
  const sale = number != null ? `sale #${number}` : 'a sale'
  const person = i.subjectName ?? (typeof d.name === 'string' ? d.name : null) ?? 'a staff member'
  const named = (fallback: string) => (typeof d.name === 'string' && d.name ? d.name : fallback)
  const kind = KIND[String(d.kind)] ?? 'change'
  const n = (v: unknown) => (typeof v === 'number' ? v : 0)
  const invoiceNo = typeof d.number === 'string' ? d.number : typeof d.invoiceNumber === 'string' ? d.invoiceNumber : ''

  switch (i.action) {
    case 'sale.create':
      return `${who} started ${sale}`
    case 'sale.lines':
      return `${who} changed the items on ${sale}, new total ${ksh(d.totalCents)}`
    case 'sale.update':
      return `${who} updated the details of ${sale}`
    case 'sale.pay': {
      const total = Array.isArray(d.payments) ? d.payments.reduce((a: number, p: any) => a + n(p?.amountCents), 0) : 0
      return `${who} took a payment of ${ksh(total)} on ${sale}`
    }
    case 'sale.cancel':
      return `${who} approved cancelling ${sale} (${ksh(d.totalCents)})`
    case 'sale.discount':
      return `${who} approved a discount of ${ksh(d.discountCents)} on ${sale}`
    case 'sale.refund':
      return `${who} approved a refund of ${ksh(d.amountCents)} on ${sale}`
    case 'approval.request':
      return `${who} asked for a ${kind}${d.amountCents ? ` of ${ksh(d.amountCents)}` : ''} on ${sale}`
    case 'approval.approve':
      return `${who} approved a ${kind} request on ${sale}`
    case 'approval.reject':
      return `${who} turned down a ${kind} request on ${sale}`
    case 'shift.open':
      return `${who} opened a shift with a float of ${ksh(d.openingFloatCents)}`
    case 'shift.close':
      return `${who} closed a shift: counted ${ksh(d.countedCashCents)}, expected ${ksh(d.expectedCashCents)}`
    case 'stock.received': {
      const count = Array.isArray(d.items) ? d.items.length : 0
      return count ? `${who} received stock for ${count} ${count === 1 ? 'product' : 'products'}` : `${who} received stock`
    }
    case 'stock.adjusted':
      return `${who} corrected a stock count from ${n(d.from)} to ${n(d.to)}${d.reason ? ` (${d.reason})` : ''}`
    case 'stock.reorder_changed':
      return `${who} changed a reorder level from ${n(d.from)} to ${n(d.to)}`
    case 'product.created':
      return `${who} added the product ${named('(no name)')}`
    case 'product.price_changed':
      return `${who} changed the price of ${named('a product')} from ${ksh(d.oldPriceCents)} to ${ksh(d.newPriceCents)}`
    case 'product.updated':
      return `${who} edited a product`
    case 'product.deactivated':
      return `${who} switched off the product ${named('(no name)')}`
    case 'customer.created':
      return `${who} added the customer ${named('(no name)')}`
    case 'customer.updated':
      return `${who} edited a customer`
    case 'branch.created':
      return `${who} added the branch ${named('(no name)')}`
    case 'branch.updated':
      return `${who} edited the branch ${rec(d.to).name ?? ''}`.trim()
    case 'user.created':
      return `${who} added ${person} as a staff member`
    case 'user.updated':
      return `${who} changed the account of ${person}`
    case 'user.pin_reset':
      return `${who} reset the PIN of ${person}`
    case 'user.signed_out': {
      const count = n(d.sessionsEnded)
      return `${who} signed ${person} out of ${count} ${count === 1 ? 'device' : 'devices'}`
    }
    case 'session.revoked':
      return `${who} signed ${person} out of ${typeof d.device === 'string' ? d.device : 'a device'}`
    case 'auth.pin_failed':
      return `Wrong PIN entered for ${person}${d.tries ? ` (try ${n(d.tries)})` : ''}`
    case 'mpesa.stk_requested':
      return `${who} sent an M-Pesa request of ${ksh(d.amountCents)} for ${sale}`
    case 'mpesa.stk_failed':
      return `An M-Pesa request for ${sale} could not be sent`
    case 'mpesa.till_cancelled':
      return `${who} cancelled an M-Pesa request for ${sale}`
    case 'mpesa.paid':
      return `M-Pesa payment of ${ksh(d.amountCents)} received for ${sale}${d.receipt ? ` (${d.receipt})` : ''}`
    case 'mpesa.amount_mismatch':
      return `M-Pesa reported ${ksh(d.reportedCents)} but ${ksh(d.requestedCents)} was requested for ${sale}. No payment was recorded`
    case 'mpesa.manual_confirmed':
      return `M-Pesa confirmed the typed code${d.receipt ? ` ${d.receipt}` : ''} for ${sale}`
    case 'mpesa.unlinked_payment':
      return `An M-Pesa payment for ${sale} arrived but could not be added to it. It needs checking`
    case 'business.updated':
    case 'console.tenant.updated':
      return `${who} updated the business details`
    case 'mpesa.config_updated':
      return `${who} changed the M-Pesa setup`
    case 'mpesa.secrets_deleted':
      return `${who} removed the M-Pesa keys`
    case 'export.created':
      return `${who} downloaded an export${typeof d.kind === 'string' ? ` (${d.kind.toLowerCase().replace(/_/g, ' ')})` : ''}`
    case 'billing.invoice_created':
    case 'console.invoice.created':
      return `${who} issued invoice ${invoiceNo}${typeof d.totalCents === 'number' ? ` for ${ksh(d.totalCents)}` : ''}`.replace(/\s+/g, ' ')
    case 'console.invoice.payment_recorded':
      return `${who} recorded a payment${typeof d.amountCents === 'number' ? ` of ${ksh(d.amountCents)}` : ''}${invoiceNo ? ` on invoice ${invoiceNo}` : ''}`
    case 'console.invoice.voided':
      return `${who} cancelled invoice ${invoiceNo}`.trim()
    case 'console.tenant.created':
      return `${who} set up this business`
    case 'console.tenant.suspended':
    case 'billing.suspended':
      return `${who} suspended this account`
    case 'console.tenant.reactivated':
    case 'console.subscription.resumed':
    case 'billing.reactivated':
      return `${who} reactivated this account`
    case 'console.tenant.pin_reset':
      return `${who} reset the owner PIN`
    case 'console.tenant.signed_out':
      return `${who} signed staff out of their devices`
    case 'console.subscription.plan_changed':
      return `${who} changed the plan`
    case 'console.subscription.terms_changed':
      return `${who} changed the subscription terms`
    case 'console.subscription.trial_extended':
      return `${who} extended the trial`
    case 'console.subscription.cancelled':
    case 'billing.cancelled':
      return `${who} ended the subscription`
    case 'billing.past_due':
      return `${who} marked the subscription as overdue`
    case 'billing.period_advanced':
      return `${who} started a new billing period`
    case 'billing.trial_converted':
      return `${who} ended the trial and started the paid plan`
  }
  // "business.vat_updated" reads as "business: vat updated"
  const [area, ...rest] = i.action.split('.')
  const what = rest.join(' ').replace(/_/g, ' ').trim()
  const label = what ? `${(area ?? '').replace(/_/g, ' ')}: ${what}` : i.action.replace(/_/g, ' ')
  return `${who} recorded an activity (${label})`
}

// "Chrome on Android" from a user agent. Order matters: Edge, Samsung
// Internet and Opera all also say "Chrome", and Chrome also says "Safari".
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? '').trim()
  if (!ua) return 'Unknown device'

  let browser: string | null = null
  if (/Edg(e|A|iOS)?\//.test(ua)) browser = 'Edge'
  else if (/SamsungBrowser\//.test(ua)) browser = 'Samsung Internet'
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera'
  else if (/Firefox\/|FxiOS\//.test(ua)) browser = 'Firefox'
  else if (/Chrome\/|CriOS\//.test(ua)) browser = 'Chrome'
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = 'Safari'

  let os: string | null = null
  if (/iPad/.test(ua)) os = 'iPad'
  else if (/iPhone|iPod/.test(ua)) os = 'iPhone'
  else if (/Android/.test(ua)) os = 'Android'
  else if (/Windows/.test(ua)) os = 'Windows'
  else if (/CrOS/.test(ua)) os = 'ChromeOS'
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'macOS'
  else if (/Linux|X11/.test(ua)) os = 'Linux'

  if (browser && os) return `${browser} on ${os}`
  return browser ?? os ?? 'Unknown device'
}
