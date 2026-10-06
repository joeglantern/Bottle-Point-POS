import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { createStaff } from '../src/lib/users.js'
import { Client, consoleLogin, PIN, resetDb, seedFixture, seedPlatform, type Fixture } from './helpers.js'

let fx: Fixture
let owner: Client
let seq = 0

const DAY = 24 * 60 * 60 * 1000
const ago = (days: number) => new Date(Date.now() - days * DAY)
const iso = (d: Date) => d.toISOString()

const plan = (data: Record<string, unknown> = {}) =>
  prisma.plan.create({ data: { code: `plan${++seq}`, name: 'Standard', model: 'FLAT', priceCents: 250000, maxBranches: 3, maxStaff: 10, ...data } as never })

// A subscription whose current period started 10 days ago.
async function subscribe(businessId: string, planData: Record<string, unknown> = {}, subData: Record<string, unknown> = {}) {
  const p = await plan(planData)
  const start = new Date(ago(10).toISOString().slice(0, 10) + 'T00:00:00Z')
  const end = new Date(start)
  end.setUTCMonth(end.getUTCMonth() + 1)
  const sub = await prisma.subscription.create({
    data: { businessId, planId: p.id, status: 'ACTIVE', currentPeriodStart: start, currentPeriodEnd: end, ...subData } as never
  })
  return { plan: p, sub }
}

function invoice(businessId: string, data: Record<string, unknown> = {}) {
  const n = ++seq
  return prisma.invoice.create({
    data: {
      number: `BP-2026-${String(n).padStart(4, '0')}`, businessId, periodStart: ago(40), periodEnd: ago(10),
      lines: [{ description: 'Standard (monthly)', quantity: 1, unitCents: 250000, amountCents: 250000 }],
      subtotalCents: 250000, taxCents: 40000, totalCents: 290000, issuedAt: ago(n), dueAt: new Date(Date.now() + 5 * DAY), ...data
    } as never
  })
}

async function secondBusiness() {
  const business = await prisma.business.create({ data: { name: 'Other Spirits', legalName: 'Other Spirits Ltd' } })
  await prisma.branch.create({ data: { businessId: business.id, name: 'Karen' } })
  await createStaff(prisma, { businessId: business.id, name: 'other owner', username: 'otherowner', pin: PIN, role: 'OWNER', branchIds: [] })
  return { business, owner: await Client.login('otherowner') }
}

const paidSale = (number: number, totalCents: number, paidAt: Date) =>
  prisma.sale.create({ data: { number, branchId: fx.branches.west.id, createdById: fx.users.cashier.id, status: 'PAID', subtotalCents: totalCents, totalCents, paidAt, createdAt: paidAt } })

beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
  owner = await Client.login('owner')
})

describe('GET /api/admin/billing/status', () => {
  it('answers NONE without a subscription record, to every role', async () => {
    for (const who of ['cashier', 'manager', 'owner']) {
      const r = await (await Client.login(who)).get('/api/admin/billing/status')
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ status: 'NONE', suspendedReason: null, trialEndsAt: null, daysLeftInTrial: null })
    }
  })

  it('counts the days left in a trial, rounded up, and only while trialing', async () => {
    const trialEndsAt = new Date(Date.now() + 3.5 * DAY)
    const { sub } = await subscribe(fx.business.id, {}, { status: 'TRIALING', trialEndsAt })
    const cashier = await Client.login('cashier')
    expect((await cashier.get('/api/admin/billing/status')).body).toEqual({ status: 'TRIALING', suspendedReason: null, trialEndsAt: iso(trialEndsAt), daysLeftInTrial: 4 })
    await prisma.subscription.update({ where: { id: sub.id }, data: { trialEndsAt: ago(2) } })
    expect((await cashier.get('/api/admin/billing/status')).body.daysLeftInTrial).toBe(0)
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'ACTIVE' } })
    expect((await cashier.get('/api/admin/billing/status')).body).toMatchObject({ status: 'ACTIVE', daysLeftInTrial: null })
  })

  it('tells a suspended shop why, and nothing else', async () => {
    await subscribe(fx.business.id, {}, { status: 'SUSPENDED', suspendedReason: 'Invoice BP-2026-0001 is unpaid.', customPriceCents: 100, discountBps: 500 })
    for (const who of ['cashier', 'manager', 'owner']) {
      const r = await (await Client.login(who)).get('/api/admin/billing/status')
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ status: 'SUSPENDED', suspendedReason: 'Invoice BP-2026-0001 is unpaid.', trialEndsAt: null, daysLeftInTrial: null })
    }
  })
})

describe('GET /api/admin/billing', () => {
  it('answers with nulls and usage when there is no subscription', async () => {
    const r = await owner.get('/api/admin/billing')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ subscription: null, plan: null, usage: { branches: 2, staff: 6, products: 3 }, nextInvoice: null, outstandingCents: 0, invoices: [] })
  })

  it('prices the coming period of a flat plan to the cent, with the discount and VAT', async () => {
    const { sub } = await subscribe(fx.business.id, { priceCents: 249999 }, { discountBps: 1250, suspendedReason: null })
    const r = await owner.get('/api/admin/billing')
    expect(r.body.subscription).toEqual({
      status: 'ACTIVE', trialEndsAt: null, currentPeriodStart: iso(sub.currentPeriodStart), currentPeriodEnd: iso(sub.currentPeriodEnd),
      cancelAtPeriodEnd: false, suspendedReason: null, discountBps: 1250
    })
    expect(r.body.plan).toEqual({ name: 'Standard', code: expect.any(String), priceText: 'KSh 2,499.99 a month', limits: { maxBranches: 3, maxStaff: 10, maxProducts: null } })
    const after = new Date(sub.currentPeriodEnd)
    after.setUTCMonth(after.getUTCMonth() + 1)
    // 249999 less 12.5% (31250) is 218749, VAT at 16% is 34999.84, so 35000
    expect(r.body.nextInvoice).toEqual({
      periodStart: iso(sub.currentPeriodEnd), periodEnd: iso(after), issuedOn: iso(sub.currentPeriodEnd),
      lines: [
        { description: 'Standard (monthly)', quantity: 1, unitCents: 249999, amountCents: 249999 },
        { description: 'Discount 12.5%', quantity: 1, unitCents: -31250, amountCents: -31250 }
      ],
      subtotalCents: 218749, taxCents: 35000, totalCents: 253749, salesCents: null, isEstimate: false, note: null
    })
  })

  it('estimates a share of sales plan from sales so far in the current period', async () => {
    const { sub } = await subscribe(fx.business.id, { name: 'Share', model: 'PERCENT_OF_SALES', priceCents: 0, percentBps: 250, minimumCents: 100000 })
    await paidSale(1001, 12000000, ago(5))
    await paidSale(1002, 345678, ago(1))
    await paidSale(1003, 9999999, ago(20)) // before this period
    const r = await owner.get('/api/admin/billing')
    // 2.5% of 12,345,678 cents is 308641.95, so 308642. VAT 49382.72, so 49383.
    expect(r.body.nextInvoice).toMatchObject({
      periodStart: iso(sub.currentPeriodStart), periodEnd: iso(sub.currentPeriodEnd), issuedOn: iso(sub.currentPeriodEnd),
      salesCents: 12345678, subtotalCents: 308642, taxCents: 49383, totalCents: 358025, isEstimate: true
    })
    expect(r.body.nextInvoice.note).toMatch(/^Estimate from sales so far/)
    expect(r.body.nextInvoice.lines).toHaveLength(1)
    expect(r.body.nextInvoice.lines[0].amountCents).toBe(308642)
    expect(r.body.plan.priceText).toBe('2.5% of sales, minimum KSh 1,000 a month')

    // below the floor the minimum fee applies
    await prisma.sale.deleteMany({ where: { number: { in: [1001] } } })
    const low = (await owner.get('/api/admin/billing')).body.nextInvoice
    expect(low).toMatchObject({ salesCents: 345678, subtotalCents: 100000, taxCents: 16000, totalCents: 116000, isEstimate: true })
  })

  it('estimates a per branch plan from the branches open today, and treats an agreed price as fixed', async () => {
    const { sub } = await subscribe(fx.business.id, { model: 'PER_BRANCH', priceCents: 100000, perBranchCents: 150000 })
    const a = (await owner.get('/api/admin/billing')).body.nextInvoice
    expect(a).toMatchObject({ subtotalCents: 400000, taxCents: 64000, totalCents: 464000, isEstimate: true })
    expect(a.note).toMatch(/branches open today/)
    await prisma.subscription.update({ where: { id: sub.id }, data: { customPriceCents: 333333 } })
    const b = (await owner.get('/api/admin/billing')).body.nextInvoice
    expect(b).toMatchObject({ subtotalCents: 333333, taxCents: 53333, totalCents: 386666, isEstimate: false, note: null })
  })

  it('has no next invoice once suspended, cancelled, ending, or on a one time licence already running', async () => {
    const { sub, plan: p } = await subscribe(fx.business.id, {}, { cancelAtPeriodEnd: true })
    expect((await owner.get('/api/admin/billing')).body.nextInvoice).toBeNull()
    for (const status of ['CANCELLED', 'SUSPENDED'] as const) {
      await prisma.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: false, status } })
      expect((await owner.get('/api/admin/billing')).body.nextInvoice).toBeNull()
    }
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'PAST_DUE' } })
    expect((await owner.get('/api/admin/billing')).body.nextInvoice).not.toBeNull()
    await prisma.plan.update({ where: { id: p.id }, data: { model: 'ONE_TIME', interval: 'ONCE' } })
    const r = await owner.get('/api/admin/billing')
    expect(r.body.nextInvoice).toBeNull()
    expect(r.body.plan.priceText).toBe('KSh 2,500 once')
  })

  it('starts the first paid period when the trial ends', async () => {
    const trialEndsAt = new Date('2031-01-31T00:00:00.000Z')
    const { sub, plan: p } = await subscribe(fx.business.id, {}, { status: 'TRIALING', trialEndsAt })
    // 31 January plus a month is clamped to 28 February
    expect((await owner.get('/api/admin/billing')).body.nextInvoice).toMatchObject({
      periodStart: iso(trialEndsAt), periodEnd: '2031-02-28T00:00:00.000Z', issuedOn: iso(trialEndsAt), subtotalCents: 250000, taxCents: 40000, totalCents: 290000, isEstimate: false
    })
    // a one time licence is billed once, at the end of its trial
    await prisma.plan.update({ where: { id: p.id }, data: { model: 'ONE_TIME', interval: 'ONCE' } })
    expect((await owner.get('/api/admin/billing')).body.nextInvoice).toMatchObject({ periodStart: iso(trialEndsAt), totalCents: 290000, isEstimate: false })
    // share of sales: the first billed period has not begun, so it is the minimum for now
    await prisma.plan.update({ where: { id: p.id }, data: { model: 'PERCENT_OF_SALES', interval: 'MONTH', priceCents: 0, percentBps: 300, minimumCents: 50000 } })
    await paidSale(1001, 99999999, ago(2))
    const share = (await owner.get('/api/admin/billing')).body.nextInvoice
    expect(share).toMatchObject({ periodStart: iso(trialEndsAt), periodEnd: '2031-02-28T00:00:00.000Z', issuedOn: '2031-02-28T00:00:00.000Z', salesCents: 0, subtotalCents: 50000, taxCents: 8000, totalCents: 58000, isEstimate: true })
    expect(share.note).toMatch(/trial ends/)
    // without a trial end date the trial runs to the end of the current period
    await prisma.subscription.update({ where: { id: sub.id }, data: { trialEndsAt: null } })
    expect((await owner.get('/api/admin/billing')).body.nextInvoice.periodStart).toBe(iso(sub.currentPeriodEnd))
  })

  it('lists issued invoices, newest first, and counts only open ones as owed', async () => {
    const part = await invoice(fx.business.id, { paidCents: 100001, dueAt: ago(3) }) // open, late, 189999 owed
    const open = await invoice(fx.business.id) // open, not due yet, 290000 owed
    const paid = await invoice(fx.business.id, { status: 'PAID', paidCents: 290000, paidAt: ago(1), dueAt: ago(3) })
    const voided = await invoice(fx.business.id, { status: 'VOID', voidedAt: ago(1), dueAt: ago(3) })
    await invoice(fx.business.id, { status: 'DRAFT', dueAt: ago(3) })
    const r = await owner.get('/api/admin/billing')
    expect(r.body.outstandingCents).toBe(189999 + 290000)
    expect(r.body.invoices.map((i: any) => [i.number, i.status, i.overdue])).toEqual([
      [part.number, 'OPEN', true], [open.number, 'OPEN', false], [paid.number, 'PAID', false], [voided.number, 'VOID', false]
    ])
    expect(r.body.invoices[0]).toEqual({
      id: part.id, number: part.number, issuedAt: iso(part.issuedAt), dueAt: iso(part.dueAt), periodStart: iso(part.periodStart),
      periodEnd: iso(part.periodEnd), totalCents: 290000, paidCents: 100001, status: 'OPEN', overdue: true
    })
  })

  it('shows the last 24 invoices but adds up everything still owed', async () => {
    for (let i = 0; i < 26; i++) await invoice(fx.business.id, { subtotalCents: 100, taxCents: 16, totalCents: 116 })
    const r = await owner.get('/api/admin/billing')
    expect(r.body.invoices).toHaveLength(24)
    expect(r.body.outstandingCents).toBe(26 * 116)
  })
})

describe('GET /api/admin/billing/invoices/:id', () => {
  it('returns the full invoice without internal fields', async () => {
    await prisma.business.update({ where: { id: fx.business.id }, data: { legalName: 'Test Wines Ltd', kraPin: 'P051234567X', address: 'Westlands, Nairobi', email: 'a@test.ke', phone: '0700000000' } })
    const inv = await invoice(fx.business.id, { paidCents: 100001, notes: 'internal: chase on Friday' })
    const pay = await prisma.invoicePayment.create({ data: { invoiceId: inv.id, amountCents: 100001, method: 'MPESA', reference: 'SJK4ABCDE9', receivedAt: ago(1), recordedById: 'staff_secret_id' } })
    const r = await owner.get(`/api/admin/billing/invoices/${inv.id}`)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      invoice: {
        id: inv.id, number: inv.number, status: 'OPEN', issuedAt: iso(inv.issuedAt), dueAt: iso(inv.dueAt), periodStart: iso(inv.periodStart), periodEnd: iso(inv.periodEnd),
        lines: [{ description: 'Standard (monthly)', quantity: 1, unitCents: 250000, amountCents: 250000 }],
        subtotalCents: 250000, taxCents: 40000, totalCents: 290000, paidCents: 100001, balanceCents: 189999, overdue: false, paidAt: null, voidedAt: null,
        payments: [{ id: pay.id, amountCents: 100001, method: 'MPESA', reference: 'SJK4ABCDE9', receivedAt: iso(pay.receivedAt) }],
        client: { name: 'Test Wines', legalName: 'Test Wines Ltd', address: 'Westlands, Nairobi', kraPin: 'P051234567X', email: 'a@test.ke', phone: '0700000000' }
      }
    })
    expect(JSON.stringify(r.body)).not.toMatch(/staff_secret_id|chase on Friday|recordedById|notes/)
  })

  it('owes nothing on a void invoice and hides drafts and unknown ids', async () => {
    const voided = await invoice(fx.business.id, { status: 'VOID', voidedAt: ago(1), dueAt: ago(3) })
    const draft = await invoice(fx.business.id, { status: 'DRAFT' })
    expect((await owner.get(`/api/admin/billing/invoices/${voided.id}`)).body.invoice).toMatchObject({ status: 'VOID', balanceCents: 0, overdue: false })
    expect((await owner.get(`/api/admin/billing/invoices/${draft.id}`)).status).toBe(404)
    expect((await owner.get('/api/admin/billing/invoices/nope')).status).toBe(404)
  })
})

describe('GET /api/admin/billing/plans', () => {
  it('lists active public plans in order and marks the current one', async () => {
    const { plan: mine } = await subscribe(fx.business.id, { name: 'Standard', sortOrder: 2, description: 'For one shop', features: { exports: true } })
    await plan({ name: 'Growth', model: 'PER_BRANCH', priceCents: 0, perBranchCents: 200000, sortOrder: 3, maxBranches: null, maxStaff: null })
    await plan({ name: 'Lite', priceCents: 99900, sortOrder: 1 })
    await plan({ name: 'Secret deal', public: false })
    await plan({ name: 'Retired', active: false })
    const r = await owner.get('/api/admin/billing/plans')
    expect(r.status).toBe(200)
    expect(r.body.plans.map((p: any) => [p.name, p.priceText, p.current])).toEqual([
      ['Lite', 'KSh 999 a month', false], ['Standard', 'KSh 2,500 a month', true], ['Growth', 'KSh 2,000 per branch a month', false]
    ])
    expect(r.body.plans[1]).toEqual({
      code: mine.code, name: 'Standard', description: 'For one shop', model: 'FLAT', interval: 'MONTH', priceText: 'KSh 2,500 a month', trialDays: 14,
      limits: { maxBranches: 3, maxStaff: 10, maxProducts: null }, features: { exports: true }, current: true
    })
  })
})

describe('who may read billing', () => {
  it('is the owner only, apart from the status', async () => {
    const inv = await invoice(fx.business.id)
    const platform = await seedPlatform()
    const consoleUser = await consoleLogin(platform.billing.email!)
    const paths = ['/api/admin/billing', '/api/admin/billing/plans', `/api/admin/billing/invoices/${inv.id}`]
    for (const who of ['cashier', 'manager']) {
      const c = await Client.login(who)
      for (const p of paths) expect((await c.get(p)).status).toBe(403)
    }
    for (const p of [...paths, '/api/admin/billing/status']) {
      expect((await owner.get(p)).status).toBe(200)
      expect((await consoleUser.get(p)).status).toBe(401)
      expect((await new Client().get(p)).status).toBe(401)
    }
  })

  it('stays open to a suspended or cancelled business, while the rest of the API answers 402', async () => {
    const { sub } = await subscribe(fx.business.id, {}, { status: 'SUSPENDED', suspendedReason: 'Unpaid invoice' })
    const inv = await invoice(fx.business.id, { subscriptionId: sub.id, dueAt: ago(20) })
    const cashier = await Client.login('cashier')
    for (const status of ['SUSPENDED', 'CANCELLED'] as const) {
      await prisma.subscription.update({ where: { id: sub.id }, data: { status } })
      const page = await owner.get('/api/admin/billing')
      expect(page.status).toBe(200)
      expect(page.body).toMatchObject({ subscription: { status, suspendedReason: 'Unpaid invoice' }, outstandingCents: 290000 })
      expect(page.body.invoices[0]).toMatchObject({ id: inv.id, overdue: true })
      expect((await owner.get('/api/admin/billing/plans')).status).toBe(200)
      expect((await owner.get(`/api/admin/billing/invoices/${inv.id}`)).status).toBe(200)
      expect((await cashier.get('/api/admin/billing/status')).body.status).toBe(status)
      expect((await cashier.get('/api/admin/billing')).status).toBe(403)
      for (const kind of ['sales', 'sale-lines', 'payments', 'stock', 'products']) expect((await owner.get(`/api/admin/export/${kind}.csv`)).status).toBe(402)
    }
  })

  it('keeps each business to its own subscription and invoices', async () => {
    const other = await secondBusiness()
    await subscribe(fx.business.id, { name: 'Private deal', public: false }, { customPriceCents: 123400, discountBps: 700 })
    const mine = await invoice(fx.business.id)
    const theirs = await invoice(other.business.id, { subtotalCents: 1000, taxCents: 160, totalCents: 1160 })

    const page = await other.owner.get('/api/admin/billing')
    expect(page.body).toMatchObject({ subscription: null, plan: null, nextInvoice: null, outstandingCents: 1160, usage: { branches: 1, staff: 1, products: 0 } })
    expect(page.body.invoices.map((i: any) => i.id)).toEqual([theirs.id])
    expect((await other.owner.get(`/api/admin/billing/invoices/${mine.id}`)).status).toBe(404)
    expect((await owner.get(`/api/admin/billing/invoices/${theirs.id}`)).status).toBe(404)
    expect((await other.owner.get(`/api/admin/billing/invoices/${theirs.id}`)).body.invoice.client.legalName).toBe('Other Spirits Ltd')
    expect((await other.owner.get('/api/admin/billing/status')).body.status).toBe('NONE')
    const plans = await other.owner.get('/api/admin/billing/plans')
    expect(JSON.stringify(plans.body)).not.toMatch(/Private deal|123400/)
    expect((await owner.get('/api/admin/billing')).body.invoices.map((i: any) => i.id)).toEqual([mine.id])
  })
})
