import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { env } from '../src/env.js'
import {
  MAX_CATCH_UP_PERIODS,
  PAST_DUE_AFTER_DAYS,
  SUSPEND_AFTER_DAYS,
  previewBilling,
  runBilling,
  startBillingScheduler
} from '../src/rules/billing.js'
import { AUTO_SUSPEND_PREFIX, DAY_MS, DUE_DAYS, createInvoice } from '../src/rules/platform.js'
import { priceFor } from '../src/rules/pricing.js'
import { Client, consoleLogin, resetDb, seedFixture, seedPlatform, type Fixture } from './helpers.js'

let fx: Fixture
let n = 0
const VAT = env.PLATFORM_VAT_BPS
const DEAL = { discountBps: 0, customPriceCents: null }
const at = (iso: string) => new Date(iso)
const vat = (cents: number) => Math.round((cents * VAT) / 10000)

const mkPlan = (over: Record<string, unknown> = {}) =>
  prisma.plan.create({
    data: { code: `plan-${++n}`, name: 'Starter', model: 'FLAT', interval: 'MONTH', priceCents: 250000, ...over } as never
  })

// ACTIVE from 15 Jan to 15 Feb 2026 unless told otherwise.
const mkSub = (planId: string, over: Record<string, unknown> = {}, businessId = fx.business.id) =>
  prisma.subscription.create({
    data: {
      businessId,
      planId,
      status: 'ACTIVE',
      currentPeriodStart: at('2026-01-15T00:00:00Z'),
      currentPeriodEnd: at('2026-02-15T00:00:00Z'),
      ...over
    } as never
  })

const mkBusiness = async (name: string) => {
  const business = await prisma.business.create({ data: { name } })
  await prisma.branch.create({ data: { businessId: business.id, name: 'Main' } })
  return business
}

const mkSale = (totalCents: number, paidAt: Date) =>
  prisma.sale.create({
    data: {
      number: 5000 + ++n,
      branchId: fx.branches.west.id,
      createdById: fx.users.cashier.id,
      paidById: fx.users.cashier.id,
      status: 'PAID',
      subtotalCents: totalCents,
      totalCents,
      paidAt
    }
  })

const invoicesOf = (businessId = fx.business.id) => prisma.invoice.findMany({ where: { businessId }, orderBy: { periodStart: 'asc' } })
const subOf = (businessId = fx.business.id) => prisma.subscription.findUniqueOrThrow({ where: { businessId } })
const payAll = () =>
  prisma.$executeRaw`UPDATE "Invoice" SET "paidCents" = "totalCents", "status" = 'PAID', "paidAt" = now() WHERE "status" = 'OPEN'`
const NOTHING = { invoicesCreated: 0, trialsConverted: 0, markedPastDue: 0, suspended: 0, cancelled: 0, errors: [] }

beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
})

describe('billing run: pricing models', () => {
  it('bills a flat monthly plan in advance, period after period', async () => {
    const plan = await mkPlan()
    const sub = await mkSub(plan.id)
    const want = priceFor(plan, DEAL, { branches: 2, salesCents: 0 }, VAT)
    expect(want.subtotalCents).toBe(250000)
    expect(want.totalCents).toBe(250000 + vat(250000))

    // one millisecond before the period ends nothing happens
    expect(await runBilling(at('2026-02-14T23:59:59.999Z'))).toEqual(NOTHING)

    const now = at('2026-02-15T00:00:00Z')
    expect(await runBilling(now)).toEqual({ ...NOTHING, invoicesCreated: 1 })
    let list = await invoicesOf()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      subscriptionId: sub.id,
      status: 'OPEN',
      subtotalCents: want.subtotalCents,
      taxCents: want.taxCents,
      totalCents: want.totalCents,
      paidCents: 0
    })
    expect(list[0]!.number).toMatch(/^INV-2026-\d{6}$/)
    expect(list[0]!.lines).toEqual(want.lines)
    expect(list[0]!.periodStart).toEqual(at('2026-02-15T00:00:00Z'))
    expect(list[0]!.periodEnd).toEqual(at('2026-03-15T00:00:00Z'))
    expect(list[0]!.issuedAt).toEqual(now)
    expect(list[0]!.dueAt).toEqual(new Date(now.getTime() + DUE_DAYS * DAY_MS))
    expect(await subOf()).toMatchObject({
      status: 'ACTIVE',
      currentPeriodStart: at('2026-02-15T00:00:00Z'),
      currentPeriodEnd: at('2026-03-15T00:00:00Z')
    })

    await payAll()
    expect(await runBilling(at('2026-03-15T08:00:00Z'))).toEqual({ ...NOTHING, invoicesCreated: 1 })
    await payAll()
    expect(await runBilling(at('2026-04-01T00:00:00Z'))).toEqual(NOTHING)
    expect(await runBilling(at('2026-04-15T00:00:00Z'))).toEqual({ ...NOTHING, invoicesCreated: 1 })
    list = await invoicesOf()
    expect(list.map(i => i.periodStart.toISOString().slice(0, 10))).toEqual(['2026-02-15', '2026-03-15', '2026-04-15'])
    expect(list.every(i => i.totalCents === want.totalCents)).toBe(true)
    expect(new Set(list.map(i => i.number)).size).toBe(3)

    // every change is in the audit log against the client, by the system
    const audit = await prisma.auditLog.findMany({ where: { action: { startsWith: 'billing.' } } })
    expect(audit.filter(a => a.action === 'billing.invoice_created')).toHaveLength(3)
    expect(audit.filter(a => a.action === 'billing.period_advanced')).toHaveLength(3)
    expect(audit.every(a => a.businessId === fx.business.id && a.userId === null)).toBe(true)
    const created = audit.find(a => a.action === 'billing.invoice_created')!
    expect((created.data as any).number).toBe(list[0]!.number)
  })

  it('bills a yearly flat plan once a year', async () => {
    const plan = await mkPlan({ name: 'Growth yearly', interval: 'YEAR', priceCents: 3900000 })
    await mkSub(plan.id, { currentPeriodStart: at('2025-03-01T00:00:00Z'), currentPeriodEnd: at('2026-03-01T00:00:00Z') })
    const want = priceFor(plan, DEAL, { branches: 2, salesCents: 0 }, VAT)
    expect(await runBilling(at('2026-03-01T00:00:00Z'))).toEqual({ ...NOTHING, invoicesCreated: 1 })
    await payAll()
    expect(await runBilling(at('2026-12-31T00:00:00Z'))).toEqual(NOTHING)
    const list = await invoicesOf()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ subtotalCents: 3900000, totalCents: want.totalCents })
    expect(list[0]!.periodEnd).toEqual(at('2027-03-01T00:00:00Z'))
    expect((await subOf()).currentPeriodEnd).toEqual(at('2027-03-01T00:00:00Z'))
  })

  it('counts active branches at invoice time on per branch plans', async () => {
    const plan = await mkPlan({ name: 'Growth', model: 'PER_BRANCH', priceCents: 150000, perBranchCents: 150000 })
    await mkSub(plan.id)
    await runBilling(at('2026-02-15T00:00:00Z'))
    await payAll()
    // one branch closes before the next invoice
    await prisma.branch.update({ where: { id: fx.branches.kili.id }, data: { active: false } })
    await runBilling(at('2026-03-15T00:00:00Z'))
    await payAll()
    await prisma.branch.create({ data: { businessId: fx.business.id, name: 'Karen' } })
    await prisma.branch.create({ data: { businessId: fx.business.id, name: 'Lavington' } })
    await runBilling(at('2026-04-15T00:00:00Z'))
    const list = await invoicesOf()
    expect(list.map(i => i.subtotalCents)).toEqual([450000, 300000, 600000])
    for (const [i, branches] of [2, 1, 3].entries()) {
      const want = priceFor(plan, DEAL, { branches, salesCents: 0 }, VAT)
      expect(list[i]).toMatchObject({ subtotalCents: want.subtotalCents, taxCents: want.taxCents, totalCents: want.totalCents })
      expect(list[i]!.lines).toEqual(want.lines)
    }
  })

  it('bills share of sales after the period, with the minimum as a floor', async () => {
    const plan = await mkPlan({ name: 'Pay as you sell', model: 'PERCENT_OF_SALES', percentBps: 150, minimumCents: 100000, priceCents: 0 })
    await mkSub(plan.id, { currentPeriodStart: at('2026-01-01T00:00:00Z'), currentPeriodEnd: at('2026-02-01T00:00:00Z') })
    await mkSale(999900, at('2025-12-31T23:59:59Z')) // before the period
    await mkSale(6000000, at('2026-01-01T00:00:00Z'))
    await mkSale(4000050, at('2026-01-31T23:59:59Z'))
    await mkSale(2000000, at('2026-02-01T00:00:00Z')) // belongs to February

    expect(await runBilling(at('2026-02-01T00:00:00Z'))).toEqual({ ...NOTHING, invoicesCreated: 1 })
    await payAll()
    expect(await runBilling(at('2026-03-01T00:00:00Z'))).toEqual({ ...NOTHING, invoicesCreated: 1 })
    const list = await invoicesOf()
    expect(list).toHaveLength(2)

    const jan = priceFor(plan, DEAL, { branches: 2, salesCents: 10000050 }, VAT)
    expect(jan.subtotalCents).toBe(150001) // 1.5% of 100,000.50, rounded to the cent
    expect(list[0]).toMatchObject({ subtotalCents: 150001, taxCents: vat(150001), totalCents: jan.totalCents })
    expect(list[0]!.lines).toEqual(jan.lines)
    expect(list[0]!.periodStart).toEqual(at('2026-01-01T00:00:00Z'))
    expect(list[0]!.periodEnd).toEqual(at('2026-02-01T00:00:00Z'))

    const feb = priceFor(plan, DEAL, { branches: 2, salesCents: 2000000 }, VAT)
    expect(feb.subtotalCents).toBe(100000) // 1.5% came to 300.00, under the minimum
    expect(list[1]).toMatchObject({ subtotalCents: 100000, totalCents: feb.totalCents })
    expect(list[1]!.lines).toEqual(feb.lines)
    expect(list[1]!.periodStart).toEqual(at('2026-02-01T00:00:00Z'))
    expect((await subOf()).currentPeriodEnd).toEqual(at('2026-04-01T00:00:00Z'))
  })

  it('bills a one time licence once and never renews it', async () => {
    const plan = await mkPlan({ name: 'Lifetime licence', model: 'ONE_TIME', interval: 'ONCE', priceCents: 8500000, trialDays: 0 })
    const t = at('2026-02-01T00:00:00Z')
    await mkSub(plan.id, { status: 'TRIALING', trialEndsAt: t, currentPeriodStart: at('2026-01-18T00:00:00Z'), currentPeriodEnd: t })
    expect(await runBilling(t)).toEqual({ ...NOTHING, trialsConverted: 1, invoicesCreated: 1 })
    await payAll()
    expect(await runBilling(at('2028-06-01T00:00:00Z'))).toEqual(NOTHING)
    const list = await invoicesOf()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ subtotalCents: 8500000, totalCents: 8500000 + vat(8500000) })
    expect((await subOf()).currentPeriodEnd).toEqual(at('2126-02-01T00:00:00Z'))
  })

  it('applies a discount and an agreed price through priceFor, each client on its own', async () => {
    const plan = await mkPlan()
    const b2 = await mkBusiness('Mama Njeri Wines')
    await mkSub(plan.id, { discountBps: 2500 })
    await mkSub(plan.id, { customPriceCents: 100000 }, b2.id)
    expect(await runBilling(at('2026-02-15T00:00:00Z'))).toEqual({ ...NOTHING, invoicesCreated: 2 })
    const [a] = await invoicesOf()
    const [b] = await invoicesOf(b2.id)
    const wantA = priceFor(plan, { discountBps: 2500, customPriceCents: null }, { branches: 2, salesCents: 0 }, VAT)
    const wantB = priceFor(plan, { discountBps: 0, customPriceCents: 100000 }, { branches: 1, salesCents: 0 }, VAT)
    expect(a).toMatchObject({ subtotalCents: 187500, totalCents: wantA.totalCents })
    expect(a!.lines).toEqual(wantA.lines)
    expect(b).toMatchObject({ subtotalCents: 100000, totalCents: wantB.totalCents })
    expect(a!.number).not.toBe(b!.number)
  })

  it('records zero invoices as paid and never chases them', async () => {
    const free = await mkPlan({ name: 'Free', priceCents: 0 })
    const paid = await mkPlan()
    const b2 = await mkBusiness('Kwa Otieno Spirits')
    await mkSub(free.id)
    await mkSub(paid.id, { discountBps: 10000 }, b2.id)
    const now = at('2026-02-15T00:00:00Z')
    expect(await runBilling(now)).toEqual({ ...NOTHING, invoicesCreated: 2 })
    for (const id of [fx.business.id, b2.id]) {
      const [inv] = await invoicesOf(id)
      expect(inv).toMatchObject({ status: 'PAID', totalCents: 0, paidCents: 0, paidAt: now })
    }
    // long after the due date the client is still in good standing
    expect(await runBilling(at('2026-03-14T23:00:00Z'))).toEqual(NOTHING)
    expect((await subOf()).status).toBe('ACTIVE')
    expect((await subOf(b2.id)).status).toBe('ACTIVE')
  })
})

describe('billing run: trials and cancellation', () => {
  it('turns an ended trial into a paying subscription with its first invoice', async () => {
    const plan = await mkPlan()
    const t = at('2026-03-10T09:30:00Z')
    await mkSub(plan.id, { status: 'TRIALING', trialEndsAt: t, currentPeriodStart: at('2026-02-24T09:30:00Z'), currentPeriodEnd: t })
    expect(await runBilling(new Date(t.getTime() - 1))).toEqual(NOTHING)
    expect((await subOf()).status).toBe('TRIALING')

    const now = at('2026-03-10T10:00:00Z')
    expect(await runBilling(now)).toEqual({ ...NOTHING, trialsConverted: 1, invoicesCreated: 1 })
    expect(await subOf()).toMatchObject({ status: 'ACTIVE', currentPeriodStart: t, currentPeriodEnd: at('2026-04-10T09:30:00Z') })
    const [inv] = await invoicesOf()
    expect(inv).toMatchObject({ status: 'OPEN', subtotalCents: 250000, issuedAt: now, periodStart: t, periodEnd: at('2026-04-10T09:30:00Z') })
    const audit = await prisma.auditLog.findFirst({ where: { action: 'billing.trial_converted' } })
    expect(audit).toMatchObject({ businessId: fx.business.id, userId: null })
    expect((audit!.data as any).businessName).toBe('Test Wines')
  })

  it('does not invoice a share of sales plan when its trial ends, only after the first period', async () => {
    const plan = await mkPlan({ model: 'PERCENT_OF_SALES', percentBps: 200, minimumCents: 50000, priceCents: 0 })
    const t = at('2026-03-01T00:00:00Z')
    await mkSub(plan.id, { status: 'TRIALING', trialEndsAt: t, currentPeriodStart: at('2026-02-15T00:00:00Z'), currentPeriodEnd: t })
    await mkSale(700000, at('2026-02-20T10:00:00Z')) // during the trial, never billed
    await mkSale(5000000, at('2026-03-05T10:00:00Z'))
    expect(await runBilling(t)).toEqual({ ...NOTHING, trialsConverted: 1 })
    expect(await invoicesOf()).toHaveLength(0)
    expect(await subOf()).toMatchObject({ status: 'ACTIVE', currentPeriodStart: t, currentPeriodEnd: at('2026-04-01T00:00:00Z') })
    expect(await runBilling(at('2026-04-01T00:00:00Z'))).toEqual({ ...NOTHING, invoicesCreated: 1 })
    const [inv] = await invoicesOf()
    expect(inv).toMatchObject({ subtotalCents: 100000, periodStart: t, periodEnd: at('2026-04-01T00:00:00Z') })
  })

  it('cancels at the period end instead of invoicing', async () => {
    const plan = await mkPlan()
    await mkSub(plan.id, { cancelAtPeriodEnd: true })
    expect(await runBilling(at('2026-02-14T00:00:00Z'))).toEqual(NOTHING)
    expect((await subOf()).status).toBe('ACTIVE')
    const now = at('2026-02-15T00:00:00Z')
    expect(await runBilling(now)).toEqual({ ...NOTHING, cancelled: 1 })
    expect(await subOf()).toMatchObject({ status: 'CANCELLED', cancelledAt: now, currentPeriodEnd: at('2026-02-15T00:00:00Z') })
    expect(await invoicesOf()).toHaveLength(0)
    expect(await prisma.auditLog.count({ where: { action: 'billing.cancelled', businessId: fx.business.id } })).toBe(1)
    expect(await runBilling(at('2026-06-01T00:00:00Z'))).toEqual(NOTHING)
  })

  it('leaves suspended and cancelled clients alone', async () => {
    const plan = await mkPlan()
    const b2 = await mkBusiness('Baraka Liquor Store')
    await mkSub(plan.id, { status: 'SUSPENDED', suspendedReason: 'Asked to pause', suspendedAt: at('2026-01-20T00:00:00Z') })
    await mkSub(plan.id, { status: 'CANCELLED', cancelledAt: at('2026-01-20T00:00:00Z') }, b2.id)
    expect(await runBilling(at('2026-06-01T00:00:00Z'))).toEqual(NOTHING)
    expect(await prisma.invoice.count()).toBe(0)
    expect((await subOf()).suspendedReason).toBe('Asked to pause')
  })
})

describe('billing run: safety', () => {
  it('creates nothing new when run twice at the same moment', async () => {
    const plan = await mkPlan()
    await mkSub(plan.id)
    const now = at('2026-02-15T00:00:00Z')
    expect((await runBilling(now)).invoicesCreated).toBe(1)
    const auditBefore = await prisma.auditLog.count()
    expect(await runBilling(now)).toEqual(NOTHING)
    expect(await prisma.invoice.count()).toBe(1)
    expect(await prisma.auditLog.count()).toBe(auditBefore)
  })

  it('does not double bill when two runs overlap', async () => {
    const plan = await mkPlan()
    const b2 = await mkBusiness('Mama Njeri Wines')
    const t = at('2026-02-15T00:00:00Z')
    await mkSub(plan.id)
    await mkSub(plan.id, { status: 'TRIALING', trialEndsAt: t, currentPeriodStart: at('2026-02-01T00:00:00Z'), currentPeriodEnd: t }, b2.id)
    const runs = await Promise.all([runBilling(t), runBilling(t), runBilling(t)])
    expect(runs.flatMap(r => r.errors)).toEqual([])
    expect(runs.reduce((a, r) => a + r.invoicesCreated, 0)).toBe(2)
    expect(runs.reduce((a, r) => a + r.trialsConverted, 0)).toBe(1)
    expect(await invoicesOf()).toHaveLength(1)
    expect(await invoicesOf(b2.id)).toHaveLength(1)
    const numbers = (await prisma.invoice.findMany()).map(i => i.number).sort()
    expect(numbers).toEqual(['INV-2026-000001', 'INV-2026-000002'])
    expect((await prisma.invoiceCounter.findUniqueOrThrow({ where: { year: 2026 } })).last).toBe(2)
  })

  it('keeps an invoice that already exists for the period and still moves on', async () => {
    const plan = await mkPlan()
    const sub = await mkSub(plan.id)
    const priced = priceFor(plan, DEAL, { branches: 2, salesCents: 0 }, VAT)
    await prisma.$transaction(tx =>
      createInvoice(tx, {
        businessId: fx.business.id,
        subscriptionId: sub.id,
        periodStart: at('2026-02-15T00:00:00Z'),
        periodEnd: at('2026-03-15T00:00:00Z'),
        priced,
        issuedAt: at('2026-02-14T00:00:00Z')
      })
    )
    expect(await runBilling(at('2026-02-15T00:00:00Z'))).toEqual(NOTHING)
    expect(await prisma.invoice.count()).toBe(1)
    expect((await subOf()).currentPeriodStart).toEqual(at('2026-02-15T00:00:00Z'))
  })

  it('catches up at most twelve periods per run', async () => {
    const plan = await mkPlan()
    await mkSub(plan.id, { currentPeriodStart: at('2025-01-01T00:00:00Z'), currentPeriodEnd: at('2025-02-01T00:00:00Z') })
    const now = at('2026-05-10T00:00:00Z')
    expect(await runBilling(now)).toEqual({ ...NOTHING, invoicesCreated: MAX_CATCH_UP_PERIODS })
    expect((await subOf()).currentPeriodEnd).toEqual(at('2026-02-01T00:00:00Z'))
    expect(await runBilling(now)).toEqual({ ...NOTHING, invoicesCreated: 4 })
    expect(await runBilling(now)).toEqual(NOTHING)
    const list = await invoicesOf()
    expect(list).toHaveLength(16)
    expect(list[0]!.periodStart).toEqual(at('2025-02-01T00:00:00Z'))
    expect(list[15]!.periodStart).toEqual(at('2026-05-01T00:00:00Z'))
    expect(new Set(list.map(i => i.periodStart.getTime())).size).toBe(16)
    expect(await subOf()).toMatchObject({ status: 'ACTIVE', currentPeriodEnd: at('2026-06-01T00:00:00Z') })
  })

  it('reports a client that fails and still bills the others', async () => {
    // two branches at this price overflow the invoice total, so this client cannot be billed
    const broken = await mkPlan({ name: 'Broken', model: 'PER_BRANCH', priceCents: 0, perBranchCents: 2_000_000_000 })
    const good = await mkPlan()
    const b2 = await mkBusiness('Kwa Otieno Spirits')
    await mkSub(broken.id)
    await mkSub(good.id, {}, b2.id)
    const summary = await runBilling(at('2026-02-15T00:00:00Z'))
    expect(summary.invoicesCreated).toBe(1)
    expect(summary.errors).toHaveLength(1)
    expect(summary.errors[0]!.businessId).toBe(fx.business.id)
    expect(summary.errors[0]!.message.length).toBeGreaterThan(0)
    // the failed client rolled back completely
    expect(await invoicesOf()).toHaveLength(0)
    expect((await subOf()).currentPeriodEnd).toEqual(at('2026-02-15T00:00:00Z'))
    expect(await invoicesOf(b2.id)).toHaveLength(1)
    expect((await prisma.invoice.findFirstOrThrow()).number).toBe('INV-2026-000001')
  })

  it('has a scheduler that does nothing under test', () => {
    const stop = startBillingScheduler()
    expect(typeof stop).toBe('function')
    stop()
  })
})

describe('billing run: unpaid invoices', () => {
  const due = at('2026-03-01T00:00:00Z')
  const farAhead = { currentPeriodStart: at('2026-02-01T00:00:00Z'), currentPeriodEnd: at('2027-02-01T00:00:00Z') }

  const openInvoice = async (businessId = fx.business.id, dueAt = due) => {
    const plan = await prisma.plan.findFirstOrThrow()
    const priced = priceFor(plan, DEAL, { branches: 1, salesCents: 0 }, VAT)
    const start = new Date(dueAt.getTime() - DUE_DAYS * DAY_MS)
    return prisma.$transaction(tx =>
      createInvoice(tx, { businessId, periodStart: start, periodEnd: dueAt, priced, issuedAt: start, dueAt })
    )
  }

  it('marks past due after 7 days and suspends after 21, at the exact boundaries', async () => {
    expect([PAST_DUE_AFTER_DAYS, SUSPEND_AFTER_DAYS]).toEqual([7, 21])
    const plan = await mkPlan({ interval: 'YEAR' })
    await mkSub(plan.id, farAhead)
    const inv = await openInvoice()

    expect(await runBilling(new Date(due.getTime() + 7 * DAY_MS))).toEqual(NOTHING)
    expect((await subOf()).status).toBe('ACTIVE')

    expect(await runBilling(new Date(due.getTime() + 7 * DAY_MS + 1))).toEqual({ ...NOTHING, markedPastDue: 1 })
    expect((await subOf()).status).toBe('PAST_DUE')
    const pastDue = await prisma.auditLog.findFirstOrThrow({ where: { action: 'billing.past_due' } })
    expect(pastDue).toMatchObject({ businessId: fx.business.id, userId: null })
    expect(pastDue.data).toMatchObject({ number: inv.number, businessName: 'Test Wines' })

    // already past due: nothing more until day 21 has passed
    expect(await runBilling(new Date(due.getTime() + 10 * DAY_MS))).toEqual(NOTHING)
    expect(await runBilling(new Date(due.getTime() + 21 * DAY_MS))).toEqual(NOTHING)
    expect((await subOf()).status).toBe('PAST_DUE')

    const now = new Date(due.getTime() + 21 * DAY_MS + 1)
    expect(await runBilling(now)).toEqual({ ...NOTHING, suspended: 1 })
    expect(await subOf()).toMatchObject({ status: 'SUSPENDED', suspendedReason: AUTO_SUSPEND_PREFIX + inv.number, suspendedAt: now })
    expect((await subOf()).suspendedReason).toBe(`Unpaid invoice ${inv.number}`)
    const suspended = await prisma.auditLog.findFirstOrThrow({ where: { action: 'billing.suspended' } })
    expect(suspended.data).toMatchObject({ number: inv.number, businessName: 'Test Wines' })
    expect(await runBilling(new Date(now.getTime() + 30 * DAY_MS))).toEqual(NOTHING)
  })

  it('suspends an active client straight away when the invoice is already 21 days late, and bills it no further', async () => {
    const plan = await mkPlan()
    await mkSub(plan.id) // period ends 15 Feb, long before the run
    const inv = await openInvoice(fx.business.id, at('2026-01-22T00:00:00Z'))
    expect(await runBilling(at('2026-03-20T00:00:00Z'))).toEqual({ ...NOTHING, suspended: 1 })
    expect(await subOf()).toMatchObject({ status: 'SUSPENDED', suspendedReason: AUTO_SUSPEND_PREFIX + inv.number })
    expect(await prisma.invoice.count()).toBe(1)
  })

  it('never chases trialing or manually suspended clients, or paid and void invoices', async () => {
    const plan = await mkPlan({ interval: 'YEAR' })
    const b2 = await mkBusiness('Mama Njeri Wines')
    const b3 = await mkBusiness('Baraka Liquor Store')
    await mkSub(plan.id, { ...farAhead, status: 'TRIALING', trialEndsAt: at('2027-02-01T00:00:00Z') })
    await mkSub(plan.id, { ...farAhead, status: 'SUSPENDED', suspendedReason: 'Asked to pause' }, b2.id)
    await mkSub(plan.id, farAhead, b3.id)
    await openInvoice()
    await openInvoice(b2.id)
    const paid = await openInvoice(b3.id)
    const voided = await openInvoice(b3.id)
    await prisma.invoice.update({ where: { id: paid.id }, data: { status: 'PAID', paidCents: paid.totalCents, paidAt: due } })
    await prisma.invoice.update({ where: { id: voided.id }, data: { status: 'VOID', voidedAt: due } })
    expect(await runBilling(new Date(due.getTime() + 60 * DAY_MS))).toEqual(NOTHING)
    expect((await subOf()).status).toBe('TRIALING')
    expect(await subOf(b2.id)).toMatchObject({ status: 'SUSPENDED', suspendedReason: 'Asked to pause' })
    expect((await subOf(b3.id)).status).toBe('ACTIVE')
  })

  it('keeps invoicing a past due client when its period ends', async () => {
    const plan = await mkPlan()
    await mkSub(plan.id)
    await openInvoice(fx.business.id, at('2026-02-05T00:00:00Z'))
    // 10 days late on 15 Feb: past due, and the new period is still billed
    expect(await runBilling(at('2026-02-15T00:00:00Z'))).toEqual({ ...NOTHING, markedPastDue: 1, invoicesCreated: 1 })
    expect(await subOf()).toMatchObject({ status: 'PAST_DUE', currentPeriodStart: at('2026-02-15T00:00:00Z') })
  })
})

describe('console billing routes', () => {
  const hourAgo = () => new Date(Date.now() - 3_600_000)

  it('previews without changing anything, then the run does exactly that', async () => {
    await seedPlatform()
    const plan = await mkPlan()
    const t = hourAgo()
    await mkSub(plan.id, { status: 'TRIALING', trialEndsAt: t, currentPeriodStart: new Date(t.getTime() - 14 * DAY_MS), currentPeriodEnd: t })
    const want = priceFor(plan, DEAL, { branches: 2, salesCents: 0 }, VAT)
    const billing = await consoleLogin('billing@bottlepoint.test')
    const support = await consoleLogin('support@bottlepoint.test')
    const auditBefore = await prisma.auditLog.count()

    const res = await support.get('/api/console/billing/preview')
    expect(res.status).toBe(200)
    expect(res.body.preview.totals).toEqual({
      invoices: 1,
      invoiceTotalCents: want.totalCents,
      trialsConverted: 1,
      markedPastDue: 0,
      suspended: 0,
      cancelled: 0
    })
    expect(res.body.preview.items).toHaveLength(1)
    const item = res.body.preview.items[0]
    expect(item).toMatchObject({ businessId: fx.business.id, businessName: 'Test Wines', status: 'TRIALING', plan: { id: plan.id, name: 'Starter' } })
    expect(item.actions.map((a: any) => a.type)).toEqual(['convert_trial', 'invoice'])
    expect(item.actions[1]).toMatchObject({
      periodStart: t.toISOString(),
      subtotalCents: want.subtotalCents,
      taxCents: want.taxCents,
      totalCents: want.totalCents
    })
    // nothing moved
    expect((await subOf()).status).toBe('TRIALING')
    expect(await prisma.invoice.count()).toBe(0)
    expect(await prisma.invoiceCounter.count()).toBe(0)
    expect(await prisma.auditLog.count()).toBe(auditBefore)

    const run = await billing.post('/api/console/billing/run')
    expect(run.status).toBe(200)
    expect(run.body.summary).toEqual({ ...NOTHING, trialsConverted: 1, invoicesCreated: 1 })
    expect((await subOf()).status).toBe('ACTIVE')
    expect((await invoicesOf())[0]).toMatchObject({ totalCents: want.totalCents, status: 'OPEN' })
    const pressed = await prisma.auditLog.findFirstOrThrow({ where: { action: 'console.billing.run' } })
    expect(pressed.data).toMatchObject({ invoicesCreated: 1, trialsConverted: 1, errors: 0 })
    expect(pressed.userId).not.toBeNull()

    // a second press and a second look find nothing left to do
    expect((await billing.post('/api/console/billing/run')).body.summary).toEqual(NOTHING)
    const after = await billing.get('/api/console/billing/preview')
    expect(after.body.preview.items).toEqual([])
    expect(after.body.preview.totals.invoices).toBe(0)
  })

  it('previews dunning and cancellation', async () => {
    const plan = await mkPlan()
    const b2 = await mkBusiness('Mama Njeri Wines')
    await mkSub(plan.id, { cancelAtPeriodEnd: true })
    await mkSub(plan.id, { currentPeriodEnd: at('2027-01-15T00:00:00Z') }, b2.id)
    const priced = priceFor(plan, DEAL, { branches: 1, salesCents: 0 }, VAT)
    const inv = await prisma.$transaction(tx =>
      createInvoice(tx, {
        businessId: b2.id,
        periodStart: at('2026-01-15T00:00:00Z'),
        periodEnd: at('2026-02-15T00:00:00Z'),
        priced,
        issuedAt: at('2026-01-15T00:00:00Z')
      })
    )
    const preview = await previewBilling(at('2026-02-20T00:00:00Z'))
    expect(preview.totals).toMatchObject({ invoices: 0, cancelled: 1, suspended: 1, markedPastDue: 0 })
    const byId = Object.fromEntries(preview.items.map(i => [i.businessId, i.actions]))
    expect(byId[fx.business.id]).toEqual([{ type: 'cancel' }])
    expect(byId[b2.id]).toEqual([{ type: 'suspend', invoiceId: inv.id, invoiceNumber: inv.number, dueAt: inv.dueAt }])
    expect((await subOf()).status).toBe('ACTIVE')
    expect((await subOf(b2.id)).status).toBe('ACTIVE')
  })

  it('lets only billing and super admins run billing, and only console users see it', async () => {
    await seedPlatform()
    const support = await consoleLogin('support@bottlepoint.test')
    const billing = await consoleLogin('billing@bottlepoint.test')
    const admin = await consoleLogin('admin@bottlepoint.test')
    const owner = await Client.login('owner')
    const nobody = new Client()

    const denied = await support.post('/api/console/billing/run')
    expect(denied.status).toBe(403)
    expect(denied.body.error.code ?? denied.body.code).toBe('forbidden')
    expect((await billing.post('/api/console/billing/run')).status).toBe(200)
    expect((await admin.post('/api/console/billing/run')).status).toBe(200)
    for (const who of [support, billing, admin]) expect((await who.get('/api/console/billing/preview')).status).toBe(200)
    for (const who of [owner, nobody]) {
      expect((await who.post('/api/console/billing/run')).status).toBe(401)
      expect((await who.get('/api/console/billing/preview')).status).toBe(401)
    }
    expect(await prisma.auditLog.count({ where: { action: 'console.billing.run' } })).toBe(2)
  })
})
