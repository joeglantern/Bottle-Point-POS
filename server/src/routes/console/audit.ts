import { Hono } from 'hono'
import { z } from 'zod'
import { prisma, type AuditLog, type Prisma } from '../../db.js'
import { badRequest } from '../../lib/errors.js'
import { id as idRule, query } from '../../lib/validate.js'
import type { ConsoleEnv } from '../../middleware/platform.js'
import { DAY_MS, paging } from '../../rules/platform.js'

// The audit log across every client and the platform itself. Read only, and
// open to every console role.
export const auditRoutes = new Hono<ConsoleEnv>()

export const AUDIT_GROUPS = ['billing', 'clients', 'signin', 'team', 'shop'] as const
export type AuditGroup = (typeof AUDIT_GROUPS)[number]

const SIGNIN_ACTIONS = ['console.login', 'console.login_failed', 'console.password_changed']
const BILLING_PREFIXES = ['billing.', 'console.invoice.', 'console.plan.', 'console.subscription.', 'console.billing.']
const CLIENT_PREFIXES = ['console.tenant.', 'console.note.']

const starts = (prefixes: string[]): Prisma.AuditLogWhereInput[] => prefixes.map(p => ({ action: { startsWith: p } }))

// Which actions belong to each filter chip.
export function groupWhere(group: AuditGroup): Prisma.AuditLogWhereInput {
  if (group === 'billing') return { OR: starts(BILLING_PREFIXES) }
  if (group === 'clients') return { OR: starts(CLIENT_PREFIXES) }
  if (group === 'team') return { action: { startsWith: 'console.team.' } }
  if (group === 'signin') return { action: { in: SIGNIN_ACTIONS } }
  // whatever happened inside a shop: anything the console and billing did not write
  return { NOT: starts(['console.', 'billing.']) }
}

export function groupOf(action: string): AuditGroup {
  if (SIGNIN_ACTIONS.includes(action)) return 'signin'
  if (BILLING_PREFIXES.some(p => action.startsWith(p))) return 'billing'
  if (CLIENT_PREFIXES.some(p => action.startsWith(p))) return 'clients'
  if (action.startsWith('console.team.')) return 'team'
  return action.startsWith('console.') ? 'clients' : 'shop'
}

type Data = Record<string, unknown>

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)
const money = (cents: number) =>
  'KSh ' + (cents / 100).toLocaleString('en-KE', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })
const percent = (bps: number) => (bps / 100).toLocaleString('en-KE', { maximumFractionDigits: 2 }) + '%'
const ROLE: Record<string, string> = { SUPER_ADMIN: 'super admin', SUPPORT: 'support', BILLING: 'billing' }
const tail = (text: string | null) => (text ? `: ${lowerFirst(text)}` : '')

// "sale.refund_approved" reads as "Sale refund approved".
function readable(action: string) {
  const words = action.replace(/^console\./, '').replace(/[._]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// One line in plain words for an audit row. `businessName` is the client the
// row belongs to and `subjectName` the user it was done to, when known.
export function auditSummary(action: string, data: unknown, businessName?: string | null, subjectName?: string | null): string {
  const d: Data = data && typeof data === 'object' && !Array.isArray(data) ? (data as Data) : {}
  const biz = str(businessName) ?? str(d.businessName) ?? 'a client'
  const invoice = str(d.number) ?? str(d.invoiceNumber)
  const inv = invoice ? `invoice ${invoice}` : 'an invoice'
  const plan = str(d.planName) ?? str(d.plan) ?? str(d.toPlan) ?? str(d.name) ?? str(d.code)
  const reason = str(d.reason)
  const person = str(subjectName) ?? str(d.name) ?? str(d.ownerName) ?? str(d.username) ?? str(d.email) ?? 'a user'
  const amount = num(d.amountCents) ?? num(d.totalCents)
  const forAmount = amount != null ? ` for ${money(amount)}` : ''

  switch (action) {
    case 'console.login':
      return 'Signed in to the console'
    case 'console.login_failed':
      return `Wrong password at console sign in for ${person}`
    case 'console.password_changed':
      return 'Changed their console password'

    case 'console.team.created':
      return `Added ${person} to the team` + (str(d.role) ? ` as ${ROLE[str(d.role)!] ?? str(d.role)}` : '')
    case 'console.team.password_reset':
      return `Reset the console password of ${person}`
    case 'console.team.updated': {
      const ch = (d.changes && typeof d.changes === 'object' ? d.changes : {}) as Record<string, { from?: unknown; to?: unknown }>
      const parts: string[] = []
      if (ch.role) parts.push(`role changed to ${ROLE[String(ch.role.to)] ?? String(ch.role.to)}`)
      if (ch.active) parts.push(ch.active.to ? 'switched back on' : 'switched off')
      if (ch.name) parts.push(`renamed from ${String(ch.name.from)}`)
      return `Updated ${person}` + (parts.length ? `: ${parts.join(', ')}` : '')
    }

    case 'console.tenant.created':
      return `Onboarded ${biz}` + (str(d.planName) ?? str(d.plan) ? ` on ${str(d.planName) ?? str(d.plan)}` : '')
    case 'console.tenant.updated':
      return `Edited the details of ${biz}`
    case 'console.tenant.suspended':
    case 'billing.suspended':
      return `Suspended ${biz}` + tail(reason ?? (invoice ? `Unpaid invoice ${invoice}` : null))
    case 'console.tenant.reactivated':
    case 'billing.reactivated':
      return `Reactivated ${biz}`
    case 'console.tenant.pin_reset':
      return `Reset the owner PIN of ${str(subjectName) ?? str(d.ownerName) ?? str(d.username) ?? 'an owner'} at ${biz}`
    case 'console.tenant.signed_out':
      return `Signed out all staff of ${biz}`
    case 'console.note.added':
      return `Added a note on ${biz}`
    case 'console.note.deleted':
      return `Deleted a note on ${biz}`

    case 'console.plan.created':
      return `Created the plan ${plan ?? ''}`.trim()
    case 'console.plan.updated':
      return `Edited the plan ${plan ?? ''}`.trim()
    case 'console.plan.archived':
      return `Archived the plan ${plan ?? ''}`.trim()
    case 'console.plan.unarchived':
      return `Brought back the plan ${plan ?? ''}`.trim()

    case 'console.subscription.plan_changed':
      return `Moved ${biz} to ${plan ? `the ${plan} plan` : 'another plan'}`
    case 'console.subscription.terms_changed': {
      const parts: string[] = []
      if (num(d.discountBps) != null) parts.push(`discount ${percent(num(d.discountBps)!)}`)
      if (num(d.customPriceCents) != null) parts.push(`agreed price ${money(num(d.customPriceCents)!)}`)
      else if (d.customPriceCents === null) parts.push('no agreed price')
      return `Changed the terms of ${biz}` + (parts.length ? `: ${parts.join(', ')}` : '')
    }
    case 'console.subscription.trial_extended':
      return `Extended the trial of ${biz}` + (num(d.days) != null ? ` by ${num(d.days)} day${num(d.days) === 1 ? '' : 's'}` : '')
    case 'console.subscription.cancelled':
    case 'billing.cancelled':
      return `Cancelled the subscription of ${biz}` + tail(reason)
    case 'console.subscription.cancel_scheduled':
      return `Set ${biz} to cancel at the end of the period` + tail(reason)
    case 'console.subscription.resumed':
      return `Resumed the subscription of ${biz}`

    case 'console.invoice.created':
      return `Raised ${inv}${forAmount} to ${biz}`
    case 'billing.invoice_created':
      return `Billed ${biz}: ${inv}${forAmount}`
    case 'console.invoice.payment_recorded':
      return `Recorded a payment${num(d.amountCents) != null ? ` of ${money(num(d.amountCents)!)}` : ''} on ${inv} from ${biz}`
    case 'console.invoice.voided':
      return `Voided ${inv} of ${biz}` + tail(reason)
    case 'console.billing.run': {
      const n = num(d.invoicesCreated)
      return 'Ran billing' + (n != null ? `: ${n} invoice${n === 1 ? '' : 's'} raised` : '')
    }
    case 'billing.trial_converted':
      return `Trial ended for ${biz}, now a paying client`
    case 'billing.period_advanced':
      return `Started a new billing period for ${biz}`
    case 'billing.past_due':
      return `Marked ${biz} past due` + tail(invoice ? `Unpaid invoice ${invoice}` : reason)
  }
  // anything else (mostly shop actions): the action itself in words
  const where = str(businessName) ?? str(d.businessName)
  return readable(action) + (where ? ` at ${where}` : '')
}

export type AuditEntry = {
  id: string
  at: Date
  action: string
  group: AuditGroup
  summary: string
  actor: { id: string | null; name: string; kind: 'platform' | 'shop' | 'system' }
  business: { id: string; name: string } | null
  entity: string
  entityId: string | null
  data: unknown
}

// Audit rows in the shape every console screen shows them: actor and client
// names resolved in two queries, BigInt ids as strings.
export async function shapeAuditRows(rows: AuditLog[]): Promise<AuditEntry[]> {
  const subjectId = (r: AuditLog) => (r.entity.toLowerCase() === 'user' ? r.entityId : null)
  const userIds = [...new Set(rows.flatMap(r => [r.userId, subjectId(r)]).filter((v): v is string => !!v))]
  const businessIds = [...new Set(rows.map(r => r.businessId).filter((v): v is string => !!v))]
  const [users, businesses] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, platformRole: true } })
      : [],
    businessIds.length ? prisma.business.findMany({ where: { id: { in: businessIds } }, select: { id: true, name: true } }) : []
  ])
  const userById = new Map(users.map(u => [u.id, u]))
  const businessById = new Map(businesses.map(b => [b.id, b]))

  return rows.map(r => {
    const user = r.userId ? userById.get(r.userId) : null
    const business = r.businessId ? businessById.get(r.businessId) ?? null : null
    const subject = subjectId(r)
    const actor: AuditEntry['actor'] = !r.userId
      ? { id: null, name: 'System', kind: 'system' }
      : { id: r.userId, name: user?.name ?? 'Removed user', kind: user?.platformRole ? 'platform' : 'shop' }
    return {
      id: r.id.toString(),
      at: r.at,
      action: r.action,
      group: groupOf(r.action),
      summary: auditSummary(r.action, r.data, business?.name, subject ? userById.get(subject)?.name : null),
      actor,
      business: business ? { id: business.id, name: business.name } : null,
      entity: r.entity,
      entityId: r.entityId,
      data: r.data ?? null
    }
  })
}

// Filters arrive from a form, so an empty value means "not set".
const blank = <T extends z.ZodType>(rule: T) => z.preprocess(v => (v === '' ? undefined : v), rule.optional())

const listQuery = z.object({
  from: blank(z.string().max(40)),
  to: blank(z.string().max(40)),
  userId: blank(idRule),
  businessId: blank(idRule),
  group: blank(z.enum(AUDIT_GROUPS)),
  before: blank(z.string().regex(/^\d{1,18}$/, 'Not a valid cursor')),
  limit: paging.limit
})

// A day (YYYY-MM-DD) is a Nairobi day, so `to` covers that whole day. A full
// timestamp is taken as given.
function instant(value: string, field: 'from' | 'to'): Date {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const at = new Date(day ? `${value}T00:00:00+03:00` : value)
  if (Number.isNaN(at.getTime())) throw badRequest(`"${field}" is not a date. Use YYYY-MM-DD.`)
  if (field === 'from') return at
  return new Date(at.getTime() + (day ? DAY_MS : 1))
}

auditRoutes.get('/audit', async c => {
  const q = query(c, listQuery)
  const and: Prisma.AuditLogWhereInput[] = []
  if (q.from) and.push({ at: { gte: instant(q.from, 'from') } })
  if (q.to) and.push({ at: { lt: instant(q.to, 'to') } })
  // "system" picks what the platform did by itself (billing runs, failed sign ins)
  if (q.userId) and.push({ userId: q.userId === 'system' ? null : q.userId })
  if (q.businessId) and.push({ businessId: q.businessId })
  if (q.group) and.push(groupWhere(q.group))
  if (q.before) and.push({ id: { lt: BigInt(q.before) } })

  const rows = await prisma.auditLog.findMany({ where: { AND: and }, orderBy: { id: 'desc' }, take: q.limit + 1 })
  const page = rows.slice(0, q.limit)
  const entries = await shapeAuditRows(page)
  // pass nextBefore back as `before` for the next page, null on the last one
  return c.json({ entries, nextBefore: rows.length > q.limit ? page[page.length - 1]!.id.toString() : null })
})
