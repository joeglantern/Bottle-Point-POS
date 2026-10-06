// The billing engine. One run walks every subscription that needs something:
// trials that ended, periods that ended, and unpaid invoices that have gone
// on too long. Each client is handled in its own transaction with its
// subscription row locked, so one broken client never blocks the rest and two
// overlapping runs cannot bill the same period twice.
import { prisma, type Db } from '../db.js'
import { env } from '../env.js'
import { platformAudit } from '../lib/audit.js'
import { billedInArrears, periodEnd, priceFor } from './pricing.js'
import { AUTO_SUSPEND_PREFIX, DAY_MS, lockSubscription, periodUsage, raiseSubscriptionInvoice, type SubWithPlan } from './platform.js'

// An OPEN invoice this many days past its due date puts the client past due.
export const PAST_DUE_AFTER_DAYS = 7
// And this many days past its due date suspends the client.
export const SUSPEND_AFTER_DAYS = 21
// A client that fell far behind is caught up at most this many periods per run.
export const MAX_CATCH_UP_PERIODS = 12

const SCHEDULER_FIRST_RUN_MS = 15_000
const SCHEDULER_EVERY_MS = 3_600_000

export type BillingError = { businessId: string; message: string }
export type BillingSummary = {
  invoicesCreated: number
  trialsConverted: number
  markedPastDue: number
  suspended: number
  cancelled: number
  errors: BillingError[]
}

// One thing a run does to one client. The preview lists these, the run applies them.
export type BillingAction =
  | { type: 'convert_trial'; periodStart: Date; periodEnd: Date }
  | { type: 'advance_period'; periodStart: Date; periodEnd: Date }
  | { type: 'invoice'; periodStart: Date; periodEnd: Date; subtotalCents: number; taxCents: number; totalCents: number }
  | { type: 'cancel' }
  | { type: 'past_due'; invoiceId: string; invoiceNumber: string; dueAt: Date }
  | { type: 'suspend'; invoiceId: string; invoiceNumber: string; dueAt: Date }

export type BillingPreviewItem = {
  businessId: string
  businessName: string
  plan: { id: string; name: string }
  status: string
  actions: BillingAction[]
}

export type BillingPreview = {
  at: Date
  items: BillingPreviewItem[]
  totals: {
    invoices: number
    invoiceTotalCents: number
    trialsConverted: number
    markedPastDue: number
    suspended: number
    cancelled: number
  }
}

const emptySummary = (): BillingSummary => ({
  invoicesCreated: 0,
  trialsConverted: 0,
  markedPastDue: 0,
  suspended: 0,
  cancelled: 0,
  errors: []
})

// Subscriptions that might need something at `now`. Cheap filter, the real
// decision is made again under the row lock.
async function candidates(db: Db, now: Date): Promise<{ businessId: string }[]> {
  const pastDueCutoff = new Date(now.getTime() - PAST_DUE_AFTER_DAYS * DAY_MS)
  return db.subscription.findMany({
    where: {
      OR: [
        {
          status: 'TRIALING',
          OR: [{ trialEndsAt: { lte: now } }, { trialEndsAt: null, currentPeriodEnd: { lte: now } }]
        },
        { status: { in: ['ACTIVE', 'PAST_DUE'] }, currentPeriodEnd: { lte: now } },
        {
          status: { in: ['ACTIVE', 'PAST_DUE'] },
          business: { invoices: { some: { status: 'OPEN', dueAt: { lt: pastDueCutoff } } } }
        }
      ]
    },
    select: { businessId: true },
    orderBy: { createdAt: 'asc' }
  })
}

// Decide what a run does for one subscription at `now`. Reads only, so the
// preview and the run share it. Order: end the trial, chase unpaid invoices,
// then roll the period forward (a client being suspended is not billed again).
async function planFor(db: Db, sub: SubWithPlan, now: Date): Promise<BillingAction[]> {
  const actions: BillingAction[] = []
  const arrears = billedInArrears(sub.plan)
  let status = sub.status
  let start = sub.currentPeriodStart
  let end = sub.currentPeriodEnd

  const invoice = async (from: Date, to: Date) => {
    // an invoice already raised for this period is simply kept
    const existing = await db.invoice.findFirst({ where: { subscriptionId: sub.id, periodStart: from }, select: { id: true } })
    if (existing) return
    const usage = await periodUsage(db, sub, from, to)
    const { subtotalCents, taxCents, totalCents } = priceFor(sub.plan, sub, usage, env.PLATFORM_VAT_BPS)
    actions.push({ type: 'invoice', periodStart: from, periodEnd: to, subtotalCents, taxCents, totalCents })
  }

  // 1. A trial that ended becomes a paying subscription from the trial end.
  if (status === 'TRIALING') {
    const trialEnd = sub.trialEndsAt ?? sub.currentPeriodEnd
    if (trialEnd > now) return actions
    status = 'ACTIVE'
    start = trialEnd
    end = periodEnd(trialEnd, sub.plan.interval)
    actions.push({ type: 'convert_trial', periodStart: start, periodEnd: end })
    if (!arrears) await invoice(start, end)
  }
  if (status !== 'ACTIVE' && status !== 'PAST_DUE') return actions

  // 2. Dunning on the oldest unpaid invoice.
  const pastDueCutoff = new Date(now.getTime() - PAST_DUE_AFTER_DAYS * DAY_MS)
  const suspendCutoff = new Date(now.getTime() - SUSPEND_AFTER_DAYS * DAY_MS)
  const oldest = await db.invoice.findFirst({
    where: { businessId: sub.businessId, status: 'OPEN', dueAt: { lt: pastDueCutoff } },
    orderBy: { dueAt: 'asc' },
    select: { id: true, number: true, dueAt: true }
  })
  if (oldest && oldest.dueAt < suspendCutoff) {
    actions.push({ type: 'suspend', invoiceId: oldest.id, invoiceNumber: oldest.number, dueAt: oldest.dueAt })
    return actions
  }
  if (oldest && status === 'ACTIVE') {
    status = 'PAST_DUE'
    actions.push({ type: 'past_due', invoiceId: oldest.id, invoiceNumber: oldest.number, dueAt: oldest.dueAt })
  }

  // 3. Periods that ended: cancel if asked, otherwise move on and invoice.
  for (let i = 0; i < MAX_CATCH_UP_PERIODS && end <= now; i++) {
    if (sub.cancelAtPeriodEnd) {
      actions.push({ type: 'cancel' })
      break
    }
    // a one time licence never renews
    if (sub.plan.interval === 'ONCE') break
    const ended = { start, end }
    start = end
    end = periodEnd(start, sub.plan.interval)
    actions.push({ type: 'advance_period', periodStart: start, periodEnd: end })
    // share of sales pays for the period that just ended, the rest pay ahead
    if (arrears) await invoice(ended.start, ended.end)
    else await invoice(start, end)
  }
  return actions
}

// Carry out the plan inside the transaction that holds the subscription lock.
async function apply(tx: Db, sub: SubWithPlan, actions: BillingAction[], now: Date, tally: BillingSummary) {
  const business = await tx.business.findUnique({ where: { id: sub.businessId }, select: { name: true } })
  const businessName = business?.name ?? ''
  const base = { businessName, plan: sub.plan.code }
  for (const a of actions) {
    if (a.type === 'convert_trial') {
      await tx.subscription.update({
        where: { id: sub.id },
        data: { status: 'ACTIVE', currentPeriodStart: a.periodStart, currentPeriodEnd: a.periodEnd }
      })
      await platformAudit(
        tx,
        null,
        'billing.trial_converted',
        'Subscription',
        sub.id,
        { ...base, periodStart: a.periodStart, periodEnd: a.periodEnd },
        sub.businessId
      )
      tally.trialsConverted++
    } else if (a.type === 'advance_period') {
      await tx.subscription.update({
        where: { id: sub.id },
        data: { currentPeriodStart: a.periodStart, currentPeriodEnd: a.periodEnd }
      })
      await platformAudit(
        tx,
        null,
        'billing.period_advanced',
        'Subscription',
        sub.id,
        { ...base, periodStart: a.periodStart, periodEnd: a.periodEnd },
        sub.businessId
      )
    } else if (a.type === 'invoice') {
      await raiseSubscriptionInvoice(tx, sub, a.periodStart, a.periodEnd, now)
      tally.invoicesCreated++
    } else if (a.type === 'cancel') {
      await tx.subscription.update({ where: { id: sub.id }, data: { status: 'CANCELLED', cancelledAt: now } })
      await platformAudit(tx, null, 'billing.cancelled', 'Subscription', sub.id, { ...base, atPeriodEnd: true }, sub.businessId)
      tally.cancelled++
    } else if (a.type === 'past_due') {
      await tx.subscription.update({ where: { id: sub.id }, data: { status: 'PAST_DUE' } })
      await platformAudit(
        tx,
        null,
        'billing.past_due',
        'Subscription',
        sub.id,
        { ...base, number: a.invoiceNumber, invoiceId: a.invoiceId, dueAt: a.dueAt },
        sub.businessId
      )
      tally.markedPastDue++
    } else {
      const reason = AUTO_SUSPEND_PREFIX + a.invoiceNumber
      await tx.subscription.update({
        where: { id: sub.id },
        data: { status: 'SUSPENDED', suspendedReason: reason, suspendedAt: now }
      })
      await platformAudit(
        tx,
        null,
        'billing.suspended',
        'Subscription',
        sub.id,
        { ...base, number: a.invoiceNumber, invoiceId: a.invoiceId, dueAt: a.dueAt, reason },
        sub.businessId
      )
      tally.suspended++
    }
  }
}

// The unique (subscriptionId, periodStart) on Invoice is the last line of
// defence against billing a period twice. Hitting it means another run got
// there first, which is not an error.
function alreadyBilled(e: unknown): boolean {
  const err = e as { code?: string; message?: string; meta?: unknown }
  if (err?.code !== 'P2002') return false
  let meta = ''
  try {
    meta = JSON.stringify(err.meta ?? '')
  } catch {}
  return /periodStart/.test(meta + ' ' + (err.message ?? ''))
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message.split('\n').filter(Boolean).pop() ?? e.message : String(e)).trim().slice(0, 300)

export async function runBilling(now: Date = new Date()): Promise<BillingSummary> {
  const summary = emptySummary()
  for (const { businessId } of await candidates(prisma, now)) {
    // counted only once the transaction of this client has committed
    const tally = emptySummary()
    try {
      await prisma.$transaction(
        async tx => {
          const sub = await lockSubscription(tx, businessId)
          if (!sub) return
          await apply(tx, sub, await planFor(tx, sub, now), now, tally)
        },
        { maxWait: 15_000, timeout: 60_000 }
      )
      summary.invoicesCreated += tally.invoicesCreated
      summary.trialsConverted += tally.trialsConverted
      summary.markedPastDue += tally.markedPastDue
      summary.suspended += tally.suspended
      summary.cancelled += tally.cancelled
    } catch (e) {
      if (alreadyBilled(e)) continue
      summary.errors.push({ businessId, message: messageOf(e) })
    }
  }
  return summary
}

// What a run would do at `now`, without changing anything.
export async function previewBilling(now: Date = new Date()): Promise<BillingPreview> {
  const preview: BillingPreview = {
    at: now,
    items: [],
    totals: { invoices: 0, invoiceTotalCents: 0, trialsConverted: 0, markedPastDue: 0, suspended: 0, cancelled: 0 }
  }
  for (const { businessId } of await candidates(prisma, now)) {
    const sub = await prisma.subscription.findUnique({
      where: { businessId },
      include: { plan: true, business: { select: { name: true } } }
    })
    if (!sub) continue
    const actions = await planFor(prisma, sub, now)
    if (!actions.length) continue
    for (const a of actions) {
      if (a.type === 'invoice') {
        preview.totals.invoices++
        preview.totals.invoiceTotalCents += a.totalCents
      } else if (a.type === 'convert_trial') preview.totals.trialsConverted++
      else if (a.type === 'past_due') preview.totals.markedPastDue++
      else if (a.type === 'suspend') preview.totals.suspended++
      else if (a.type === 'cancel') preview.totals.cancelled++
    }
    preview.items.push({
      businessId,
      businessName: sub.business.name,
      plan: { id: sub.plan.id, name: sub.plan.name },
      status: sub.status,
      actions
    })
  }
  return preview
}

// Runs the billing engine shortly after start and then every hour. A run
// that is still going is never started again on top of itself. Returns a
// function that stops the schedule. Does nothing under test.
export function startBillingScheduler(): () => void {
  if (env.NODE_ENV === 'test') return () => {}
  let running = false
  let stopped = false
  const tick = async () => {
    if (running || stopped) return
    running = true
    try {
      const s = await runBilling()
      const did = s.invoicesCreated + s.trialsConverted + s.markedPastDue + s.suspended + s.cancelled
      if (did || s.errors.length) {
        console.log(
          `Billing run: ${s.invoicesCreated} invoices, ${s.trialsConverted} trials converted, ${s.markedPastDue} past due, ` +
            `${s.suspended} suspended, ${s.cancelled} cancelled, ${s.errors.length} errors`
        )
      }
      for (const e of s.errors) console.error(`Billing run failed for client ${e.businessId}: ${e.message}`)
    } catch (e) {
      console.error('Billing run failed:', messageOf(e))
    } finally {
      running = false
    }
  }
  const first = setTimeout(tick, SCHEDULER_FIRST_RUN_MS)
  const every = setInterval(tick, SCHEDULER_EVERY_MS)
  return () => {
    stopped = true
    clearTimeout(first)
    clearInterval(every)
  }
}
