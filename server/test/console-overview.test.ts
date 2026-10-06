import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { platformAudit } from '../src/lib/audit.js'
import { createStaff } from '../src/lib/users.js'
import { createInvoice, DAY_MS, nairobiMonthKey, nairobiMonthStart } from '../src/rules/platform.js'
import { app, Client, consoleLogin, ORIGIN, PIN, resetDb, seedFixture, seedPlatform, type Fixture } from './helpers.js'

let fx: Fixture
let staff: Awaited<ReturnType<typeof seedPlatform>>

beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
  staff = await seedPlatform()
})

const login = (who: 'admin' | 'support' | 'billing') => consoleLogin(staff[who].email)

// An invoice with a plain total (no tax), dated where the test wants it.
async function invoice(businessId: string, totalCents: number, issuedAt: Date, dueAt: Date) {
  return prisma.$transaction(tx =>
    createInvoice(tx, {
      businessId,
      periodStart: issuedAt,
      periodEnd: new Date(issuedAt.getTime() + 30 * DAY_MS),
      priced: {
        lines: [{ description: 'Test', quantity: 1, unitCents: totalCents, amountCents: totalCents }],
        subtotalCents: totalCents,
        taxCents: 0,
        totalCents
      },
      issuedAt,
      dueAt
    })
  )
}

async function pay(invoiceId: string, amountCents: number, receivedAt: Date) {
  await prisma.invoicePayment.create({
    data: { invoiceId, amountCents, method: 'MPESA', receivedAt, recordedById: staff.billing.id }
  })
  const inv = await prisma.invoice.update({ where: { id: invoiceId }, data: { paidCents: { increment: amountCents } } })
  if (inv.paidCents === inv.totalCents) await prisma.invoice.update({ where: { id: invoiceId }, data: { status: 'PAID', paidAt: receivedAt } })
}

// Every pricing model, every subscription status, and money either side of
// the Nairobi month boundary (21:00 UTC on the last day of the month before).
async function dataset() {
  const now = new Date()
  const m0 = nairobiMonthStart(now)
  const lastMonth = new Date(m0.getTime() - 1)
  const mPrev = nairobiMonthStart(now, -1)
  const days = (n: number) => new Date(now.getTime() + n * DAY_MS)

  const plan = (code: string, sortOrder: number, data: Record<string, unknown>) =>
    prisma.plan.create({ data: { code, name: code, sortOrder, model: 'FLAT', ...data } as never })
  const plans = {
    flat: await plan('flat', 1, { priceCents: 250000 }),
    branch: await plan('branch', 2, { model: 'PER_BRANCH', priceCents: 150000, perBranchCents: 150000 }),
    payg: await plan('payg', 3, { model: 'PERCENT_OF_SALES', percentBps: 150, minimumCents: 100000 }),
    annual: await plan('annual', 4, { interval: 'YEAR', priceCents: 3900000 }),
    licence: await plan('licence', 5, { model: 'ONE_TIME', interval: 'ONCE', priceCents: 8500000 }),
    archived: await plan('archived', 6, { priceCents: 100000, active: false })
  }

  const business = (name: string, createdAt = lastMonth) => prisma.business.create({ data: { name, createdAt } })
  const subscribe = (businessId: string, planId: string, data: Record<string, unknown> = {}) =>
    prisma.subscription.create({
      data: { businessId, planId, status: 'ACTIVE', currentPeriodStart: days(-10), currentPeriodEnd: days(20), ...data } as never
    })

  // the fixture business: two active branches on the per branch plan
  await prisma.business.update({ where: { id: fx.business.id }, data: { createdAt: lastMonth } })
  await subscribe(fx.business.id, plans.branch.id)

  const alpha = await business('Alpha Flat')
  await subscribe(alpha.id, plans.flat.id, { discountBps: 1000 })

  const bravo = await business('Bravo Payg')
  const bravoBranch = await prisma.branch.create({ data: { businessId: bravo.id, name: 'Main' } })
  const bravoOwner = await createStaff(prisma, {
    businessId: bravo.id,
    name: 'Bravo Owner',
    username: 'bravo-owner',
    pin: PIN,
    role: 'OWNER',
    branchIds: []
  })
  await subscribe(bravo.id, plans.payg.id, { status: 'PAST_DUE' })

  const charlie = await business('Charlie Annual')
  await subscribe(charlie.id, plans.annual.id, { customPriceCents: 3600000 })

  const delta = await business('Delta Licence')
  await subscribe(delta.id, plans.licence.id)

  const echo = await business('Echo Trial', now)
  await subscribe(echo.id, plans.flat.id, { status: 'TRIALING', trialEndsAt: days(3), currentPeriodEnd: days(3) })

  const foxtrot = await business('Foxtrot Trial Far')
  await subscribe(foxtrot.id, plans.flat.id, { status: 'TRIALING', trialEndsAt: days(10), currentPeriodEnd: days(10) })

  const golf = await business('Golf Suspended')
  await subscribe(golf.id, plans.flat.id, { status: 'SUSPENDED', suspendedReason: 'Unpaid invoice INV-X', suspendedAt: days(-1) })

  const hotel = await business('Hotel Cancelled')
  await subscribe(hotel.id, plans.flat.id, { status: 'CANCELLED', cancelledAt: m0 })

  const india = await business('India Cancelled Old')
  await subscribe(india.id, plans.flat.id, { status: 'CANCELLED', cancelledAt: lastMonth })

  // no subscription record, created on the first instant of this month
  const juliet = await business('Juliet None', m0)

  // invoices and payments
  const paidNow = await invoice(alpha.id, 290000, m0, days(5))
  await pay(paidNow.id, 290000, m0)
  const partPrev = await invoice(alpha.id, 290000, lastMonth, days(5))
  await pay(partPrev.id, 100000, lastMonth)
  const overdue = await invoice(bravo.id, 174000, mPrev, days(-10))
  const voided = await invoice(bravo.id, 50000, new Date(mPrev.getTime() - 1), days(-20))
  await prisma.invoice.update({ where: { id: voided.id }, data: { status: 'VOID', voidedAt: now } })
  const big = await invoice(charlie.id, 4176000, m0, days(7))
  await pay(big.id, 1000000, now)
  const zero = await invoice(delta.id, 0, m0, days(7))
  // just before the 12 month window
  const ancient = await invoice(alpha.id, 99900, new Date(nairobiMonthStart(now, -11).getTime() - 1), days(-300))
  await pay(ancient.id, 99900, new Date(nairobiMonthStart(now, -11).getTime() - 1))

  // sales through client tills
  let no = 1
  const sale = (branchId: string, createdById: string, totalCents: number, paidAt: Date | null, status = 'PAID') =>
    prisma.sale.create({
      data: { number: no++, branchId, createdById, totalCents, subtotalCents: totalCents, paidAt, status } as never
    })
  const sales: { cents: number; at: Date }[] = []
  const paidSale = async (branchId: string, userId: string, cents: number, at: Date, status = 'PAID') => {
    sales.push({ cents, at })
    return sale(branchId, userId, cents, at, status)
  }
  const refundedSale = await paidSale(bravoBranch.id, bravoOwner.id, 6000000, days(-1), 'REFUNDED')
  await paidSale(bravoBranch.id, bravoOwner.id, 4000000, days(-29))
  // outside the 30 days that feed MRR
  await paidSale(bravoBranch.id, bravoOwner.id, 7777700, days(-31))
  await sale(bravoBranch.id, bravoOwner.id, 999900, null, 'CANCELLED')
  await paidSale(fx.branches.west.id, fx.users.cashier.id, 123400, m0)
  await paidSale(fx.branches.west.id, fx.users.cashier.id, 55500, lastMonth)
  const approval = await prisma.approval.create({
    data: { saleId: refundedSale.id, kind: 'REFUND', status: 'APPROVED', reason: 'Broken bottle', requestedById: bravoOwner.id } as never
  })
  await prisma.refund.create({
    data: { saleId: refundedSale.id, approvalId: approval.id, amountCents: 1000000, method: 'CASH', paidOutById: bravoOwner.id, createdAt: days(-1) }
  })
  sales.push({ cents: -1000000, at: days(-1) })

  return { now, m0, lastMonth, mPrev, plans, alpha, bravo, charlie, delta, echo, foxtrot, golf, hotel, india, juliet, overdue, sales }
}

describe('console overview', () => {
  it('reports the dashboard figures for a constructed dataset', async () => {
    const d = await dataset()
    // the Nairobi month starts at 21:00 UTC on the last day of the month before
    expect(d.m0.toISOString().endsWith('T21:00:00.000Z')).toBe(true)
    expect(nairobiMonthKey(d.m0)).not.toBe(nairobiMonthKey(d.lastMonth))

    const admin = await login('admin')
    const res = await admin.get('/api/console/overview')
    expect(res.status).toBe(200)
    const o = res.body.overview

    // branch 150000 + 2 x 150000, flat 250000 less 10%, 1.5% of 9,000,000 net
    // sales, agreed 3,600,000 a year over 12, and nothing for the licence
    expect(o.mrrCents).toBe(450000 + 225000 + 135000 + 300000)
    expect(o.arrCents).toBe(o.mrrCents * 12)
    expect(o.counts).toEqual({ TRIALING: 2, ACTIVE: 4, PAST_DUE: 1, SUSPENDED: 1, CANCELLED: 2, NONE: 1, total: 11 })

    expect(o.outstandingCents).toBe(190000 + 174000 + 3176000)
    expect(o.outstandingCount).toBe(3)
    expect(o.overdueCents).toBe(174000)
    expect(o.overdueCount).toBe(1)
    expect(o.collectedThisMonthCents).toBe(290000 + 1000000)
    expect(o.newClientsThisMonth).toBe(2)
    expect(o.churnedThisMonth).toBe(1)

    expect(o.trialsEndingSoon).toHaveLength(1)
    expect(o.trialsEndingSoon[0]).toMatchObject({
      businessId: d.echo.id,
      name: 'Echo Trial',
      plan: { id: d.plans.flat.id, name: 'flat' },
      daysLeft: 3
    })
    expect(new Date(o.trialsEndingSoon[0].trialEndsAt).getTime()).toBeGreaterThan(d.now.getTime())

    // twelve Nairobi months, oldest first, zero filled
    const keys = Array.from({ length: 12 }, (_, i) => nairobiMonthKey(nairobiMonthStart(d.now, i - 11)))
    expect(o.revenueByMonth.map((m: any) => m.month)).toEqual(keys)
    expect(o.salesByMonth.map((m: any) => m.month)).toEqual(keys)
    const revenue = Object.fromEntries(o.revenueByMonth.map((m: any) => [m.month, m]))
    expect(revenue[keys[11]!]).toEqual({ month: keys[11], invoicedCents: 290000 + 4176000, collectedCents: 1290000 })
    // one instant before the boundary lands in the month before; the void invoice is left out
    expect(revenue[keys[10]!]).toEqual({ month: keys[10], invoicedCents: 290000 + 174000, collectedCents: 100000 })
    expect(revenue[keys[9]!]).toEqual({ month: keys[9], invoicedCents: 0, collectedCents: 0 })
    expect(revenue[keys[0]!]).toEqual({ month: keys[0], invoicedCents: 0, collectedCents: 0 })
    expect(o.revenueByMonth.reduce((a: number, m: any) => a + m.invoicedCents, 0)).toBe(290000 + 4176000 + 290000 + 174000)

    const expectedSales: Record<string, number> = Object.fromEntries(keys.map(k => [k, 0]))
    for (const s of d.sales) expectedSales[nairobiMonthKey(s.at)]! += s.cents
    for (const m of o.salesByMonth) expect(m.salesCents).toBe(expectedSales[m.month])
    expect(o.salesByMonth.reduce((a: number, m: any) => a + m.salesCents, 0)).toBe(6000000 + 4000000 + 7777700 + 123400 + 55500 - 1000000)
    expect(o.salesByMonth.reduce((a: number, m: any) => a + m.salesCount, 0)).toBe(5)

    expect(o.planMix).toEqual([
      { planId: d.plans.flat.id, code: 'flat', name: 'flat', clients: 4, mrrCents: 225000 },
      { planId: d.plans.branch.id, code: 'branch', name: 'branch', clients: 1, mrrCents: 450000 },
      { planId: d.plans.payg.id, code: 'payg', name: 'payg', clients: 1, mrrCents: 135000 },
      { planId: d.plans.annual.id, code: 'annual', name: 'annual', clients: 1, mrrCents: 300000 },
      { planId: d.plans.licence.id, code: 'licence', name: 'licence', clients: 1, mrrCents: 0 }
    ])

    expect(o.attention).toHaveLength(3)
    const byKind = Object.fromEntries(o.attention.map((a: any) => [a.kind, a]))
    expect(byKind.past_due).toMatchObject({
      businessId: d.bravo.id,
      name: 'Bravo Payg',
      status: 'PAST_DUE',
      reason: `Invoice ${d.overdue.number} is 10 days overdue`,
      amountCents: 174000
    })
    expect(byKind.suspended).toMatchObject({ businessId: d.golf.id, status: 'SUSPENDED', reason: 'Suspended: Unpaid invoice INV-X', amountCents: null })
    expect(byKind.trial_ending).toMatchObject({ businessId: d.echo.id, status: 'TRIALING', reason: 'Trial ends in 3 days' })
  })

  it('answers zeros on an empty platform', async () => {
    const admin = await login('admin')
    const o = (await admin.get('/api/console/overview')).body.overview
    expect(o.mrrCents).toBe(0)
    expect(o.arrCents).toBe(0)
    expect(o.counts).toEqual({ TRIALING: 0, ACTIVE: 0, PAST_DUE: 0, SUSPENDED: 0, CANCELLED: 0, NONE: 1, total: 1 })
    expect(o.outstandingCents).toBe(0)
    expect(o.overdueCount).toBe(0)
    expect(o.collectedThisMonthCents).toBe(0)
    expect(o.revenueByMonth).toHaveLength(12)
    expect(o.salesByMonth.every((m: any) => m.salesCents === 0 && m.salesCount === 0)).toBe(true)
    expect(o.planMix).toEqual([])
    expect(o.attention).toEqual([])
    expect(o.trialsEndingSoon).toEqual([])
  })

  it('shows the last ten audit rows in a friendly shape', async () => {
    const d = await dataset()
    const admin = await login('admin')
    for (let i = 0; i < 12; i++) await platformAudit(prisma, staff.support, 'console.note.added', 'TenantNote', null, {}, d.alpha.id)
    await platformAudit(prisma, staff.admin, 'console.tenant.suspended', 'Subscription', null, { reason: 'Asked to' }, d.golf.id)
    await platformAudit(prisma, null, 'billing.invoice_created', 'Invoice', d.overdue.id, { number: d.overdue.number }, d.bravo.id)
    await prisma.auditLog.create({
      data: { userId: fx.users.owner.id, businessId: fx.business.id, action: 'product.updated', entity: 'Product', entityId: null }
    })

    const rows = (await admin.get('/api/console/overview')).body.overview.recentActivity
    expect(rows).toHaveLength(10)
    expect(typeof rows[0].id).toBe('string')
    expect(Number(rows[0].id)).toBeGreaterThan(Number(rows[1].id))
    expect(rows[0]).toMatchObject({
      action: 'product.updated',
      summary: 'Product updated: Test Wines',
      actor: { id: fx.users.owner.id, name: 'owner', kind: 'shop' },
      business: { id: fx.business.id, name: 'Test Wines' }
    })
    expect(rows[1]).toMatchObject({
      action: 'billing.invoice_created',
      summary: `Invoice created ${d.overdue.number}: Bravo Payg`,
      actor: { id: null, name: 'System', kind: 'system' },
      business: { id: d.bravo.id, name: 'Bravo Payg' }
    })
    expect(rows[2]).toMatchObject({
      action: 'console.tenant.suspended',
      summary: 'Tenant suspended: Golf Suspended',
      actor: { id: staff.admin.id, name: 'admin', kind: 'platform' }
    })
    expect(rows[3]).toMatchObject({ action: 'console.note.added', actor: { kind: 'platform', name: 'support' } })
    expect(new Date(rows[0].at).getTime()).not.toBeNaN()
  })
})

describe('console search', () => {
  it('finds clients by name, owner username and id, and invoices by number', async () => {
    const d = await dataset()
    const admin = await login('admin')

    const byName = await admin.get('/api/console/search?q=ALPHA')
    expect(byName.status).toBe(200)
    expect(byName.body.tenants).toEqual([
      { id: d.alpha.id, name: 'Alpha Flat', status: 'ACTIVE', plan: { id: d.plans.flat.id, name: 'flat' }, owners: [] }
    ])
    expect(byName.body.invoices).toEqual([])

    const byOwner = await admin.get('/api/console/search?q=Bravo-Own')
    expect(byOwner.body.tenants.map((t: any) => t.id)).toEqual([d.bravo.id])
    expect(byOwner.body.tenants[0].owners).toEqual([{ name: 'Bravo Owner', username: 'bravo-owner' }])
    expect(byOwner.body.tenants[0].status).toBe('PAST_DUE')

    // only owner usernames identify a client
    expect((await admin.get('/api/console/search?q=kilicashier')).body.tenants).toEqual([])

    const byId = await admin.get(`/api/console/search?q=${d.juliet.id}`)
    expect(byId.body.tenants).toEqual([{ id: d.juliet.id, name: 'Juliet None', status: 'NONE', plan: null, owners: [] }])

    const byNumber = await admin.get(`/api/console/search?q=${d.overdue.number.toLowerCase()}`)
    expect(byNumber.body.invoices).toHaveLength(1)
    expect(byNumber.body.invoices[0]).toMatchObject({
      id: d.overdue.id,
      number: d.overdue.number,
      businessId: d.bravo.id,
      businessName: 'Bravo Payg',
      status: 'OPEN',
      overdue: true,
      totalCents: 174000,
      paidCents: 0,
      balanceCents: 174000
    })
    expect(byNumber.body.tenants).toEqual([])
  })

  it('returns at most eight of each and nothing for an empty query', async () => {
    const admin = await login('admin')
    const now = new Date()
    for (let i = 0; i < 10; i++) {
      const b = await prisma.business.create({ data: { name: `Zulu Shop ${i}` } })
      await invoice(b.id, 1000 + i, now, new Date(now.getTime() + DAY_MS))
    }
    const res = await admin.get('/api/console/search?q=zulu')
    expect(res.body.tenants).toHaveLength(8)
    expect(res.body.tenants[0].name).toBe('Zulu Shop 0')
    const inv = await admin.get('/api/console/search?q=INV-')
    expect(inv.body.invoices).toHaveLength(8)
    expect(inv.body.invoices[0].overdue).toBe(false)

    expect((await admin.get('/api/console/search')).body).toEqual({ tenants: [], invoices: [] })
    expect((await admin.get('/api/console/search?q=%20%20')).body).toEqual({ tenants: [], invoices: [] })
    expect((await admin.get(`/api/console/search?q=${'x'.repeat(101)}`)).status).toBe(400)
    // wildcards are plain text, not patterns
    expect((await admin.get('/api/console/search?q=%25')).body.tenants).toEqual([])
  })
})

describe('console overview and search access', () => {
  const paths = ['/api/console/overview', '/api/console/search?q=test']

  it('lets every console role read', async () => {
    for (const who of ['admin', 'support', 'billing'] as const) {
      const client = await login(who)
      for (const path of paths) expect((await client.get(path)).status).toBe(200)
    }
  })

  it('refuses a shop session and no session with 401', async () => {
    const owner = await Client.login('owner')
    for (const path of paths) {
      expect((await owner.get(path)).status).toBe(401)
      const res = await app.request(path, { headers: { origin: ORIGIN } })
      expect(res.status).toBe(401)
    }
  })
})
