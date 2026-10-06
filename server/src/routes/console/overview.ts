import { Hono } from 'hono'
import { z } from 'zod'
import { prisma, type SubscriptionStatus } from '../../db.js'
import { query } from '../../lib/validate.js'
import type { ConsoleEnv } from '../../middleware/platform.js'
import { DAY_MS, monthlyValue, nairobiMonthKey, nairobiMonthStart } from '../../rules/platform.js'

export const overviewRoutes = new Hono<ConsoleEnv>()

// A trial counts as ending soon inside this many days.
const TRIAL_SOON_DAYS = 7
const MONTHS = 12
const ATTENTION_MAX = 50
const SEARCH_MAX = 8

const num = (v: bigint | number | null | undefined) => Number(v ?? 0)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

type CentsRow = { businessId: string; cents: bigint }
type MonthRow = { month: string; cents: bigint; n: number }

// Recurring revenue: one row per paying subscription, priced through the
// shared rules. Branch counts and 30 day sales come from two grouped queries.
async function recurring(now: Date) {
  const since = new Date(now.getTime() - 30 * DAY_MS)
  const [subs, branchRows, saleRows, refundRows] = await Promise.all([
    prisma.subscription.findMany({ where: { status: { in: ['ACTIVE', 'PAST_DUE'] } }, include: { plan: true } }),
    prisma.$queryRaw<{ businessId: string; n: number }[]>`
      SELECT "businessId", COUNT(*)::int AS "n" FROM "Branch" WHERE "active" GROUP BY "businessId"`,
    prisma.$queryRaw<CentsRow[]>`
      SELECT b."businessId", COALESCE(SUM(s."totalCents"), 0)::bigint AS "cents"
      FROM "Sale" s JOIN "Branch" b ON b."id" = s."branchId"
      WHERE s."status" IN ('PAID', 'REFUNDED') AND s."paidAt" >= ${since}::timestamp AND s."paidAt" < ${now}::timestamp
      GROUP BY b."businessId"`,
    prisma.$queryRaw<CentsRow[]>`
      SELECT b."businessId", COALESCE(SUM(r."amountCents"), 0)::bigint AS "cents"
      FROM "Refund" r JOIN "Sale" s ON s."id" = r."saleId" JOIN "Branch" b ON b."id" = s."branchId"
      WHERE r."createdAt" >= ${since}::timestamp AND r."createdAt" < ${now}::timestamp
      GROUP BY b."businessId"`
  ])
  const branches = new Map(branchRows.map(r => [r.businessId, r.n]))
  const sales = new Map(saleRows.map(r => [r.businessId, num(r.cents)]))
  for (const r of refundRows) sales.set(r.businessId, (sales.get(r.businessId) ?? 0) - num(r.cents))

  let mrrCents = 0
  const byPlan = new Map<string, number>()
  for (const sub of subs) {
    const value = monthlyValue(sub, branches.get(sub.businessId) ?? 0, sales.get(sub.businessId) ?? 0)
    mrrCents += value
    byPlan.set(sub.planId, (byPlan.get(sub.planId) ?? 0) + value)
  }
  return { mrrCents, byPlan }
}

// The last 12 Nairobi months, oldest first, as "YYYY-MM".
const monthKeys = (now: Date) => Array.from({ length: MONTHS }, (_, i) => nairobiMonthKey(nairobiMonthStart(now, i - (MONTHS - 1))))

async function byMonth(now: Date) {
  const from = nairobiMonthStart(now, -(MONTHS - 1))
  const to = nairobiMonthStart(now, 1)
  // timestamps are stored in UTC: shift three hours to group by Nairobi month
  const [invoiced, collected, sold, refunded] = await Promise.all([
    prisma.$queryRaw<MonthRow[]>`
      SELECT to_char("issuedAt" + interval '3 hours', 'YYYY-MM') AS "month",
             COALESCE(SUM("totalCents"), 0)::bigint AS "cents", COUNT(*)::int AS "n"
      FROM "Invoice"
      WHERE "status" IN ('OPEN', 'PAID') AND "issuedAt" >= ${from}::timestamp AND "issuedAt" < ${to}::timestamp
      GROUP BY 1`,
    prisma.$queryRaw<MonthRow[]>`
      SELECT to_char("receivedAt" + interval '3 hours', 'YYYY-MM') AS "month",
             COALESCE(SUM("amountCents"), 0)::bigint AS "cents", COUNT(*)::int AS "n"
      FROM "InvoicePayment"
      WHERE "receivedAt" >= ${from}::timestamp AND "receivedAt" < ${to}::timestamp
      GROUP BY 1`,
    prisma.$queryRaw<MonthRow[]>`
      SELECT to_char("paidAt" + interval '3 hours', 'YYYY-MM') AS "month",
             COALESCE(SUM("totalCents"), 0)::bigint AS "cents", COUNT(*)::int AS "n"
      FROM "Sale"
      WHERE "status" IN ('PAID', 'REFUNDED') AND "paidAt" >= ${from}::timestamp AND "paidAt" < ${to}::timestamp
      GROUP BY 1`,
    prisma.$queryRaw<MonthRow[]>`
      SELECT to_char("createdAt" + interval '3 hours', 'YYYY-MM') AS "month",
             COALESCE(SUM("amountCents"), 0)::bigint AS "cents", COUNT(*)::int AS "n"
      FROM "Refund"
      WHERE "createdAt" >= ${from}::timestamp AND "createdAt" < ${to}::timestamp
      GROUP BY 1`
  ])
  const map = (rows: MonthRow[]) => new Map(rows.map(r => [r.month, r]))
  const [inv, col, sal, ref] = [map(invoiced), map(collected), map(sold), map(refunded)]
  const keys = monthKeys(now)
  return {
    revenueByMonth: keys.map(month => ({
      month,
      invoicedCents: num(inv.get(month)?.cents),
      collectedCents: num(col.get(month)?.cents)
    })),
    salesByMonth: keys.map(month => ({
      month,
      salesCents: num(sal.get(month)?.cents) - num(ref.get(month)?.cents),
      salesCount: sal.get(month)?.n ?? 0
    }))
  }
}

type Attention = {
  kind: 'past_due' | 'suspended' | 'trial_ending'
  businessId: string
  name: string
  status: SubscriptionStatus
  reason: string
  at: Date | null
  amountCents: number | null
}

const trialReason = (endsAt: Date, now: Date) => {
  const days = Math.ceil((endsAt.getTime() - now.getTime()) / DAY_MS)
  return days <= 0 ? 'Trial has ended' : `Trial ends in ${plural(days, 'day')}`
}

// Clients someone should look at: behind on payment, switched off, or about
// to come out of a trial.
async function attentionList(now: Date) {
  const soon = new Date(now.getTime() + TRIAL_SOON_DAYS * DAY_MS)
  const pick = { business: { select: { id: true, name: true } }, plan: { select: { id: true, name: true } } }
  const [pastDue, suspended, trials, overdue] = await Promise.all([
    prisma.subscription.findMany({ where: { status: 'PAST_DUE' }, include: pick, orderBy: { updatedAt: 'asc' }, take: ATTENTION_MAX }),
    prisma.subscription.findMany({ where: { status: 'SUSPENDED' }, include: pick, orderBy: { suspendedAt: 'desc' }, take: ATTENTION_MAX }),
    prisma.subscription.findMany({
      where: { status: 'TRIALING', trialEndsAt: { lte: soon } },
      include: pick,
      orderBy: { trialEndsAt: 'asc' },
      take: ATTENTION_MAX
    }),
    // per client: how much is overdue, and the oldest overdue invoice
    prisma.$queryRaw<{ businessId: string; cents: bigint; n: number; number: string; dueAt: Date }[]>`
      SELECT i."businessId",
             SUM(i."totalCents" - i."paidCents")::bigint AS "cents",
             COUNT(*)::int AS "n",
             (ARRAY_AGG(i."number" ORDER BY i."dueAt", i."number"))[1] AS "number",
             MIN(i."dueAt") AS "dueAt"
      FROM "Invoice" i JOIN "Subscription" s ON s."businessId" = i."businessId"
      WHERE i."status" = 'OPEN' AND i."dueAt" < ${now}::timestamp AND s."status" = 'PAST_DUE'
      GROUP BY i."businessId"`
  ])
  const owed = new Map(overdue.map(r => [r.businessId, r]))
  const attention: Attention[] = []
  for (const s of pastDue) {
    const o = owed.get(s.businessId)
    const days = o ? Math.floor((now.getTime() - o.dueAt.getTime()) / DAY_MS) : 0
    const late = days >= 1 ? `${plural(days, 'day')} overdue` : 'overdue'
    attention.push({
      kind: 'past_due',
      businessId: s.businessId,
      name: s.business.name,
      status: s.status,
      reason: !o ? 'Payment is overdue' : o.n > 1 ? `${o.n} invoices overdue, oldest ${o.number} is ${late}` : `Invoice ${o.number} is ${late}`,
      at: o?.dueAt ?? null,
      amountCents: o ? num(o.cents) : null
    })
  }
  for (const s of suspended) {
    attention.push({
      kind: 'suspended',
      businessId: s.businessId,
      name: s.business.name,
      status: s.status,
      reason: s.suspendedReason ? `Suspended: ${s.suspendedReason}` : 'Suspended',
      at: s.suspendedAt,
      amountCents: null
    })
  }
  for (const s of trials) {
    attention.push({
      kind: 'trial_ending',
      businessId: s.businessId,
      name: s.business.name,
      status: s.status,
      reason: trialReason(s.trialEndsAt ?? s.currentPeriodEnd, now),
      at: s.trialEndsAt,
      amountCents: null
    })
  }
  const trialsEndingSoon = trials.map(s => ({
    businessId: s.businessId,
    name: s.business.name,
    plan: s.plan,
    trialEndsAt: s.trialEndsAt,
    daysLeft: Math.max(0, Math.ceil(((s.trialEndsAt ?? s.currentPeriodEnd).getTime() - now.getTime()) / DAY_MS))
  }))
  return { attention, trialsEndingSoon }
}

// "console.tenant.suspended" reads as "Tenant suspended". The full audit
// page has richer wording: this is only the dashboard strip.
function summarise(action: string, data: unknown, businessName: string | null): string {
  const parts = action.split('.')
  if (parts.length > 1 && (parts[0] === 'console' || parts[0] === 'billing')) parts.shift()
  const words = parts.join(' ').replace(/_/g, ' ').trim() || action
  const d = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {}
  const number = typeof d.number === 'string' ? ` ${d.number}` : ''
  const who = businessName ?? (typeof d.businessName === 'string' ? d.businessName : null)
  return words.charAt(0).toUpperCase() + words.slice(1) + number + (who ? `: ${who}` : '')
}

async function recentActivity() {
  const rows = await prisma.auditLog.findMany({ orderBy: { id: 'desc' }, take: 10 })
  const userIds = [...new Set(rows.map(r => r.userId).filter((v): v is string => !!v))]
  const businessIds = [...new Set(rows.map(r => r.businessId).filter((v): v is string => !!v))]
  const [users, businesses] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, platformRole: true } })
      : [],
    businessIds.length ? prisma.business.findMany({ where: { id: { in: businessIds } }, select: { id: true, name: true } }) : []
  ])
  const userOf = new Map(users.map(u => [u.id, u]))
  const businessOf = new Map(businesses.map(b => [b.id, b]))
  return rows.map(r => {
    const u = r.userId ? userOf.get(r.userId) : undefined
    const business = r.businessId ? businessOf.get(r.businessId) ?? null : null
    return {
      id: r.id.toString(),
      at: r.at,
      action: r.action,
      summary: summarise(r.action, r.data, business?.name ?? null),
      actor: !r.userId
        ? { id: null, name: 'System', kind: 'system' as const }
        : { id: r.userId, name: u?.name ?? 'Removed user', kind: u?.platformRole ? ('platform' as const) : ('shop' as const) },
      business
    }
  })
}

// Dashboard figures. Any console role may read them.
overviewRoutes.get('/overview', async c => {
  const now = new Date()
  const monthStart = nairobiMonthStart(now)
  const nextMonth = nairobiMonthStart(now, 1)

  const [rec, months, lists, activity, statusRows, noSubscription, open, collected, newClientsThisMonth, churnedThisMonth, plans, planRows] =
    await Promise.all([
      recurring(now),
      byMonth(now),
      attentionList(now),
      recentActivity(),
      prisma.subscription.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.business.count({ where: { subscription: null } }),
      prisma.$queryRaw<{ outstanding: bigint; n: number; overdue: bigint; overdueN: number }[]>`
        SELECT COALESCE(SUM("totalCents" - "paidCents"), 0)::bigint AS "outstanding",
               COUNT(*)::int AS "n",
               COALESCE(SUM("totalCents" - "paidCents") FILTER (WHERE "dueAt" < ${now}::timestamp), 0)::bigint AS "overdue",
               (COUNT(*) FILTER (WHERE "dueAt" < ${now}::timestamp))::int AS "overdueN"
        FROM "Invoice" WHERE "status" = 'OPEN'`,
      prisma.invoicePayment.aggregate({ where: { receivedAt: { gte: monthStart, lt: nextMonth } }, _sum: { amountCents: true } }),
      prisma.business.count({ where: { createdAt: { gte: monthStart, lt: nextMonth } } }),
      prisma.subscription.count({ where: { status: 'CANCELLED', cancelledAt: { gte: monthStart, lt: nextMonth } } }),
      prisma.plan.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, code: true, name: true, active: true } }),
      prisma.subscription.groupBy({ by: ['planId'], where: { status: { not: 'CANCELLED' } }, _count: { _all: true } })
    ])

  const counts = { TRIALING: 0, ACTIVE: 0, PAST_DUE: 0, SUSPENDED: 0, CANCELLED: 0, NONE: noSubscription, total: noSubscription }
  for (const r of statusRows) {
    counts[r.status] = r._count._all
    counts.total += r._count._all
  }

  const clientsOn = new Map(planRows.map(r => [r.planId, r._count._all]))
  const planMix = plans
    // archived plans only matter while someone is still on them
    .filter(p => p.active || clientsOn.has(p.id))
    .map(p => ({ planId: p.id, code: p.code, name: p.name, clients: clientsOn.get(p.id) ?? 0, mrrCents: rec.byPlan.get(p.id) ?? 0 }))

  const totals = open[0]
  return c.json({
    overview: {
      generatedAt: now,
      mrrCents: rec.mrrCents,
      arrCents: rec.mrrCents * 12,
      counts,
      trialsEndingSoon: lists.trialsEndingSoon,
      outstandingCents: num(totals?.outstanding),
      outstandingCount: totals?.n ?? 0,
      overdueCents: num(totals?.overdue),
      overdueCount: totals?.overdueN ?? 0,
      collectedThisMonthCents: collected._sum.amountCents ?? 0,
      newClientsThisMonth,
      churnedThisMonth,
      revenueByMonth: months.revenueByMonth,
      salesByMonth: months.salesByMonth,
      planMix,
      attention: lists.attention,
      recentActivity: activity
    }
  })
})

// The search box in the console header: clients and invoices, a few of each.
overviewRoutes.get('/search', async c => {
  const { q } = query(c, z.object({ q: z.string().trim().max(100).default('') }))
  if (!q) return c.json({ tenants: [], invoices: [] })
  const now = new Date()
  // LIKE wildcards typed by the user are plain text, not patterns
  const like = q.replace(/[\\%_]/g, '\\$&')
  const [tenants, invoices] = await Promise.all([
    prisma.business.findMany({
      where: {
        OR: [
          { id: q },
          { name: { contains: like, mode: 'insensitive' } },
          { users: { some: { role: 'OWNER', username: { contains: like.toLowerCase() } } } }
        ]
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: SEARCH_MAX,
      select: {
        id: true,
        name: true,
        subscription: { select: { status: true, plan: { select: { id: true, name: true } } } },
        users: { where: { role: 'OWNER' }, select: { name: true, username: true }, orderBy: { createdAt: 'asc' }, take: 3 }
      }
    }),
    prisma.invoice.findMany({
      where: { number: { contains: like, mode: 'insensitive' } },
      orderBy: [{ issuedAt: 'desc' }, { number: 'desc' }],
      take: SEARCH_MAX,
      select: {
        id: true,
        number: true,
        businessId: true,
        status: true,
        totalCents: true,
        paidCents: true,
        issuedAt: true,
        dueAt: true,
        business: { select: { name: true } }
      }
    })
  ])
  return c.json({
    tenants: tenants.map(t => ({
      id: t.id,
      name: t.name,
      status: t.subscription?.status ?? 'NONE',
      plan: t.subscription?.plan ?? null,
      owners: t.users
    })),
    invoices: invoices.map(i => ({
      id: i.id,
      number: i.number,
      businessId: i.businessId,
      businessName: i.business.name,
      status: i.status,
      overdue: i.status === 'OPEN' && i.dueAt < now,
      totalCents: i.totalCents,
      paidCents: i.paidCents,
      balanceCents: i.totalCents - i.paidCents,
      issuedAt: i.issuedAt,
      dueAt: i.dueAt
    }))
  })
})
