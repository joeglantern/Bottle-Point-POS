import { Hono } from 'hono'
import { prisma, type Invoice, type Plan } from '../../db.js'
import { env } from '../../env.js'
import { notFound } from '../../lib/errors.js'
import { requireRole, type AppEnv } from '../../middleware/auth.js'
import { billedInArrears, describePrice, periodEnd, priceFor } from '../../rules/pricing.js'
import { salesCentsBetween, usageFor } from '../../rules/usage.js'

// Mounted at /api/admin by ../settings.ts. Paths here are relative to /api/admin.
// Everything under /billing stays reachable while the shop is suspended, so
// the owner can see what is owed.
export const billingRoutes = new Hono<AppEnv>()

const DAY_MS = 24 * 60 * 60 * 1000
const owner = requireRole('OWNER')

const limitsOf = (p: Plan) => ({ maxBranches: p.maxBranches, maxStaff: p.maxStaff, maxProducts: p.maxProducts })

// Only an open invoice can be owed or late: drafts are not issued yet and
// void ones were withdrawn.
const balanceOf = (i: Pick<Invoice, 'status' | 'totalCents' | 'paidCents'>) => (i.status === 'OPEN' ? Math.max(0, i.totalCents - i.paidCents) : 0)
const isOverdue = (i: Pick<Invoice, 'status' | 'totalCents' | 'paidCents' | 'dueAt'>, now: Date) =>
  balanceOf(i) > 0 && i.dueAt.getTime() < now.getTime()

// The banner in the POS: every role may ask, and it says nothing about money.
billingRoutes.get('/billing/status', async c => {
  const actor = c.get('actor')
  const sub = await prisma.subscription.findUnique({
    where: { businessId: actor.businessId },
    select: { status: true, suspendedReason: true, trialEndsAt: true }
  })
  if (!sub) return c.json({ status: 'NONE', suspendedReason: null, trialEndsAt: null, daysLeftInTrial: null })
  const daysLeftInTrial =
    sub.status === 'TRIALING' && sub.trialEndsAt ? Math.max(0, Math.ceil((sub.trialEndsAt.getTime() - Date.now()) / DAY_MS)) : null
  return c.json({ status: sub.status, suspendedReason: sub.suspendedReason, trialEndsAt: sub.trialEndsAt, daysLeftInTrial })
})

// What else is on offer. Changing plan goes through support for now.
billingRoutes.get('/billing/plans', owner, async c => {
  const actor = c.get('actor')
  const [plans, sub] = await Promise.all([
    prisma.plan.findMany({ where: { active: true, public: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    prisma.subscription.findUnique({ where: { businessId: actor.businessId }, select: { planId: true } })
  ])
  return c.json({
    plans: plans.map(p => ({
      code: p.code,
      name: p.name,
      description: p.description,
      model: p.model,
      interval: p.interval,
      priceText: describePrice(p),
      trialDays: p.trialDays,
      limits: limitsOf(p),
      features: p.features,
      current: p.id === sub?.planId
    }))
  })
})

billingRoutes.get('/billing/invoices/:id', owner, async c => {
  const actor = c.get('actor')
  const inv = await prisma.invoice.findFirst({
    where: { id: c.req.param('id'), businessId: actor.businessId, status: { not: 'DRAFT' } },
    include: {
      payments: { orderBy: { receivedAt: 'asc' } },
      business: { select: { name: true, legalName: true, address: true, kraPin: true, email: true, phone: true } }
    }
  })
  if (!inv) throw notFound('Invoice')
  return c.json({
    invoice: {
      id: inv.id,
      number: inv.number,
      status: inv.status,
      issuedAt: inv.issuedAt,
      dueAt: inv.dueAt,
      periodStart: inv.periodStart,
      periodEnd: inv.periodEnd,
      lines: inv.lines,
      subtotalCents: inv.subtotalCents,
      taxCents: inv.taxCents,
      totalCents: inv.totalCents,
      paidCents: inv.paidCents,
      balanceCents: balanceOf(inv),
      overdue: isOverdue(inv, new Date()),
      paidAt: inv.paidAt,
      voidedAt: inv.voidedAt,
      // who at Bottle Point recorded a payment is not the client's business
      payments: inv.payments.map(p => ({ id: p.id, amountCents: p.amountCents, method: p.method, reference: p.reference, receivedAt: p.receivedAt })),
      client: inv.business
    }
  })
})

billingRoutes.get('/billing', owner, async c => {
  const actor = c.get('actor')
  const businessId = actor.businessId
  const now = new Date()
  const [sub, usage, invoices, owed] = await Promise.all([
    prisma.subscription.findUnique({ where: { businessId }, include: { plan: true } }),
    usageFor(prisma, businessId),
    prisma.invoice.findMany({
      where: { businessId, status: { not: 'DRAFT' } },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take: 24
    }),
    prisma.invoice.findMany({ where: { businessId, status: 'OPEN' }, select: { status: true, totalCents: true, paidCents: true } })
  ])

  // Mirrors the billing run: a trial turns into the first paid period at the
  // trial end, share of sales is billed after the period and the rest before
  // it. Nothing more is billed once suspended, cancelled or ending, and a one
  // time licence is only billed once, when its trial ends.
  let nextInvoice = null
  const plan = sub?.plan ?? null
  const trialing = sub?.status === 'TRIALING'
  const billable = sub && (trialing || sub.status === 'ACTIVE' || sub.status === 'PAST_DUE') && !sub.cancelAtPeriodEnd
  if (sub && plan && billable && (plan.interval !== 'ONCE' || trialing)) {
    const fixed = sub.customPriceCents != null
    const trialEnd = sub.trialEndsAt ?? sub.currentPeriodEnd
    if (billedInArrears(plan)) {
      // billed at the end of the period on what was sold in it
      const start = trialing ? trialEnd : sub.currentPeriodStart
      const end = trialing ? periodEnd(trialEnd, plan.interval) : sub.currentPeriodEnd
      const until = now.getTime() < end.getTime() ? now : end
      const salesCents = until.getTime() > start.getTime() ? await salesCentsBetween(prisma, businessId, start, until) : 0
      nextInvoice = {
        periodStart: start,
        periodEnd: end,
        issuedOn: end,
        ...priceFor(plan, sub, { branches: usage.branches, salesCents }, env.PLATFORM_VAT_BPS),
        salesCents,
        isEstimate: !fixed,
        note: fixed
          ? null
          : trialing
            ? 'Estimate. The first billed period starts when the trial ends, and the invoice is worked out on the sales of that whole period.'
            : 'Estimate from sales so far in this period. The invoice is worked out on the sales of the whole period once it ends.'
      }
    } else {
      const start = trialing ? trialEnd : sub.currentPeriodEnd
      const perBranch = plan.model === 'PER_BRANCH' && !fixed
      nextInvoice = {
        periodStart: start,
        periodEnd: periodEnd(start, plan.interval),
        issuedOn: start,
        ...priceFor(plan, sub, { branches: usage.branches, salesCents: 0 }, env.PLATFORM_VAT_BPS),
        salesCents: null,
        isEstimate: perBranch,
        note: perBranch ? 'Estimate from the branches open today. The invoice counts the branches open on the day it is raised.' : null
      }
    }
  }

  return c.json({
    subscription: sub && {
      status: sub.status,
      trialEndsAt: sub.trialEndsAt,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      suspendedReason: sub.suspendedReason,
      discountBps: sub.discountBps
    },
    plan: plan && { name: plan.name, code: plan.code, priceText: describePrice(plan), limits: limitsOf(plan) },
    usage,
    nextInvoice,
    outstandingCents: owed.reduce((a, i) => a + balanceOf(i), 0),
    invoices: invoices.map(i => ({
      id: i.id,
      number: i.number,
      issuedAt: i.issuedAt,
      dueAt: i.dueAt,
      periodStart: i.periodStart,
      periodEnd: i.periodEnd,
      totalCents: i.totalCents,
      paidCents: i.paidCents,
      status: i.status,
      overdue: isOverdue(i, now)
    }))
  })
})
