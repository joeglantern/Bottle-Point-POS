import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { env } from '../src/env.js'
import { createPlatformUser } from '../src/lib/users.js'
import { priceFor, type InvoiceLine } from '../src/rules/pricing.js'
import { salesCentsBetween } from '../src/rules/usage.js'
import { DEFAULT_PLANS, DEMO_BUSINESS, DEMO_CLIENTS, seedDemo } from '../prisma/seed.js'
import { Client, resetDb } from './helpers.js'

const quiet = () => {}
// seeding hashes a PIN per staff member and rings up every sale for real
const LONG = 180_000
const DAY = 86_400_000

// Row counts of everything the seed writes.
async function counts() {
  const [business, branch, user, account, product, stock, movement, customer, shift, sale, payment, plan, subscription, invoice, invoicePayment, audit] =
    await Promise.all([
      prisma.business.count(),
      prisma.branch.count(),
      prisma.user.count(),
      prisma.account.count(),
      prisma.product.count(),
      prisma.stock.count(),
      prisma.stockMovement.count(),
      prisma.customer.count(),
      prisma.shift.count(),
      prisma.sale.count(),
      prisma.payment.count(),
      prisma.plan.count(),
      prisma.subscription.count(),
      prisma.invoice.count(),
      prisma.invoicePayment.count(),
      prisma.auditLog.count()
    ])
  return { business, branch, user, account, product, stock, movement, customer, shift, sale, payment, plan, subscription, invoice, invoicePayment, audit }
}

const client = (state: string) => DEMO_CLIENTS.find(c => c.billing.state === state)!
const subOf = (name: string) =>
  prisma.subscription.findFirstOrThrow({
    where: { business: { name } },
    include: { plan: true, invoices: { orderBy: { periodStart: 'asc' }, include: { payments: true } } }
  })

beforeAll(async () => {
  await resetDb()
})

describe('demo seed', () => {
  it(
    'creates a consistent demo business',
    async () => {
      const r = await seedDemo({ log: quiet })
      expect(r.created).toBe(true)

      const business = await prisma.business.findFirstOrThrow({ where: { name: DEMO_BUSINESS } })
      expect(await prisma.branch.count({ where: { businessId: business.id } })).toBe(3)
      expect(await prisma.product.count({ where: { businessId: business.id } })).toBe(15)
      expect(await prisma.customer.count({ where: { businessId: business.id } })).toBe(6)

      // every paid sale is fully covered by its payments, and nothing is overpaid
      const sales = await prisma.sale.findMany({ include: { payments: true, lines: true } })
      expect(sales.length).toBeGreaterThan(0)
      for (const s of sales) {
        const lines = s.lines.reduce((a, l) => a + l.unitCents * l.qty, 0)
        expect(s.subtotalCents).toBe(lines)
        const paid = s.payments.reduce((a, p) => a + p.amountCents, 0)
        if (s.status === 'PAID') expect(paid).toBe(s.totalCents)
        else expect(paid).toBeLessThan(s.totalCents)
      }
      expect(sales.some(s => s.status === 'SAVED')).toBe(true)

      // stock movements for sales match the paid lines
      const movements = await prisma.stockMovement.aggregate({ where: { reason: 'SALE' }, _sum: { delta: true } })
      const soldQty = sales.filter(s => s.status === 'PAID').flatMap(s => s.lines).reduce((a, l) => a + l.qty, 0)
      expect(movements._sum.delta).toBe(-soldQty)
    },
    LONG
  )

  it('demo staff can sign in with the demo PIN', async () => {
    for (const u of ['wanjiru', 'otieno', 'achieng']) {
      const c = await Client.login(u, '1234')
      expect((await c.get('/api/session/me')).status).toBe(200)
    }
  })

  it('adds the default plans', async () => {
    const plans = await prisma.plan.findMany({ orderBy: { sortOrder: 'asc' } })
    expect(plans.map(p => p.code)).toEqual(['starter', 'growth', 'payg', 'annual', 'licence'])
    expect(plans.map(p => p.code)).toEqual(DEFAULT_PLANS.map(p => p.code))
    const by = Object.fromEntries(plans.map(p => [p.code, p]))
    expect(by.starter).toMatchObject({ name: 'Starter', model: 'FLAT', interval: 'MONTH', priceCents: 250000, maxBranches: 1, maxStaff: 5, maxProducts: 300, trialDays: 14, active: true, public: true })
    expect(by.growth).toMatchObject({ name: 'Growth', model: 'PER_BRANCH', interval: 'MONTH', priceCents: 150000, perBranchCents: 150000, maxBranches: 5, maxStaff: 30, maxProducts: null, trialDays: 14 })
    expect(by.payg).toMatchObject({ name: 'Pay as you sell', model: 'PERCENT_OF_SALES', interval: 'MONTH', percentBps: 150, minimumCents: 100000, trialDays: 14 })
    expect(by.annual).toMatchObject({ name: 'Growth yearly', model: 'FLAT', interval: 'YEAR', priceCents: 3900000, trialDays: 14 })
    expect(by.licence).toMatchObject({ name: 'Lifetime licence', model: 'ONE_TIME', interval: 'ONCE', priceCents: 8500000, trialDays: 0, public: false })
  })

  it('puts the demo shop on growth with two paid invoices and one open', async () => {
    const sub = await subOf(DEMO_BUSINESS)
    expect(sub.status).toBe('ACTIVE')
    expect(sub.plan.code).toBe('growth')
    expect(sub.invoices.map(i => i.status)).toEqual(['PAID', 'PAID', 'OPEN'])

    // base fee plus three branches, plus VAT, straight from the pricing rules
    const priced = priceFor(sub.plan, sub, { branches: 3, salesCents: 0 }, env.PLATFORM_VAT_BPS)
    expect(priced.subtotalCents).toBe(600000)
    for (const inv of sub.invoices) {
      expect(inv.totalCents).toBe(priced.totalCents)
      expect(inv.taxCents).toBe(priced.taxCents)
    }
    const open = sub.invoices[2]!
    expect(open.periodStart).toEqual(sub.currentPeriodStart)
    expect(open.periodEnd).toEqual(sub.currentPeriodEnd)
    expect(open.dueAt.getTime()).toBeGreaterThan(Date.now())
    expect(sub.currentPeriodStart.getTime()).toBeLessThanOrEqual(Date.now())
    expect(sub.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now())
  })

  it('creates six demo clients, one in each state', async () => {
    expect(DEMO_CLIENTS.map(c => c.billing.state).sort()).toEqual(['ACTIVE', 'ACTIVE', 'CANCELLED', 'PAST_DUE', 'SUSPENDED', 'TRIALING'])
    expect(new Set(DEMO_CLIENTS.map(c => c.username)).size).toBe(6)
    const now = Date.now()

    for (const c of DEMO_CLIENTS) {
      const business = await prisma.business.findFirstOrThrow({ where: { name: c.name }, include: { branches: true, users: true } })
      expect(business.branches.map(b => b.name)).toEqual([c.branch])
      expect(business.users.map(u => [u.username, u.role])).toEqual([[c.username, 'OWNER']])
      expect(await prisma.product.count({ where: { businessId: business.id } })).toBe(4)
      expect(await prisma.sale.count({ where: { branch: { businessId: business.id }, status: 'PAID' } })).toBe(c.salesDaysAgo.length)
      expect((await subOf(c.name)).status).toBe(c.billing.state)
    }

    const trial = await subOf(client('TRIALING').name)
    expect(trial.invoices).toHaveLength(0)
    expect(Math.abs(trial.trialEndsAt!.getTime() - (now + 3 * DAY))).toBeLessThan(DAY / 2)

    const pastDue = await subOf(client('PAST_DUE').name)
    const owed = pastDue.invoices.filter(i => i.status === 'OPEN')
    expect(owed).toHaveLength(1)
    // more than a week overdue, less than the three weeks that suspend
    const lateDays = (now - owed[0]!.dueAt.getTime()) / DAY
    expect(lateDays).toBeGreaterThan(7)
    expect(lateDays).toBeLessThan(21)
    expect(pastDue.invoices.some(i => i.status === 'PAID')).toBe(true)

    const suspended = await subOf(client('SUSPENDED').name)
    const unpaid = suspended.invoices.filter(i => i.status === 'OPEN')
    expect(unpaid).toHaveLength(1)
    expect(suspended.suspendedReason).toBe(`Unpaid invoice ${unpaid[0]!.number}`)
    expect(suspended.suspendedAt!.getTime()).toBeLessThan(now)
    expect((now - unpaid[0]!.dueAt.getTime()) / DAY).toBeGreaterThan(21)

    const cancelled = await subOf(client('CANCELLED').name)
    expect(cancelled.cancelledAt!.getTime()).toBeLessThan(now)
    expect(cancelled.invoices.length).toBeGreaterThan(0)
    expect(cancelled.invoices.every(i => i.status === 'PAID')).toBe(true)

    // share of sales: billed in arrears from the sales of each finished period
    const payg = await subOf('Baraka Wines and Spirits')
    expect(payg.plan.code).toBe('payg')
    expect(payg.invoices.length).toBeGreaterThanOrEqual(3)
    const subtotals: number[] = []
    for (const inv of payg.invoices) {
      expect(inv.periodEnd.getTime()).toBeLessThanOrEqual(payg.currentPeriodStart.getTime())
      const salesCents = await salesCentsBetween(prisma, payg.businessId, inv.periodStart, inv.periodEnd)
      const priced = priceFor(payg.plan, payg, { branches: 1, salesCents }, env.PLATFORM_VAT_BPS)
      expect(inv.totalCents).toBe(priced.totalCents)
      subtotals.push(inv.subtotalCents)
    }
    expect(Math.min(...subtotals)).toBe(100000)
    expect(Math.max(...subtotals)).toBeGreaterThan(100000)
  })

  it('demo invoices add up and spread over several months', async () => {
    const invoices = await prisma.invoice.findMany({ include: { payments: true } })
    expect(invoices.length).toBeGreaterThan(15)
    expect(new Set(invoices.map(i => i.number)).size).toBe(invoices.length)
    for (const inv of invoices) {
      expect(inv.number).toMatch(/^INV-\d{4}-\d{6}$/)
      expect(inv.subscriptionId).not.toBeNull()
      const lines = inv.lines as unknown as InvoiceLine[]
      expect(lines.reduce((a, l) => a + l.amountCents, 0)).toBe(inv.subtotalCents)
      expect(inv.totalCents).toBe(inv.subtotalCents + inv.taxCents)
      expect(inv.taxCents).toBe(Math.round((inv.subtotalCents * env.PLATFORM_VAT_BPS) / 10000))
      expect(inv.payments.reduce((a, p) => a + p.amountCents, 0)).toBe(inv.paidCents)
      expect(inv.dueAt.getTime() - inv.issuedAt.getTime()).toBe(7 * DAY)
      if (inv.status === 'PAID') {
        expect(inv.paidCents).toBe(inv.totalCents)
        expect(inv.paidAt).not.toBeNull()
        expect(inv.paidAt!.getTime()).toBeLessThanOrEqual(Date.now())
      } else {
        expect(inv.status).toBe('OPEN')
        expect(inv.paidCents).toBe(0)
      }
    }
    const months = new Set(invoices.map(i => i.issuedAt.toISOString().slice(0, 7)))
    expect(months.size).toBeGreaterThanOrEqual(5)
    const paidMonths = new Set(invoices.flatMap(i => i.payments).map(p => p.receivedAt.toISOString().slice(0, 7)))
    expect(paidMonths.size).toBeGreaterThanOrEqual(5)
    // every invoice the seed raised is in the audit log against its client
    expect(await prisma.auditLog.count({ where: { action: 'billing.invoice_created' } })).toBe(invoices.length)
  })

  it('demo client owners sign in with the demo PIN, and the suspended shop is locked out', async () => {
    const trial = await Client.login(client('TRIALING').username, '1234')
    expect((await trial.get('/api/session/me')).status).toBe(200)
    const suspended = await Client.login(client('SUSPENDED').username, '1234')
    expect((await suspended.get('/api/products')).status).toBe(402)
  })

  it(
    'running it again changes nothing',
    async () => {
      const before = await counts()
      const r = await seedDemo({ log: quiet })
      expect(r.created).toBe(false)
      expect(await counts()).toEqual(before)
      expect(await prisma.business.count({ where: { name: DEMO_BUSINESS } })).toBe(1)
      expect(await prisma.business.count()).toBe(7)
      expect(await prisma.plan.count()).toBe(5)
    },
    LONG
  )

  it(
    'a rerun fills in what is missing without touching the rest',
    async () => {
      const before = await counts()
      const demo = await prisma.business.findFirstOrThrow({ where: { name: DEMO_BUSINESS } })
      await prisma.invoice.deleteMany({ where: { businessId: demo.id } })
      await prisma.subscription.delete({ where: { businessId: demo.id } })
      await prisma.plan.update({ where: { code: 'starter' }, data: { priceCents: 300000 } })

      const r = await seedDemo({ log: quiet })
      expect(r.created).toBe(false)
      const sub = await subOf(DEMO_BUSINESS)
      expect(sub.invoices.map(i => i.status)).toEqual(['PAID', 'PAID', 'OPEN'])
      const after = await counts()
      expect({ ...after, audit: 0 }).toEqual({ ...before, audit: 0 })
      // a price changed in the console is not put back by the seed
      expect((await prisma.plan.findUniqueOrThrow({ where: { code: 'starter' } })).priceCents).toBe(300000)
      await prisma.plan.update({ where: { code: 'starter' }, data: { priceCents: 250000 } })
    },
    LONG
  )

  it(
    'reset rebuilds the demo without duplicates and leaves real data alone',
    async () => {
      // a console user and a real client on a seeded plan must survive
      const admin = await createPlatformUser(prisma, { name: 'Ops', email: 'ops@bottlepoint.test', password: 'correct-horse-battery', role: 'SUPER_ADMIN' })
      const starter = await prisma.plan.findUniqueOrThrow({ where: { code: 'starter' } })
      const real = await prisma.business.create({ data: { name: 'Real Wines Ltd' } })
      const now = new Date()
      const realSub = await prisma.subscription.create({
        data: { businessId: real.id, planId: starter.id, status: 'ACTIVE', currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * DAY) }
      })
      const realInvoice = await prisma.invoice.create({
        data: { number: 'INV-1999-000001', businessId: real.id, subscriptionId: realSub.id, periodStart: now, periodEnd: now, lines: [], subtotalCents: 100, taxCents: 16, totalCents: 116, dueAt: now }
      })
      const planIds = (await prisma.plan.findMany({ orderBy: { code: 'asc' } })).map(p => p.id)
      const before = await counts()

      const r = await seedDemo({ reset: true, log: quiet })
      expect(r.created).toBe(true)

      expect(await prisma.business.count({ where: { name: DEMO_BUSINESS } })).toBe(1)
      for (const c of DEMO_CLIENTS) {
        expect(await prisma.business.count({ where: { name: c.name } })).toBe(1)
        expect(await prisma.user.count({ where: { username: c.username } })).toBe(1)
      }
      expect(await prisma.user.count({ where: { username: 'wanjiru' } })).toBe(1)
      // same amount of everything as before the reset (the audit log only grows)
      const after = await counts()
      expect({ ...after, audit: 0 }).toEqual({ ...before, audit: 0 })
      expect(after.audit).toBeGreaterThan(before.audit)

      expect(await prisma.user.findUnique({ where: { id: admin.id } })).not.toBeNull()
      expect(await prisma.business.findUnique({ where: { id: real.id } })).not.toBeNull()
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: realSub.id } })).planId).toBe(starter.id)
      expect(await prisma.invoice.findUnique({ where: { id: realInvoice.id } })).not.toBeNull()
      expect((await prisma.plan.findMany({ orderBy: { code: 'asc' } })).map(p => p.id)).toEqual(planIds)

      // payments recorded after the reset name the console user who exists now
      const payment = await prisma.invoicePayment.findFirstOrThrow()
      expect(payment.recordedById).toBe(admin.id)
    },
    LONG
  )

  it('refuses to reset in production', async () => {
    const was = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      await expect(seedDemo({ reset: true, log: quiet })).rejects.toThrow(/production/)
    } finally {
      process.env.NODE_ENV = was
    }
    expect(await prisma.business.count({ where: { name: DEMO_BUSINESS } })).toBe(1)
  })
})
