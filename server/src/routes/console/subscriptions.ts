import { Hono } from 'hono'
import { z } from 'zod'
import { prisma, type Invoice, type Tx } from '../../db.js'
import { platformAudit } from '../../lib/audit.js'
import { AppError, badRequest, notFound, unprocessable } from '../../lib/errors.js'
import { body, cents, id, query } from '../../lib/validate.js'
import { allowPlatform, type ConsoleEnv } from '../../middleware/platform.js'
import {
  DAY_MS,
  estimateNextInvoice,
  hasOverdueInvoice,
  lockSubscription,
  paging,
  raiseSubscriptionInvoice,
  type SubWithPlan
} from '../../rules/platform.js'
import { billedInArrears, periodEnd } from '../../rules/pricing.js'
import { usageFor } from '../../rules/usage.js'

export const subscriptionRoutes = new Hono<ConsoleEnv>()

// One shape for every subscription this file returns.
async function view(sub: SubWithPlan, businessName: string, now = new Date()) {
  const next = await estimateNextInvoice(prisma, sub, now)
  return {
    id: sub.id,
    businessId: sub.businessId,
    businessName,
    plan: { id: sub.plan.id, code: sub.plan.code, name: sub.plan.name, model: sub.plan.model, interval: sub.plan.interval },
    status: sub.status,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    trialEndsAt: sub.trialEndsAt,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    cancelledAt: sub.cancelledAt,
    discountBps: sub.discountBps,
    customPriceCents: sub.customPriceCents,
    suspendedReason: sub.suspendedReason,
    suspendedAt: sub.suspendedAt,
    createdAt: sub.createdAt,
    nextAmountCents: next ? next.totalCents : null,
    nextInvoiceAt: next ? next.issueAt : null
  }
}

const invoiceRef = (invoice: Invoice | null) =>
  invoice ? { id: invoice.id, number: invoice.number, totalCents: invoice.totalCents, status: invoice.status, dueAt: invoice.dueAt } : null

// Lock the client, then its subscription, so two console users changing the
// same client queue up instead of overwriting each other.
async function lockClient(tx: Tx, businessId: string) {
  const rows = await tx.$queryRaw<{ id: string; name: string }[]>`
    SELECT "id", "name" FROM "Business" WHERE "id" = ${businessId} FOR UPDATE`
  const business = rows[0]
  if (!business) throw notFound('Client')
  return { business, sub: await lockSubscription(tx, businessId) }
}

async function lockExisting(tx: Tx, businessId: string) {
  const { business, sub } = await lockClient(tx, businessId)
  if (!sub) throw unprocessable('This client has no subscription yet. Put it on a plan first.', 'no_subscription')
  return { business, sub }
}

const reload = async (tx: Tx, businessId: string) =>
  (await tx.subscription.findUnique({ where: { businessId }, include: { plan: true } }))!

subscriptionRoutes.get('/subscriptions', async c => {
  const q = query(
    c,
    z.object({
      ...paging,
      status: z.enum(['TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED']).optional(),
      planId: id.optional(),
      q: z.string().trim().max(100).optional()
    })
  )
  const where = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.planId ? { planId: q.planId } : {}),
    ...(q.q ? { business: { name: { contains: q.q, mode: 'insensitive' as const } } } : {})
  }
  const [rows, total] = await Promise.all([
    prisma.subscription.findMany({
      where,
      include: { plan: true, business: { select: { name: true } } },
      orderBy: [{ business: { name: 'asc' } }, { id: 'asc' }],
      take: q.limit,
      skip: q.offset
    }),
    prisma.subscription.count({ where })
  ])
  const now = new Date()
  const subscriptions = await Promise.all(rows.map(({ business, ...sub }) => view(sub, business.name, now)))
  return c.json({ subscriptions, total })
})

// Change plan now. The period dates stay, so the next invoice is the first
// one priced on the new plan.
subscriptionRoutes.post('/tenants/:id/subscription/plan', allowPlatform('BILLING'), async c => {
  const platform = c.get('platform')
  const businessId = c.req.param('id')
  const input = await body(c, z.object({ planId: id, force: z.boolean().default(false) }))
  const now = new Date()
  const out = await prisma.$transaction(async tx => {
    const { business, sub } = await lockClient(tx, businessId)
    const plan = await tx.plan.findUnique({ where: { id: input.planId } })
    if (!plan) throw notFound('Plan')
    if (sub?.status === 'CANCELLED') {
      throw unprocessable('This subscription is cancelled. Resume it before changing its plan.', 'subscription_cancelled')
    }
    if (sub?.planId === plan.id) throw unprocessable(`This client is already on ${plan.name}.`, 'same_plan')
    if (!plan.active) throw unprocessable(`${plan.name} is archived and cannot be given to a client.`, 'plan_archived')

    const usage = await usageFor(tx, businessId)
    const over = (
      [
        ['branches', usage.branches, plan.maxBranches],
        ['staff', usage.staff, plan.maxStaff],
        ['products', usage.products, plan.maxProducts]
      ] as const
    )
      .filter(([, used, max]) => max != null && used > max)
      .map(([what, used, max]) => ({ what, used, max: max as number }))
    if (over.length && !input.force) {
      throw new AppError(
        422,
        'over_plan_limits',
        `${business.name} uses more than ${plan.name} allows: ${over.map(o => `${o.used} ${o.what} (limit ${o.max})`).join(', ')}.`,
        { over, usage, limits: { maxBranches: plan.maxBranches, maxStaff: plan.maxStaff, maxProducts: plan.maxProducts } }
      )
    }

    let invoice: Invoice | null = null
    if (!sub) {
      const created = await tx.subscription.create({
        data: {
          businessId,
          planId: plan.id,
          status: 'ACTIVE',
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd(now, plan.interval)
        },
        include: { plan: true }
      })
      // in advance plans are paid before the period, so the first one is due now
      if (!billedInArrears(plan)) {
        invoice = await raiseSubscriptionInvoice(tx, created, created.currentPeriodStart, created.currentPeriodEnd, now)
      }
    } else {
      // Moving to or from a one time licence cannot keep the dates: a licence
      // period runs a century, a monthly one a month. Start a fresh period.
      const paying = sub.status === 'ACTIVE' || sub.status === 'PAST_DUE'
      const restart = paying && (sub.plan.interval === 'ONCE') !== (plan.interval === 'ONCE')
      const updated = await tx.subscription.update({
        where: { id: sub.id },
        data: {
          planId: plan.id,
          ...(restart ? { currentPeriodStart: now, currentPeriodEnd: periodEnd(now, plan.interval) } : {})
        },
        include: { plan: true }
      })
      if (restart && !billedInArrears(plan)) {
        invoice = await raiseSubscriptionInvoice(tx, updated, updated.currentPeriodStart, updated.currentPeriodEnd, now)
      }
    }
    await platformAudit(
      tx,
      platform,
      'console.subscription.plan_changed',
      'Subscription',
      (await reload(tx, businessId)).id,
      {
        businessName: business.name,
        fromPlan: sub?.plan.name ?? null,
        toPlan: plan.name,
        planName: plan.name,
        created: !sub,
        forced: over.length > 0,
        ...(over.length ? { over } : {}),
        ...(invoice ? { invoiceNumber: invoice.number } : {})
      },
      businessId
    )
    return { sub: await reload(tx, businessId), businessName: business.name, invoice }
  })
  return c.json({ subscription: await view(out.sub, out.businessName), invoice: invoiceRef(out.invoice) })
})

// A negotiated deal: a discount on the plan price, or a fixed price instead of it.
subscriptionRoutes.post('/tenants/:id/subscription/terms', allowPlatform('BILLING'), async c => {
  const platform = c.get('platform')
  const businessId = c.req.param('id')
  const input = await body(
    c,
    z.object({ discountBps: z.number().int().min(0).max(10_000).optional(), customPriceCents: cents.nullable().optional() })
  )
  if (input.discountBps === undefined && input.customPriceCents === undefined) {
    throw badRequest('Send discountBps, customPriceCents or both.')
  }
  const out = await prisma.$transaction(async tx => {
    const { business, sub } = await lockExisting(tx, businessId)
    const updated = await tx.subscription.update({
      where: { id: sub.id },
      data: {
        ...(input.discountBps !== undefined ? { discountBps: input.discountBps } : {}),
        ...(input.customPriceCents !== undefined ? { customPriceCents: input.customPriceCents } : {})
      },
      include: { plan: true }
    })
    await platformAudit(
      tx,
      platform,
      'console.subscription.terms_changed',
      'Subscription',
      sub.id,
      {
        businessName: business.name,
        planName: sub.plan.name,
        discountBps: { from: sub.discountBps, to: updated.discountBps },
        customPriceCents: { from: sub.customPriceCents, to: updated.customPriceCents }
      },
      businessId
    )
    return { sub: updated, businessName: business.name }
  })
  return c.json({ subscription: await view(out.sub, out.businessName) })
})

subscriptionRoutes.post('/tenants/:id/subscription/extend-trial', allowPlatform('SUPPORT', 'BILLING'), async c => {
  const platform = c.get('platform')
  const businessId = c.req.param('id')
  const input = await body(c, z.object({ days: z.number().int().min(1).max(90) }))
  const out = await prisma.$transaction(async tx => {
    const { business, sub } = await lockExisting(tx, businessId)
    if (sub.status !== 'TRIALING') throw unprocessable('Only a client that is still on trial can have it extended.', 'not_trialing')
    const from = sub.trialEndsAt ?? sub.currentPeriodEnd
    const trialEndsAt = new Date(from.getTime() + input.days * DAY_MS)
    const updated = await tx.subscription.update({
      where: { id: sub.id },
      // the trial is the current period, so both ends move together
      data: { trialEndsAt, currentPeriodEnd: trialEndsAt },
      include: { plan: true }
    })
    await platformAudit(
      tx,
      platform,
      'console.subscription.trial_extended',
      'Subscription',
      sub.id,
      { businessName: business.name, planName: sub.plan.name, days: input.days, from, to: trialEndsAt },
      businessId
    )
    return { sub: updated, businessName: business.name }
  })
  return c.json({ subscription: await view(out.sub, out.businessName) })
})

subscriptionRoutes.post('/tenants/:id/subscription/cancel', allowPlatform('BILLING'), async c => {
  const platform = c.get('platform')
  const businessId = c.req.param('id')
  const input = await body(c, z.object({ atPeriodEnd: z.boolean(), reason: z.string().trim().max(500).optional() }))
  const now = new Date()
  const out = await prisma.$transaction(async tx => {
    const { business, sub } = await lockExisting(tx, businessId)
    if (sub.status === 'CANCELLED') throw unprocessable('This subscription is already cancelled.', 'already_cancelled')
    // Only a paying client has a paid period to finish. The billing run
    // cancels it when that period ends instead of raising the next invoice.
    if (input.atPeriodEnd && sub.status !== 'ACTIVE' && sub.status !== 'PAST_DUE') {
      throw unprocessable('Only an active subscription can run to the end of its period. Cancel this one now instead.', 'invalid_state')
    }
    const updated = await tx.subscription.update({
      where: { id: sub.id },
      data: input.atPeriodEnd ? { cancelAtPeriodEnd: true } : { status: 'CANCELLED', cancelledAt: now, cancelAtPeriodEnd: false },
      include: { plan: true }
    })
    await platformAudit(
      tx,
      platform,
      input.atPeriodEnd ? 'console.subscription.cancel_scheduled' : 'console.subscription.cancelled',
      'Subscription',
      sub.id,
      {
        businessName: business.name,
        planName: sub.plan.name,
        reason: input.reason || null,
        previousStatus: sub.status,
        ...(input.atPeriodEnd ? { endsAt: sub.currentPeriodEnd } : {})
      },
      businessId
    )
    return { sub: updated, businessName: business.name }
  })
  return c.json({ subscription: await view(out.sub, out.businessName) })
})

// Undo a cancellation: either the one waiting for the period end, or one
// that already took effect.
subscriptionRoutes.post('/tenants/:id/subscription/resume', allowPlatform('BILLING'), async c => {
  const platform = c.get('platform')
  const businessId = c.req.param('id')
  const now = new Date()
  const out = await prisma.$transaction(async tx => {
    const { business, sub } = await lockExisting(tx, businessId)
    if (sub.status !== 'CANCELLED' && !sub.cancelAtPeriodEnd) {
      throw unprocessable('This subscription is not cancelled.', 'not_cancelled')
    }
    let invoice: Invoice | null = null
    if (sub.status !== 'CANCELLED') {
      await tx.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: false } })
    } else {
      // A period that was paid for and has not run out carries on. Otherwise
      // a new one starts now, and in advance plans are invoiced for it.
      const fresh = sub.currentPeriodEnd <= now
      const updated = await tx.subscription.update({
        where: { id: sub.id },
        data: {
          status: (await hasOverdueInvoice(tx, businessId, now)) ? 'PAST_DUE' : 'ACTIVE',
          cancelledAt: null,
          cancelAtPeriodEnd: false,
          trialEndsAt: null,
          ...(fresh ? { currentPeriodStart: now, currentPeriodEnd: periodEnd(now, sub.plan.interval) } : {})
        },
        include: { plan: true }
      })
      if (fresh && !billedInArrears(updated.plan)) {
        invoice = await raiseSubscriptionInvoice(tx, updated, updated.currentPeriodStart, updated.currentPeriodEnd, now)
      }
    }
    await platformAudit(
      tx,
      platform,
      'console.subscription.resumed',
      'Subscription',
      sub.id,
      {
        businessName: business.name,
        planName: sub.plan.name,
        previousStatus: sub.status,
        ...(invoice ? { invoiceNumber: invoice.number } : {})
      },
      businessId
    )
    return { sub: await reload(tx, businessId), businessName: business.name, invoice }
  })
  return c.json({ subscription: await view(out.sub, out.businessName), invoice: invoiceRef(out.invoice) })
})
