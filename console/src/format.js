// Formatting and role helpers for the console. Pure functions, no React.
// All dates are shown in Africa/Nairobi time.

const TZ = 'Africa/Nairobi'
const DAY_MS = 86_400_000

const group = (n, min = 0, max = 2) => n.toLocaleString('en-US', { minimumFractionDigits: min, maximumFractionDigits: max })
const isNum = v => typeof v === 'number' && Number.isFinite(v)

// 1250000 -> "KSh 12,500"; cents shown only when not whole; "" for null.
export function money(cents) {
  if (!isNum(cents)) return ''
  const abs = Math.abs(Math.round(cents))
  return (cents < 0 ? '-' : '') + 'KSh ' + group(abs / 100, abs % 100 ? 2 : 0, 2)
}

// Short form for chart axes: "KSh 1.2M", "KSh 45K", "KSh 900".
export function moneyShort(cents) {
  if (!isNum(cents)) return ''
  const sign = cents < 0 ? '-' : ''
  const v = Math.abs(cents) / 100
  const trim = (x, unit) => (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10) + unit
  if (v >= 1e9) return `${sign}KSh ${trim(v / 1e9, 'B')}`
  if (v >= 1e6) return `${sign}KSh ${trim(v / 1e6, 'M')}`
  if (v >= 1e3) return `${sign}KSh ${trim(v / 1e3, 'K')}`
  return `${sign}KSh ${Math.round(v)}`
}

const toDate = v => {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}
const fmt = {}
function parts(d, key, options) {
  fmt[key] ??= new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...options })
  const out = {}
  for (const p of fmt[key].formatToParts(d)) out[p.type] = p.value
  return out
}

// "6 Oct 2026"
export function date(iso) {
  const d = toDate(iso)
  if (!d) return ''
  const p = parts(d, 'day', { day: 'numeric', month: 'short', year: 'numeric' })
  return `${p.day} ${p.month} ${p.year}`
}
// "14:05"
export function time(iso) {
  const d = toDate(iso)
  if (!d) return ''
  const p = parts(d, 'clock', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return `${p.hour}:${p.minute}`
}
// "6 Oct 2026, 14:05"
export function dateTime(iso) {
  return toDate(iso) ? `${date(iso)}, ${time(iso)}` : ''
}
// "2026-10" -> "Oct"
export function monthLabel(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(key ?? '')
  if (!m) return ''
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1] ?? ''
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
// "just now", "3 minutes ago", "yesterday", "in 4 days"; a plain date beyond 7 days.
export function relative(iso, now = Date.now()) {
  const d = toDate(iso)
  if (!d) return ''
  const diff = toDate(now).getTime() - d.getTime()
  const abs = Math.abs(diff)
  const say = text => (diff >= 0 ? `${text} ago` : `in ${text}`)
  if (abs < 45_000) return 'just now'
  if (abs < 3_600_000) return say(plural(Math.max(1, Math.round(abs / 60_000)), 'minute'))
  if (abs < DAY_MS) return say(plural(Math.round(abs / 3_600_000), 'hour'))
  const days = Math.round(abs / DAY_MS)
  if (days === 1) return diff >= 0 ? 'yesterday' : 'tomorrow'
  if (days <= 7) return say(plural(days, 'day'))
  return date(d)
}

const clean = input => String(input ?? '').replace(/[\s,]/g, '').replace(/^ksh/i, '')
// "12,500.50" (shillings) -> 1250050. Null when empty, negative or malformed.
export function toCents(input) {
  const s = clean(input)
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  const cents = Math.round(Number(s) * 100)
  return Number.isSafeInteger(cents) ? cents : null
}
// 1250050 -> "12500.50", 150000 -> "1500"; "" for null.
export function fromCents(cents) {
  if (!isNum(cents)) return ''
  return cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100)
}
// "1.5" or "1.5%" -> 150 basis points. Null when malformed or above 100%.
export function toBps(input) {
  const s = clean(input).replace(/%$/, '')
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  const bps = Math.round(Number(s) * 100)
  return bps <= 10_000 ? bps : null
}
// 150 -> "1.5"
export function fromBps(bps) {
  return isNum(bps) ? String(bps / 100) : ''
}
// 150 -> "1.5%"
export function percent(bps) {
  return isNum(bps) ? group(bps / 100) + '%' : ''
}
export function count(n) {
  return isNum(n) ? group(n, 0, 0) : ''
}

const STATUS = {
  TRIALING: ['Trialing', 'brass'],
  ACTIVE: ['Active', 'green'],
  PAST_DUE: ['Past due', 'amber'],
  SUSPENDED: ['Suspended', 'red'],
  CANCELLED: ['Cancelled', 'muted'],
  NONE: ['No plan', 'muted'],
  OPEN: ['Open', 'brass'],
  PAID: ['Paid', 'green'],
  VOID: ['Void', 'muted'],
  OVERDUE: ['Overdue', 'red'],
  PARTLY_PAID: ['Partly paid', 'amber'],
  ARCHIVED: ['Archived', 'muted'],
  PRIVATE: ['Private', 'muted'],
  OFF: ['Switched off', 'muted'],
  LOCKED: ['Locked', 'amber']
}
const sentence = s => {
  const words = String(s ?? '').replace(/[_.]+/g, ' ').trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
export const statusLabel = status => STATUS[status]?.[0] ?? sentence(status)
// One of 'brass' | 'green' | 'amber' | 'red' | 'muted'
export const statusTone = status => STATUS[status]?.[1] ?? 'muted'

export const ROLES = ['SUPER_ADMIN', 'SUPPORT', 'BILLING']
const ROLE_LABEL = { SUPER_ADMIN: 'Super admin', SUPPORT: 'Support', BILLING: 'Billing' }
export const roleLabel = role => ROLE_LABEL[role] ?? sentence(role)

const MODEL_LABEL = { FLAT: 'Flat fee', PER_BRANCH: 'Per branch', PERCENT_OF_SALES: 'Share of sales', ONE_TIME: 'One time licence' }
export const modelLabel = model => MODEL_LABEL[model] ?? sentence(model)
const INTERVAL_LABEL = { MONTH: 'Monthly', YEAR: 'Yearly', ONCE: 'Once' }
export const intervalLabel = interval => INTERVAL_LABEL[interval] ?? sentence(interval)
const METHOD_LABEL = { MPESA: 'M-Pesa', BANK: 'Bank transfer', CARD: 'Card', CASH: 'Cash', OTHER: 'Other' }
export const methodLabel = method => METHOD_LABEL[method] ?? sentence(method)

// Same wording as describePrice in server/src/rules/pricing.ts.
export function priceText(plan) {
  if (!plan) return ''
  const n = v => (isNum(v) ? v : 0)
  const every = plan.interval === 'YEAR' ? 'a year' : 'a month'
  if (plan.model === 'ONE_TIME') return `${money(n(plan.priceCents))} once`
  if (plan.model === 'FLAT') return `${money(n(plan.priceCents))} ${every}`
  if (plan.model === 'PER_BRANCH') {
    const each = `${money(n(plan.perBranchCents))} per branch ${every}`
    return n(plan.priceCents) > 0 ? `${money(n(plan.priceCents))} ${every} plus ${each}` : each
  }
  const share = `${percent(n(plan.percentBps))} of sales`
  return n(plan.minimumCents) > 0 ? `${share}, minimum ${money(n(plan.minimumCents))} ${every}` : share
}

// Who may do what, mirroring allowPlatform() in the console routes.
// Super admins may do everything. Reading is open to every role.
const ABILITIES = {
  'tenants.create': ['SUPPORT'],
  'tenants.edit': ['SUPPORT'],
  'tenants.suspend': ['SUPPORT'], // suspend and reactivate
  'pins.reset': ['SUPPORT'],
  'sessions.end': ['SUPPORT'], // sign a client out everywhere
  'notes.write': ['SUPPORT'],
  'trial.extend': ['SUPPORT', 'BILLING'],
  'plans.write': ['BILLING'], // create, edit, archive, unarchive
  'subscriptions.write': ['BILLING'], // change plan, terms, cancel, resume
  'invoices.write': ['BILLING'], // create and void
  'payments.write': ['BILLING'],
  'billing.run': ['BILLING'],
  'team.manage': []
}
export const ABILITY_NAMES = Object.keys(ABILITIES)
export function can(role, ability) {
  if (role === 'SUPER_ADMIN') return true
  return (ABILITIES[ability] ?? []).includes(role)
}
const WHY = {
  'tenants.create': 'add a client',
  'tenants.edit': 'edit client details',
  'tenants.suspend': 'suspend or reactivate a client',
  'pins.reset': 'reset an owner PIN',
  'sessions.end': 'sign a client out everywhere',
  'notes.write': 'write or delete notes',
  'trial.extend': 'extend a trial',
  'plans.write': 'change plans',
  'subscriptions.write': 'change a subscription',
  'invoices.write': 'create or void invoices',
  'payments.write': 'record payments',
  'billing.run': 'run billing',
  'team.manage': 'manage the team'
}
// A short sentence for a title attribute on a disabled control.
export function whyNot(ability) {
  const roles = ABILITIES[ability]
  if (!roles) return 'Your console role does not allow this'
  const who = ['super admins', ...roles.map(r => ROLE_LABEL[r].toLowerCase())]
  const list = who.length > 2 ? `${who.slice(0, -1).join(', ')} and ${who[who.length - 1]}` : who.join(' and ')
  return `Only ${list} can ${WHY[ability]}`
}
