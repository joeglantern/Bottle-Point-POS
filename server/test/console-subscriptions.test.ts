import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { env } from '../src/env.js'
import { periodEnd, priceFor } from '../src/rules/pricing.js'
import { Client, consoleLogin, PIN, resetDb, seedFixture, seedPlatform, type Fixture } from './helpers.js'

let fx: Fixture
let admin: Client
let support: Client
let billing: Client

const DAY = 86_400_000
const VAT = env.PLATFORM_VAT_BPS
const deal = { discountBps: 0, customPriceCents: null }

beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
  await seedPlatform()
  admin = await consoleLogin('admin@bottlepoint.test')
  support = await consoleLogin('support@bottlepoint.test')
  billing = await consoleLogin('billing@bottlepoint.test')
})

const mkPlan = (code: string, data: Record<string, unknown> = {}) =>
  prisma.plan.create({ data: { code, name: code.toUpperCase(), model: 'FLAT', priceCents: 250000, ...data } as never })

// A subscription written straight to the database, in whatever state a test needs.
const mkSub = async (planId: string, data: Record<string, unknown> = {}, businessId = fx.business.id) => {
  const now = new Date()
  return prisma.subscription.create({
    data: { businessId, planId, status: 'ACTIVE', currentPeriodStart: now, currentPeriodEnd: periodEnd(now, 'MONTH'), ...data } as never
  })
}

const path = (what: string, businessId = fx.business.id) => `/api/console/tenants/${businessId}/subscription/${what}`
const subRow = () => prisma.subscription.findUniqueOrThrow({ where: { businessId: fx.business.id } })

describe('changing plan', () => {
  it('creates the subscription when the client has none, and bills the first period in advance', async () => {
    const plan = await mkPlan('flat')
    const before = Date.now()
    const res = await billing.post(path('plan'), { planId: plan.id })
    expect(res.status).toBe(200)
    const sub = res.body.subscription
    expect(sub).toMatchObject({
      businessId: fx.business.id,
      businessName: 'Test Wines',
      plan: { id: plan.id, code: 'flat', name: 'FLAT', model: 'FLAT', interval: 'MONTH' },
      status: 'ACTIVE',
      trialEndsAt: null,
      cancelAtPeriodEnd: false,
      discountBps: 0,
      customPriceCents: null
    })
    const start = new Date(sub.currentPeriodStart)
    expect(start.getTime()).toBeGreaterThanOrEqual(before - 1000)
    expect(new Date(sub.currentPeriodEnd)).toEqual(periodEnd(start, 'MONTH'))

    const priced = priceFor(plan, deal, { branches: 2, salesCents: 0 }, VAT)
    expect(res.body.invoice).toMatchObject({ totalCents: priced.totalCents, status: 'OPEN' })
    expect(res.body.invoice.number).toMatch(/^INV-\d{4}-\d{6}$/)
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { businessId: fx.business.id } })
    expect(invoice).toMatchObject({ subscriptionId: sub.id, subtotalCents: 250000, taxCents: priced.taxCents, totalCents: priced.totalCents })
    expect(invoice.periodStart).toEqual(start)
    // the next one is the same amount, due when this period ends
    expect(sub.nextAmountCents).toBe(priced.totalCents)
    expect(sub.nextInvoiceAt).toBe(sub.currentPeriodEnd)

    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'console.subscription.plan_changed' } })
    expect(row.businessId).toBe(fx.business.id)
    expect(row.data).toMatchObject({ businessName: 'Test Wines', fromPlan: null, toPlan: 'FLAT', created: true })
  })

  it('a share of sales plan is billed afterwards, so nothing is invoiced on creation', async () => {
    const plan = await mkPlan('payg', { model: 'PERCENT_OF_SALES', priceCents: 0, percentBps: 150, minimumCents: 100000 })
    const res = await admin.post(path('plan'), { planId: plan.id })
    expect(res.status).toBe(200)
    expect(res.body.invoice).toBeNull()
    expect(await prisma.invoice.count()).toBe(0)
    // no sales yet, so the estimate is the minimum fee plus VAT
    expect(res.body.subscription.nextAmountCents).toBe(priceFor(plan, deal, { branches: 2, salesCents: 0 }, VAT).totalCents)
  })

  it('keeps the period dates of an existing subscription and prices the next invoice on the new plan', async () => {
    const a = await mkPlan('a')
    const b = await mkPlan('b', { model: 'PER_BRANCH', priceCents: 150000, perBranchCents: 150000 })
    const start = new Date(Date.now() - 10 * DAY)
    const end = periodEnd(start, 'MONTH')
    await mkSub(a.id, { currentPeriodStart: start, currentPeriodEnd: end, discountBps: 1000 })
    const res = await billing.post(path('plan'), { planId: b.id })
    expect(res.status).toBe(200)
    expect(res.body.invoice).toBeNull()
    expect(await prisma.invoice.count()).toBe(0)
    const sub = await subRow()
    expect(sub).toMatchObject({ planId: b.id, status: 'ACTIVE', discountBps: 1000 })
    expect(sub.currentPeriodStart).toEqual(start)
    expect(sub.currentPeriodEnd).toEqual(end)
    // two active branches, 10% off
    const priced = priceFor(b, { discountBps: 1000, customPriceCents: null }, { branches: 2, salesCents: 0 }, VAT)
    expect(priced.subtotalCents).toBe(405000)
    expect(res.body.subscription.nextAmountCents).toBe(priced.totalCents)

    const same = await billing.post(path('plan'), { planId: b.id })
    expect(same.status).toBe(422)
    expect(same.body.error.code).toBe('same_plan')
  })

  it('moving to a one time licence starts a fresh period and bills the licence', async () => {
    const a = await mkPlan('a')
    const licence = await mkPlan('licence', { model: 'ONE_TIME', interval: 'ONCE', priceCents: 8500000 })
    await mkSub(a.id, { currentPeriodStart: new Date(Date.now() - 10 * DAY), currentPeriodEnd: new Date(Date.now() + 20 * DAY) })
    const res = await admin.post(path('plan'), { planId: licence.id })
    expect(res.status).toBe(200)
    expect(res.body.invoice.totalCents).toBe(priceFor(licence, deal, { branches: 2, salesCents: 0 }, VAT).totalCents)
    const sub = await subRow()
    expect(sub.currentPeriodEnd).toEqual(periodEnd(sub.currentPeriodStart, 'ONCE'))
    // a licence is paid once: nothing more is coming
    expect(res.body.subscription.nextAmountCents).toBeNull()
  })

  it('refuses a plan the client has outgrown, then allows it with force', async () => {
    const small = await mkPlan('small', { maxBranches: 1, maxStaff: 5, maxProducts: 2 })
    const res = await billing.post(path('plan'), { planId: small.id })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('over_plan_limits')
    expect(res.body.error.details).toEqual({
      over: [
        { what: 'branches', used: 2, max: 1 },
        { what: 'staff', used: 6, max: 5 },
        { what: 'products', used: 3, max: 2 }
      ],
      usage: { branches: 2, staff: 6, products: 3 },
      limits: { maxBranches: 1, maxStaff: 5, maxProducts: 2 }
    })
    expect(await prisma.subscription.count()).toBe(0)
    expect(await prisma.invoice.count()).toBe(0)

    const forced = await billing.post(path('plan'), { planId: small.id, force: true })
    expect(forced.status).toBe(200)
    expect((await subRow()).planId).toBe(small.id)
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'console.subscription.plan_changed' } })
    expect(row.data).toMatchObject({ forced: true })

    // exactly at the limit is fine without force
    await prisma.subscription.deleteMany()
    await prisma.invoice.deleteMany()
    const exact = await mkPlan('exact', { maxBranches: 2, maxStaff: 6, maxProducts: 3 })
    expect((await billing.post(path('plan'), { planId: exact.id })).status).toBe(200)
  })

  it('refuses archived and unknown plans, unknown clients and bad input', async () => {
    const archived = await mkPlan('old', { active: false })
    const res = await admin.post(path('plan'), { planId: archived.id })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('plan_archived')
    expect((await admin.post(path('plan'), { planId: 'nope' })).status).toBe(404)
    const plan = await mkPlan('flat')
    expect((await admin.post(path('plan', 'nope'), { planId: plan.id })).status).toBe(404)
    expect((await admin.post(path('plan'), {})).status).toBe(400)
    expect((await admin.post(path('plan'), { planId: plan.id, force: 'yes' })).status).toBe(400)
    expect(await prisma.subscription.count()).toBe(0)
  })

  it('two people putting the same client on a plan at once make one subscription and one invoice', async () => {
    const plan = await mkPlan('flat')
    const results = await Promise.all([admin.post(path('plan'), { planId: plan.id }), billing.post(path('plan'), { planId: plan.id })])
    expect(results.map(r => r.status).sort()).toEqual([200, 422])
    expect(await prisma.subscription.count()).toBe(1)
    expect(await prisma.invoice.count()).toBe(1)
  })
})

describe('terms', () => {
  it('sets a discount and a custom price, and null clears the custom price', async () => {
    const plan = await mkPlan('flat')
    await mkSub(plan.id)
    let res = await billing.post(path('terms'), { discountBps: 2500 })
    expect(res.status).toBe(200)
    expect(res.body.subscription).toMatchObject({ discountBps: 2500, customPriceCents: null })
    expect(res.body.subscription.nextAmountCents).toBe(priceFor(plan, { discountBps: 2500, customPriceCents: null }, { branches: 2, salesCents: 0 }, VAT).totalCents)

    res = await billing.post(path('terms'), { customPriceCents: 199900 })
    expect(res.body.subscription).toMatchObject({ discountBps: 2500, customPriceCents: 199900 })
    expect(res.body.subscription.nextAmountCents).toBe(priceFor(plan, { discountBps: 2500, customPriceCents: 199900 }, { branches: 2, salesCents: 0 }, VAT).totalCents)

    res = await billing.post(path('terms'), { discountBps: 0, customPriceCents: null })
    expect(res.body.subscription).toMatchObject({ discountBps: 0, customPriceCents: null })
    expect(res.body.subscription.nextAmountCents).toBe(priceFor(plan, deal, { branches: 2, salesCents: 0 }, VAT).totalCents)

    const rows = await prisma.auditLog.findMany({ where: { action: 'console.subscription.terms_changed' }, orderBy: { id: 'asc' } })
    expect(rows).toHaveLength(3)
    expect(rows[0]!.businessId).toBe(fx.business.id)
    expect(rows[0]!.data).toMatchObject({ businessName: 'Test Wines', planName: 'FLAT', discountBps: { from: 0, to: 2500 } })
  })

  it('validates and needs a subscription', async () => {
    const plan = await mkPlan('flat')
    const none = await billing.post(path('terms'), { discountBps: 100 })
    expect(none.status).toBe(422)
    expect(none.body.error.code).toBe('no_subscription')
    await mkSub(plan.id)
    for (const bad of [{}, { discountBps: -1 }, { discountBps: 10001 }, { discountBps: 12.5 }, { customPriceCents: -1 }, { customPriceCents: 9.99 }, { customPriceCents: '100' }]) {
      expect((await billing.post(path('terms'), bad)).status, JSON.stringify(bad)).toBe(400)
    }
    expect((await billing.post(path('terms', 'nope'), { discountBps: 100 })).status).toBe(404)
    expect(await subRow()).toMatchObject({ discountBps: 0, customPriceCents: null })
  })
})

describe('extending a trial', () => {
  it('moves the trial end and the period end, for any console role', async () => {
    const plan = await mkPlan('flat')
    const ends = new Date(Date.now() + 3 * DAY)
    await mkSub(plan.id, { status: 'TRIALING', trialEndsAt: ends, currentPeriodEnd: ends })
    const res = await support.post(path('extend-trial'), { days: 7 })
    expect(res.status).toBe(200)
    const moved = new Date(ends.getTime() + 7 * DAY)
    expect(new Date(res.body.subscription.trialEndsAt)).toEqual(moved)
    expect(new Date(res.body.subscription.currentPeriodEnd)).toEqual(moved)
    expect(res.body.subscription.status).toBe('TRIALING')
    // the first invoice is now expected when the longer trial ends
    expect(new Date(res.body.subscription.nextInvoiceAt)).toEqual(moved)

    expect((await billing.post(path('extend-trial'), { days: 1 })).status).toBe(200)
    expect((await admin.post(path('extend-trial'), { days: 90 })).status).toBe(200)
    expect((await subRow()).trialEndsAt).toEqual(new Date(ends.getTime() + 98 * DAY))
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'console.subscription.trial_extended' }, orderBy: { id: 'asc' } })
    expect(row.businessId).toBe(fx.business.id)
    expect(row.data).toMatchObject({ businessName: 'Test Wines', days: 7 })
  })

  it('only while trialing, 1 to 90 whole days', async () => {
    const plan = await mkPlan('flat')
    expect((await support.post(path('extend-trial'), { days: 7 })).body.error.code).toBe('no_subscription')
    const ends = new Date(Date.now() + 3 * DAY)
    await mkSub(plan.id, { status: 'TRIALING', trialEndsAt: ends, currentPeriodEnd: ends })
    for (const days of [0, 91, -3, 1.5, '7', undefined]) {
      expect((await support.post(path('extend-trial'), { days })).status, String(days)).toBe(400)
    }
    await prisma.subscription.updateMany({ data: { status: 'ACTIVE' } })
    const res = await support.post(path('extend-trial'), { days: 7 })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('not_trialing')
    expect((await subRow()).trialEndsAt).toEqual(ends)
  })
})

describe('cancelling and resuming', () => {
  it('cancel now locks the shop out at once, resume lets it back in', async () => {
    const plan = await mkPlan('flat')
    await mkSub(plan.id)
    const owner = await Client.login('owner', PIN, fx.branches.west.id)
    expect((await owner.get('/api/products')).status).toBe(200)

    const res = await billing.post(path('cancel'), { atPeriodEnd: false, reason: 'Closed the shop' })
    expect(res.status).toBe(200)
    expect(res.body.subscription).toMatchObject({ status: 'CANCELLED', cancelAtPeriodEnd: false, nextAmountCents: null })
    expect(res.body.subscription.cancelledAt).toBeTruthy()
    const shut = await owner.get('/api/products')
    expect(shut.status).toBe(402)
    expect(shut.body.error.code).toBe('subscription_cancelled')
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'console.subscription.cancelled' } })
    expect(row.businessId).toBe(fx.business.id)
    expect(row.data).toMatchObject({ businessName: 'Test Wines', reason: 'Closed the shop', previousStatus: 'ACTIVE' })

    const again = await billing.post(path('cancel'), { atPeriodEnd: false })
    expect(again.status).toBe(422)
    expect(again.body.error.code).toBe('already_cancelled')
    const other = await mkPlan('other')
    const change = await billing.post(path('plan'), { planId: other.id })
    expect(change.status).toBe(422)
    expect(change.body.error.code).toBe('subscription_cancelled')

    // the period it paid for has not run out, so it carries on without a new invoice
    const back = await billing.post(path('resume'))
    expect(back.status).toBe(200)
    expect(back.body.subscription).toMatchObject({ status: 'ACTIVE', cancelledAt: null, cancelAtPeriodEnd: false })
    expect(back.body.invoice).toBeNull()
    expect((await owner.get('/api/products')).status).toBe(200)
    expect(await prisma.auditLog.count({ where: { action: 'console.subscription.resumed', businessId: fx.business.id } })).toBe(1)
  })

  it('resuming after the period ran out starts a new period and bills it', async () => {
    const plan = await mkPlan('flat')
    const start = new Date(Date.now() - 60 * DAY)
    await mkSub(plan.id, { status: 'CANCELLED', cancelledAt: new Date(Date.now() - 40 * DAY), currentPeriodStart: start, currentPeriodEnd: periodEnd(start, 'MONTH') })
    const before = Date.now()
    const res = await admin.post(path('resume'))
    expect(res.status).toBe(200)
    expect(res.body.invoice.totalCents).toBe(priceFor(plan, deal, { branches: 2, salesCents: 0 }, VAT).totalCents)
    const sub = await subRow()
    expect(sub.status).toBe('ACTIVE')
    expect(sub.currentPeriodStart.getTime()).toBeGreaterThanOrEqual(before - 1000)
    expect(sub.currentPeriodEnd).toEqual(periodEnd(sub.currentPeriodStart, 'MONTH'))
    expect(await prisma.invoice.count({ where: { subscriptionId: sub.id } })).toBe(1)
  })

  it('resuming a client that still owes an overdue invoice comes back past due', async () => {
    const plan = await mkPlan('flat')
    const sub = await mkSub(plan.id, { status: 'CANCELLED', cancelledAt: new Date() })
    await prisma.invoice.create({
      data: {
        number: 'INV-2026-000901',
        businessId: fx.business.id,
        subscriptionId: sub.id,
        periodStart: new Date(Date.now() - 40 * DAY),
        periodEnd: new Date(Date.now() - 10 * DAY),
        lines: [],
        subtotalCents: 1000,
        taxCents: 160,
        totalCents: 1160,
        dueAt: new Date(Date.now() - 20 * DAY)
      }
    })
    const res = await admin.post(path('resume'))
    expect(res.body.subscription.status).toBe('PAST_DUE')
  })

  it('cancel at period end keeps the shop open and stops the next invoice, resume undoes it', async () => {
    const plan = await mkPlan('flat')
    await mkSub(plan.id)
    const owner = await Client.login('owner', PIN, fx.branches.west.id)
    const res = await billing.post(path('cancel'), { atPeriodEnd: true, reason: 'Moving to another system' })
    expect(res.status).toBe(200)
    expect(res.body.subscription).toMatchObject({ status: 'ACTIVE', cancelAtPeriodEnd: true, cancelledAt: null, nextAmountCents: null, nextInvoiceAt: null })
    expect((await owner.get('/api/products')).status).toBe(200)
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'console.subscription.cancel_scheduled' } })
    expect(row.data).toMatchObject({ businessName: 'Test Wines', reason: 'Moving to another system' })

    const back = await billing.post(path('resume'))
    expect(back.status).toBe(200)
    expect(back.body.subscription).toMatchObject({ status: 'ACTIVE', cancelAtPeriodEnd: false })
    expect(back.body.subscription.nextAmountCents).toBeGreaterThan(0)

    const nothing = await billing.post(path('resume'))
    expect(nothing.status).toBe(422)
    expect(nothing.body.error.code).toBe('not_cancelled')
  })

  it('validates, and only a paying client can run to its period end', async () => {
    const plan = await mkPlan('flat')
    expect((await billing.post(path('cancel'), { atPeriodEnd: false })).body.error.code).toBe('no_subscription')
    expect((await billing.post(path('resume'))).body.error.code).toBe('no_subscription')
    const ends = new Date(Date.now() + 3 * DAY)
    await mkSub(plan.id, { status: 'TRIALING', trialEndsAt: ends, currentPeriodEnd: ends })
    for (const bad of [{}, { atPeriodEnd: 'yes' }, { atPeriodEnd: true, reason: 'x'.repeat(501) }]) {
      expect((await billing.post(path('cancel'), bad)).status, JSON.stringify(bad)).toBe(400)
    }
    const res = await billing.post(path('cancel'), { atPeriodEnd: true })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('invalid_state')
    expect(await subRow()).toMatchObject({ status: 'TRIALING', cancelAtPeriodEnd: false })
    // a trial can be cancelled outright
    expect((await billing.post(path('cancel'), { atPeriodEnd: false })).body.subscription.status).toBe('CANCELLED')
    expect((await billing.post(path('cancel', 'nope'), { atPeriodEnd: false })).status).toBe(404)
  })
})

describe('listing subscriptions', () => {
  it('filters by status, plan and client name, pages and counts', async () => {
    const flat = await mkPlan('flat')
    const payg = await mkPlan('payg', { model: 'PERCENT_OF_SALES', priceCents: 0, percentBps: 150, minimumCents: 100000 })
    const names = ['Mama Njeri Wines', 'Kilele Spirits', 'Baraka Liquor Store']
    const others = await Promise.all(names.map(name => prisma.business.create({ data: { name } })))
    const ends = new Date(Date.now() + 3 * DAY)
    await mkSub(flat.id, { discountBps: 500 })
    await mkSub(flat.id, { status: 'TRIALING', trialEndsAt: ends, currentPeriodEnd: ends }, others[0]!.id)
    await mkSub(payg.id, { status: 'PAST_DUE', customPriceCents: 500000 }, others[1]!.id)
    await mkSub(payg.id, { status: 'SUSPENDED', suspendedReason: 'Asked to pause', suspendedAt: new Date() }, others[2]!.id)

    const all = await support.get('/api/console/subscriptions')
    expect(all.status).toBe(200)
    expect(all.body.total).toBe(4)
    expect(all.body.subscriptions.map((s: any) => s.businessName)).toEqual(['Baraka Liquor Store', 'Kilele Spirits', 'Mama Njeri Wines', 'Test Wines'])
    const [baraka, kilele, njeri, test] = all.body.subscriptions
    expect(baraka).toMatchObject({ status: 'SUSPENDED', suspendedReason: 'Asked to pause', nextAmountCents: null, plan: { code: 'payg' } })
    expect(kilele).toMatchObject({ status: 'PAST_DUE', customPriceCents: 500000, nextAmountCents: 500000 + Math.round((500000 * VAT) / 10000) })
    expect(njeri).toMatchObject({ status: 'TRIALING', plan: { id: flat.id, name: 'FLAT' } })
    expect(new Date(njeri.trialEndsAt)).toEqual(ends)
    expect(njeri.nextAmountCents).toBe(priceFor(flat, deal, { branches: 0, salesCents: 0 }, VAT).totalCents)
    expect(test).toMatchObject({ status: 'ACTIVE', discountBps: 500 })
    expect(test.nextAmountCents).toBe(priceFor(flat, { discountBps: 500, customPriceCents: null }, { branches: 2, salesCents: 0 }, VAT).totalCents)
    expect(Object.keys(test).sort()).toEqual(
      ['businessId', 'businessName', 'cancelAtPeriodEnd', 'cancelledAt', 'createdAt', 'currentPeriodEnd', 'currentPeriodStart', 'customPriceCents', 'discountBps', 'id', 'nextAmountCents', 'nextInvoiceAt', 'plan', 'status', 'suspendedAt', 'suspendedReason', 'trialEndsAt']
    )

    const names2 = (r: any) => r.body.subscriptions.map((s: any) => s.businessName)
    expect(names2(await billing.get('/api/console/subscriptions?status=TRIALING'))).toEqual(['Mama Njeri Wines'])
    const byPlan = await billing.get(`/api/console/subscriptions?planId=${payg.id}`)
    expect(names2(byPlan)).toEqual(['Baraka Liquor Store', 'Kilele Spirits'])
    expect(byPlan.body.total).toBe(2)
    expect(names2(await billing.get('/api/console/subscriptions?q=WINES'))).toEqual(['Mama Njeri Wines', 'Test Wines'])
    expect(names2(await billing.get(`/api/console/subscriptions?q=wines&status=ACTIVE&planId=${flat.id}`))).toEqual(['Test Wines'])
    const page = await billing.get('/api/console/subscriptions?limit=2&offset=1')
    expect(names2(page)).toEqual(['Kilele Spirits', 'Mama Njeri Wines'])
    expect(page.body.total).toBe(4)
    for (const bad of ['status=PAUSED', 'limit=0', 'limit=201', 'offset=-1']) {
      expect((await billing.get(`/api/console/subscriptions?${bad}`)).status, bad).toBe(400)
    }
  })
})

describe('who may manage subscriptions', () => {
  it('support reads and extends trials but cannot change plans, terms or cancel', async () => {
    const plan = await mkPlan('flat')
    const other = await mkPlan('other')
    await mkSub(plan.id)
    expect((await support.get('/api/console/subscriptions')).status).toBe(200)
    expect((await support.post(path('plan'), { planId: other.id })).status).toBe(403)
    expect((await support.post(path('terms'), { discountBps: 5000 })).status).toBe(403)
    expect((await support.post(path('cancel'), { atPeriodEnd: false })).status).toBe(403)
    expect((await support.post(path('resume'))).status).toBe(403)
    expect(await subRow()).toMatchObject({ planId: plan.id, status: 'ACTIVE', discountBps: 0, cancelAtPeriodEnd: false })
  })

  it('a shop owner session and no session get 401 everywhere', async () => {
    const plan = await mkPlan('flat')
    const other = await mkPlan('other')
    await mkSub(plan.id)
    const owner = await Client.login('owner')
    for (const who of [owner, new Client()]) {
      expect((await who.get('/api/console/subscriptions')).status).toBe(401)
      expect((await who.post(path('plan'), { planId: other.id })).status).toBe(401)
      expect((await who.post(path('terms'), { discountBps: 10000 })).status).toBe(401)
      expect((await who.post(path('extend-trial'), { days: 30 })).status).toBe(401)
      expect((await who.post(path('cancel'), { atPeriodEnd: false })).status).toBe(401)
      expect((await who.post(path('resume'))).status).toBe(401)
    }
    expect(await subRow()).toMatchObject({ planId: plan.id, status: 'ACTIVE', discountBps: 0 })
  })
})
