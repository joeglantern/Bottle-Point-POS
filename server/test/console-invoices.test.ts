import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { env } from '../src/env.js'
import { csvCell } from '../src/routes/console/invoices.js'
import { AUTO_SUSPEND_PREFIX, createInvoice, DAY_MS } from '../src/rules/platform.js'
import { app, Client, consoleLogin, ORIGIN, resetDb, seedFixture, seedPlatform, type Fixture } from './helpers.js'

let fx: Fixture
let admin: Client
let billing: Client
let support: Client
let platform: Awaited<ReturnType<typeof seedPlatform>>

const vat = (subtotal: number) => Math.round((subtotal * env.PLATFORM_VAT_BPS) / 10000)
const code = (r: { body: any }) => r.body?.error?.code

beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
  platform = await seedPlatform()
  admin = await consoleLogin('admin@bottlepoint.test')
  billing = await consoleLogin('billing@bottlepoint.test')
  support = await consoleLogin('support@bottlepoint.test')
})

const base = '/api/console'
const manual = (who: Client, lines: unknown, extra: Record<string, unknown> = {}, businessId = fx.business.id) =>
  who.post(`${base}/tenants/${businessId}/invoices`, { lines, ...extra })
const oneLine = (unitCents = 100000) => [{ description: 'Setup fee', quantity: 1, unitCents }]

// An invoice written straight through the shared rule, so tests can backdate it.
async function raw(businessId: string, totalCents: number, opts: { issuedDaysAgo?: number; dueDaysAgo?: number; notes?: string } = {}) {
  const issuedAt = new Date(Date.now() - (opts.issuedDaysAgo ?? 0) * DAY_MS)
  const dueAt = opts.dueDaysAgo == null ? new Date(issuedAt.getTime() + 7 * DAY_MS) : new Date(Date.now() - opts.dueDaysAgo * DAY_MS)
  return prisma.$transaction(tx =>
    createInvoice(tx, {
      businessId,
      periodStart: issuedAt,
      periodEnd: issuedAt,
      priced: {
        lines: [{ description: 'Test', quantity: 1, unitCents: totalCents, amountCents: totalCents }],
        subtotalCents: totalCents,
        taxCents: 0,
        totalCents
      },
      issuedAt,
      dueAt,
      notes: opts.notes
    })
  )
}

async function subscribe(status: 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'TRIALING', suspendedReason?: string) {
  const plan = await prisma.plan.create({ data: { code: 'starter', name: 'Starter', model: 'FLAT', priceCents: 250000 } })
  const now = new Date()
  return prisma.subscription.create({
    data: {
      businessId: fx.business.id,
      planId: plan.id,
      status,
      currentPeriodStart: new Date(now.getTime() - 10 * DAY_MS),
      currentPeriodEnd: new Date(now.getTime() + 20 * DAY_MS),
      suspendedReason: suspendedReason ?? null,
      suspendedAt: suspendedReason ? now : null
    }
  })
}
const subStatus = async () => (await prisma.subscription.findUniqueOrThrow({ where: { businessId: fx.business.id } })).status

describe('manual invoices', () => {
  it('raises an invoice with VAT on the subtotal and a number from the counter', async () => {
    const r = await manual(billing, [
      { description: 'Receipt printer', quantity: 2, unitCents: 150000 },
      { description: 'Staff training', quantity: 1, unitCents: 50000 }
    ])
    expect(r.status).toBe(201)
    const inv = r.body.invoice
    const year = new Date(Date.now() + 3 * 3_600_000).getUTCFullYear()
    expect(inv.number).toBe(`INV-${year}-000001`)
    expect(inv.subtotalCents).toBe(350000)
    expect(inv.taxCents).toBe(vat(350000))
    expect(inv.totalCents).toBe(350000 + vat(350000))
    expect(inv.paidCents).toBe(0)
    expect(inv.balanceCents).toBe(inv.totalCents)
    expect(inv.status).toBe('OPEN')
    expect(inv.overdue).toBe(false)
    expect(inv.subscriptionId).toBeNull()
    expect(inv.lines).toEqual([
      { description: 'Receipt printer', quantity: 2, unitCents: 150000, amountCents: 300000 },
      { description: 'Staff training', quantity: 1, unitCents: 50000, amountCents: 50000 }
    ])
    expect(new Date(inv.dueAt).getTime() - new Date(inv.issuedAt).getTime()).toBe(7 * DAY_MS)
    expect(inv.client).toMatchObject({ id: fx.business.id, name: 'Test Wines', legalName: null, kraPin: null })
    expect(inv.payments).toEqual([])
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'console.invoice.created' } })
    expect(log.userId).toBe(platform.billing.id)
    expect(log.businessId).toBe(fx.business.id)
    expect(log.data).toMatchObject({ businessName: 'Test Wines', number: inv.number, totalCents: inv.totalCents })
    const second = await manual(admin, oneLine(), { dueInDays: 0, notes: 'Second till licence' })
    expect(second.body.invoice.number).toBe(`INV-${year}-000002`)
    expect(second.body.invoice.notes).toBe('Second till licence')
    expect(second.body.invoice.dueAt).toBe(second.body.invoice.issuedAt)
  })

  it('refuses bad input', async () => {
    const bad: [unknown, Record<string, unknown>?][] = [
      [[]],
      [[{ description: '', quantity: 1, unitCents: 100 }]],
      [[{ description: 'x', quantity: 0, unitCents: 100 }]],
      [[{ description: 'x', quantity: 1001, unitCents: 100 }]],
      [[{ description: 'x', quantity: 1.5, unitCents: 100 }]],
      [[{ description: 'x', quantity: 1, unitCents: 10.5 }]],
      [[{ description: 'x', quantity: 1, unitCents: -100 }]],
      [[{ description: 'x', quantity: 1, unitCents: 0 }]],
      [[{ description: 'x', quantity: 1000, unitCents: 1_000_000_000 }]],
      [oneLine(), { dueInDays: 91 }],
      [oneLine(), { dueInDays: -1 }],
      [oneLine(), { notes: 'n'.repeat(1001) }],
      ['nope']
    ]
    for (const [lines, extra] of bad) {
      const r = await manual(billing, lines, extra)
      expect(r.status, JSON.stringify(lines).slice(0, 80)).toBe(400)
    }
    expect((await manual(billing, oneLine(), {}, 'no-such-client')).status).toBe(404)
    expect(await prisma.invoice.count()).toBe(0)
    // a refused invoice does not use up a number
    expect(await prisma.invoiceCounter.count()).toBe(0)
  })

  it('gives ten invoices created at once ten different numbers with no gaps', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => manual(i % 2 ? billing : admin, oneLine(1000 + i))))
    expect(results.map(r => r.status)).toEqual(Array(10).fill(201))
    const numbers = results.map(r => r.body.invoice.number as string)
    expect(new Set(numbers).size).toBe(10)
    const tails = numbers.map(n => Number(n.slice(-6))).sort((a, b) => a - b)
    expect(tails).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const counter = await prisma.invoiceCounter.findMany()
    expect(counter).toHaveLength(1)
    expect(counter[0]!.last).toBe(10)
  })
})

describe('who may do what', () => {
  it('lets every console role read, and only billing and super admin write', async () => {
    const inv = (await manual(billing, oneLine())).body.invoice
    for (const who of [admin, billing, support]) {
      expect((await who.get(`${base}/invoices`)).status).toBe(200)
      expect((await who.get(`${base}/invoices/${inv.id}`)).status).toBe(200)
      expect((await who.get(`${base}/invoices/export.csv`)).status).toBe(200)
    }
    const r1 = await manual(support, oneLine())
    expect(r1.status).toBe(403)
    expect((await support.post(`${base}/invoices/${inv.id}/payments`, { amountCents: 100, method: 'CASH' })).status).toBe(403)
    expect((await support.post(`${base}/invoices/${inv.id}/void`, { reason: 'x' })).status).toBe(403)
    expect(await prisma.invoice.count()).toBe(1)
    expect(await prisma.invoicePayment.count()).toBe(0)
    expect((await admin.post(`${base}/invoices/${inv.id}/payments`, { amountCents: 100, method: 'CASH' })).status).toBe(201)
  })

  it('answers 401 without a console session, including to a shop owner', async () => {
    const inv = (await manual(billing, oneLine())).body.invoice
    const owner = await Client.login('owner')
    for (const who of [new Client(), owner]) {
      expect((await who.get(`${base}/invoices`)).status).toBe(401)
      expect((await who.get(`${base}/invoices/export.csv`)).status).toBe(401)
      expect((await who.get(`${base}/invoices/${inv.id}`)).status).toBe(401)
      expect((await manual(who, oneLine())).status).toBe(401)
      expect((await who.post(`${base}/invoices/${inv.id}/payments`, { amountCents: 100, method: 'CASH' })).status).toBe(401)
      expect((await who.post(`${base}/invoices/${inv.id}/void`, { reason: 'x' })).status).toBe(401)
    }
    expect(await prisma.invoice.count()).toBe(1)
    expect(await prisma.invoicePayment.count()).toBe(0)
  })
})

describe('payments', () => {
  it('takes part payments and marks the invoice paid on the last one', async () => {
    const inv = (await manual(billing, oneLine(100000))).body.invoice
    const total = 100000 + vat(100000)
    const received = new Date(Date.now() - 2 * DAY_MS).toISOString()
    const p1 = await billing.post(`${base}/invoices/${inv.id}/payments`, {
      amountCents: 40000,
      method: 'MPESA',
      reference: ' QWE123RTY4 ',
      receivedAt: received
    })
    expect(p1.status).toBe(201)
    expect(p1.body.invoice).toMatchObject({ status: 'OPEN', paidCents: 40000, balanceCents: total - 40000, paidAt: null })
    expect(p1.body.payment).toMatchObject({
      amountCents: 40000,
      method: 'MPESA',
      reference: 'QWE123RTY4',
      receivedAt: received,
      recordedBy: { id: platform.billing.id, name: 'billing' }
    })
    expect(p1.body.subscriptionStatus).toBeNull()
    const p2 = await admin.post(`${base}/invoices/${inv.id}/payments`, { amountCents: total - 40000, method: 'BANK' })
    expect(p2.status).toBe(201)
    expect(p2.body.invoice).toMatchObject({ status: 'PAID', paidCents: total, balanceCents: 0, overdue: false })
    expect(p2.body.invoice.paidAt).toBeTruthy()
    expect(p2.body.invoice.payments).toHaveLength(2)
    expect(p2.body.invoice.payments[1].recordedBy.name).toBe('admin')
    const again = await billing.post(`${base}/invoices/${inv.id}/payments`, { amountCents: 1, method: 'CASH' })
    expect(again.status).toBe(422)
    expect(code(again)).toBe('invoice_paid')
    const logs = await prisma.auditLog.findMany({ where: { action: 'console.invoice.payment_recorded' }, orderBy: { id: 'asc' } })
    expect(logs).toHaveLength(2)
    expect(logs[0]!.businessId).toBe(fx.business.id)
    expect(logs[0]!.data).toMatchObject({ number: inv.number, amountCents: 40000, paidCents: 40000, balanceCents: total - 40000, fullyPaid: false })
    expect(logs[1]!.data).toMatchObject({ paidCents: total, balanceCents: 0, fullyPaid: true })
  })

  it('refuses an overpayment and other bad payments without writing anything', async () => {
    const inv = (await manual(billing, oneLine(100000))).body.invoice
    const url = `${base}/invoices/${inv.id}/payments`
    const over = await billing.post(url, { amountCents: inv.totalCents + 1, method: 'CASH' })
    expect(over.status).toBe(422)
    expect(code(over)).toBe('overpayment')
    expect((await billing.post(url, { amountCents: 0, method: 'CASH' })).status).toBe(400)
    expect((await billing.post(url, { amountCents: -5, method: 'CASH' })).status).toBe(400)
    expect((await billing.post(url, { amountCents: 10.5, method: 'CASH' })).status).toBe(400)
    expect((await billing.post(url, { amountCents: 100, method: 'CHEQUE' })).status).toBe(400)
    expect((await billing.post(url, { amountCents: 100 })).status).toBe(400)
    expect((await billing.post(url, { amountCents: 100, method: 'CASH', receivedAt: 'yesterday' })).status).toBe(400)
    const future = new Date(Date.now() + DAY_MS).toISOString()
    expect((await billing.post(url, { amountCents: 100, method: 'CASH', receivedAt: future })).status).toBe(400)
    expect((await billing.post(url, { amountCents: 100, method: 'CASH', reference: 'r'.repeat(101) })).status).toBe(400)
    expect((await billing.post(`${base}/invoices/nope/payments`, { amountCents: 100, method: 'CASH' })).status).toBe(404)
    expect(await prisma.invoicePayment.count()).toBe(0)
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).paidCents).toBe(0)
    // paying exactly the balance is fine, and the date the money arrived becomes the paid date
    const received = new Date(Date.now() - DAY_MS).toISOString()
    const exact = await billing.post(url, { amountCents: inv.totalCents, method: 'CARD', receivedAt: received })
    expect(exact.status).toBe(201)
    expect(exact.body.invoice.paidAt).toBe(received)
  })

  it('lets exactly one of two payments through when together they would overpay', async () => {
    const inv = (await manual(billing, oneLine(100000))).body.invoice
    const amount = Math.ceil(inv.totalCents * 0.6)
    const url = `${base}/invoices/${inv.id}/payments`
    const [a, b] = await Promise.all([
      billing.post(url, { amountCents: amount, method: 'MPESA' }),
      admin.post(url, { amountCents: amount, method: 'BANK' })
    ])
    expect([a.status, b.status].sort()).toEqual([201, 422])
    expect(code(a.status === 422 ? a : b)).toBe('overpayment')
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id }, include: { payments: true } })
    expect(after.paidCents).toBe(amount)
    expect(after.status).toBe('OPEN')
    expect(after.payments).toHaveLength(1)
  })

  it('pays the same invoice in full only once under a race', async () => {
    const inv = (await manual(billing, oneLine(100000))).body.invoice
    const url = `${base}/invoices/${inv.id}/payments`
    const results = await Promise.all([billing, admin, billing].map(w => w.post(url, { amountCents: inv.totalCents, method: 'CASH' })))
    expect(results.map(r => r.status).sort()).toEqual([201, 422, 422])
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id }, include: { payments: true } })
    expect(after.paidCents).toBe(inv.totalCents)
    expect(after.status).toBe('PAID')
    expect(after.payments).toHaveLength(1)
  })

  it('returns a past due client to active once its last overdue invoice is paid', async () => {
    await subscribe('PAST_DUE')
    const first = await raw(fx.business.id, 290000, { issuedDaysAgo: 50, dueDaysAgo: 43 })
    const second = await raw(fx.business.id, 290000, { issuedDaysAgo: 20, dueDaysAgo: 13 })
    const part = await billing.post(`${base}/invoices/${first.id}/payments`, { amountCents: 100000, method: 'MPESA' })
    expect(part.body.subscriptionStatus).toBe('PAST_DUE')
    const rest = await billing.post(`${base}/invoices/${first.id}/payments`, { amountCents: 190000, method: 'MPESA' })
    expect(rest.body.invoice.status).toBe('PAID')
    // the second invoice is still overdue
    expect(rest.body.subscriptionStatus).toBe('PAST_DUE')
    expect(await subStatus()).toBe('PAST_DUE')
    const last = await billing.post(`${base}/invoices/${second.id}/payments`, { amountCents: 290000, method: 'BANK' })
    expect(last.body.subscriptionStatus).toBe('ACTIVE')
    expect(await subStatus()).toBe('ACTIVE')
    const log = await prisma.auditLog.findMany({ where: { action: 'billing.reactivated' } })
    expect(log).toHaveLength(1)
    expect(log[0]!.userId).toBeNull()
    expect(log[0]!.businessId).toBe(fx.business.id)
    expect(log[0]!.data).toMatchObject({ businessName: 'Test Wines', from: 'PAST_DUE', number: second.number })
  })

  it('lifts a suspension for non payment, and the shop works again at once', async () => {
    const inv = await raw(fx.business.id, 290000, { issuedDaysAgo: 40, dueDaysAgo: 33 })
    await subscribe('SUSPENDED', `${AUTO_SUSPEND_PREFIX}${inv.number}`)
    const owner = await Client.login('owner')
    expect((await owner.get('/api/products')).status).toBe(402)
    const paid = await billing.post(`${base}/invoices/${inv.id}/payments`, { amountCents: 290000, method: 'MPESA' })
    expect(paid.body.subscriptionStatus).toBe('ACTIVE')
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { businessId: fx.business.id } })
    expect(sub).toMatchObject({ status: 'ACTIVE', suspendedReason: null, suspendedAt: null })
    expect((await owner.get('/api/products')).status).toBe(200)
  })

  it('never lifts a suspension a person made, or touches a trial', async () => {
    const inv = await raw(fx.business.id, 290000, { issuedDaysAgo: 40, dueDaysAgo: 33 })
    const sub = await subscribe('SUSPENDED', 'Owner asked to pause the account')
    const paid = await billing.post(`${base}/invoices/${inv.id}/payments`, { amountCents: 290000, method: 'MPESA' })
    expect(paid.status).toBe(201)
    expect(paid.body.subscriptionStatus).toBe('SUSPENDED')
    expect(await subStatus()).toBe('SUSPENDED')
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'TRIALING' } })
    const other = await raw(fx.business.id, 1000, { issuedDaysAgo: 40, dueDaysAgo: 33 })
    const r = await billing.post(`${base}/invoices/${other.id}/payments`, { amountCents: 1000, method: 'CASH' })
    expect(r.body.subscriptionStatus).toBe('TRIALING')
    expect(await prisma.auditLog.count({ where: { action: 'billing.reactivated' } })).toBe(0)
  })
})

describe('voiding', () => {
  it('voids an open invoice with no payments and keeps the reason', async () => {
    const inv = (await manual(billing, oneLine(), { notes: 'Hardware' })).body.invoice
    expect((await billing.post(`${base}/invoices/${inv.id}/void`, {})).status).toBe(400)
    expect((await billing.post(`${base}/invoices/${inv.id}/void`, { reason: '  ' })).status).toBe(400)
    expect((await billing.post(`${base}/invoices/nope/void`, { reason: 'x' })).status).toBe(404)
    const r = await billing.post(`${base}/invoices/${inv.id}/void`, { reason: 'Raised twice by mistake' })
    expect(r.status).toBe(200)
    expect(r.body.invoice).toMatchObject({ status: 'VOID', balanceCents: 0, overdue: false, notes: 'Hardware\nVoided: Raised twice by mistake' })
    expect(r.body.invoice.voidedAt).toBeTruthy()
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'console.invoice.voided' } })
    expect(log.userId).toBe(platform.billing.id)
    expect(log.businessId).toBe(fx.business.id)
    expect(log.data).toMatchObject({ number: inv.number, reason: 'Raised twice by mistake', businessName: 'Test Wines' })
    const again = await billing.post(`${base}/invoices/${inv.id}/void`, { reason: 'again' })
    expect(again.status).toBe(422)
    expect(code(again)).toBe('invoice_not_open')
    const pay = await billing.post(`${base}/invoices/${inv.id}/payments`, { amountCents: 100, method: 'CASH' })
    expect(pay.status).toBe(422)
    expect(code(pay)).toBe('invoice_void')
  })

  it('refuses to void an invoice that has payments or is already paid', async () => {
    const part = (await manual(billing, oneLine())).body.invoice
    await billing.post(`${base}/invoices/${part.id}/payments`, { amountCents: 500, method: 'CASH' })
    const r1 = await billing.post(`${base}/invoices/${part.id}/void`, { reason: 'x' })
    expect(r1.status).toBe(422)
    expect(code(r1)).toBe('invoice_has_payments')
    const paid = (await manual(billing, oneLine())).body.invoice
    await billing.post(`${base}/invoices/${paid.id}/payments`, { amountCents: paid.totalCents, method: 'CASH' })
    const r2 = await billing.post(`${base}/invoices/${paid.id}/void`, { reason: 'x' })
    expect(r2.status).toBe(422)
    expect(code(r2)).toBe('invoice_not_open')
    expect(await prisma.invoice.count({ where: { status: 'VOID' } })).toBe(0)
  })

  it('stops holding a client past due once the overdue invoice is voided', async () => {
    await subscribe('PAST_DUE')
    const inv = await raw(fx.business.id, 290000, { issuedDaysAgo: 30, dueDaysAgo: 23 })
    const r = await billing.post(`${base}/invoices/${inv.id}/void`, { reason: 'Billed in error' })
    expect(r.body.subscriptionStatus).toBe('ACTIVE')
    expect(await subStatus()).toBe('ACTIVE')
  })
})

describe('list, detail and export', () => {
  // Test Wines: open 100000 (due later), overdue 200000 with 50000 paid, paid 300000, void 400000.
  // Mama Njeri: open 70000 issued 100 days ago and long overdue.
  async function dataset() {
    const other = await prisma.business.create({ data: { name: 'Mama Njeri Wines' } })
    const open = await raw(fx.business.id, 100000)
    const overdue = await raw(fx.business.id, 200000, { issuedDaysAgo: 20, dueDaysAgo: 13 })
    const paid = await raw(fx.business.id, 300000, { issuedDaysAgo: 40 })
    const dead = await raw(fx.business.id, 400000, { issuedDaysAgo: 5 })
    const theirs = await raw(other.id, 70000, { issuedDaysAgo: 100, dueDaysAgo: 93 })
    await billing.post(`${base}/invoices/${overdue.id}/payments`, { amountCents: 50000, method: 'MPESA' })
    await billing.post(`${base}/invoices/${paid.id}/payments`, { amountCents: 300000, method: 'BANK' })
    await billing.post(`${base}/invoices/${dead.id}/void`, { reason: 'Mistake' })
    return { other, open, overdue, paid, dead, theirs }
  }
  const numbers = (r: { body: any }) => r.body.invoices.map((i: any) => i.number).sort()

  it('filters by status, client, text and dates with totals for the whole filter', async () => {
    const d = await dataset()
    const all = await support.get(`${base}/invoices`)
    expect(all.status).toBe(200)
    expect(all.body.total).toBe(5)
    // newest first
    expect(all.body.invoices.map((i: any) => i.number)).toEqual([d.open, d.dead, d.overdue, d.paid, d.theirs].map(i => i.number))
    expect(all.body.totals).toEqual({ billedCents: 670000, collectedCents: 350000, outstandingCents: 320000 })
    const row = all.body.invoices.find((i: any) => i.id === d.overdue.id)
    expect(row).toMatchObject({
      business: { id: fx.business.id, name: 'Test Wines' },
      status: 'OPEN',
      overdue: true,
      totalCents: 200000,
      paidCents: 50000,
      balanceCents: 150000
    })

    const open = await billing.get(`${base}/invoices?status=OPEN`)
    expect(numbers(open)).toEqual([d.open, d.overdue, d.theirs].map(i => i.number).sort())
    expect(open.body.totals).toEqual({ billedCents: 370000, collectedCents: 50000, outstandingCents: 320000 })
    const overdue = await billing.get(`${base}/invoices?status=OVERDUE`)
    expect(numbers(overdue)).toEqual([d.overdue, d.theirs].map(i => i.number).sort())
    expect(overdue.body.totals).toEqual({ billedCents: 270000, collectedCents: 50000, outstandingCents: 220000 })
    const paid = await billing.get(`${base}/invoices?status=PAID`)
    expect(numbers(paid)).toEqual([d.paid.number])
    expect(paid.body.totals).toEqual({ billedCents: 300000, collectedCents: 300000, outstandingCents: 0 })
    const dead = await billing.get(`${base}/invoices?status=VOID`)
    expect(numbers(dead)).toEqual([d.dead.number])
    expect(dead.body.totals).toEqual({ billedCents: 0, collectedCents: 0, outstandingCents: 0 })

    const theirs = await billing.get(`${base}/invoices?businessId=${d.other.id}`)
    expect(numbers(theirs)).toEqual([d.theirs.number])
    expect(theirs.body.totals).toEqual({ billedCents: 70000, collectedCents: 0, outstandingCents: 70000 })
    expect(numbers(await billing.get(`${base}/invoices?q=njeri`))).toEqual([d.theirs.number])
    expect(numbers(await billing.get(`${base}/invoices?q=${d.paid.number.toLowerCase()}`))).toEqual([d.paid.number])
    expect((await billing.get(`${base}/invoices?q=zzz`)).body).toMatchObject({ invoices: [], total: 0 })

    const day = (ago: number) => new Date(Date.now() + 3 * 3_600_000 - ago * DAY_MS).toISOString().slice(0, 10)
    expect(numbers(await billing.get(`${base}/invoices?from=${day(25)}`))).toEqual([d.open, d.overdue, d.dead].map(i => i.number).sort())
    expect(numbers(await billing.get(`${base}/invoices?from=${day(45)}&to=${day(20)}`))).toEqual([d.overdue, d.paid].map(i => i.number).sort())
    expect(numbers(await billing.get(`${base}/invoices?to=${day(60)}`))).toEqual([d.theirs.number])
    const iso = encodeURIComponent(new Date(Date.now() - 10 * DAY_MS).toISOString())
    expect(numbers(await billing.get(`${base}/invoices?from=${iso}`))).toEqual([d.open, d.dead].map(i => i.number).sort())

    // paging never changes the totals, and cleared filters are ignored
    const page = await billing.get(`${base}/invoices?limit=2&offset=1&status=&q=&businessId=&from=&to=`)
    expect(page.body.invoices.map((i: any) => i.number)).toEqual([d.dead.number, d.overdue.number])
    expect(page.body.total).toBe(5)
    expect(page.body.totals).toEqual(all.body.totals)

    for (const bad of ['status=DRAFT', 'limit=201', 'limit=0', 'offset=-1', 'from=soon', 'to=31-12-2026']) {
      expect((await billing.get(`${base}/invoices?${bad}`)).status, bad).toBe(400)
    }
  })

  it('shows one invoice with its client, lines and payments, and 404 for an unknown id', async () => {
    const d = await dataset()
    await prisma.business.update({
      where: { id: fx.business.id },
      data: { legalName: 'Test Wines Ltd', address: 'Woodvale Grove', kraPin: 'P051234567X', email: 'a@test.co.ke', phone: '0712345678' }
    })
    const r = await support.get(`${base}/invoices/${d.overdue.id}`)
    expect(r.status).toBe(200)
    expect(r.body.invoice).toMatchObject({
      number: d.overdue.number,
      overdue: true,
      balanceCents: 150000,
      client: {
        id: fx.business.id,
        name: 'Test Wines',
        legalName: 'Test Wines Ltd',
        address: 'Woodvale Grove',
        kraPin: 'P051234567X',
        email: 'a@test.co.ke',
        phone: '0712345678'
      },
      lines: [{ description: 'Test', quantity: 1, unitCents: 200000, amountCents: 200000 }]
    })
    expect(r.body.invoice.payments).toHaveLength(1)
    expect(r.body.invoice.payments[0]).toMatchObject({ amountCents: 50000, method: 'MPESA', reference: null, recordedBy: { name: 'billing' } })
    expect((await support.get(`${base}/invoices/nope`)).status).toBe(404)
  })

  it('exports the filtered invoices as CSV that a spreadsheet cannot be tricked by', async () => {
    const evil = await prisma.business.create({ data: { name: '=HYPERLINK("http://evil.example","Pay here")' } })
    await raw(evil.id, 123450, { notes: 'He said "later", then paid\nin two parts' })
    await raw(fx.business.id, 50000, { issuedDaysAgo: 20, dueDaysAgo: 13, notes: '+254 owner number' })
    const res = await app.request(`${base}/invoices/export.csv`, { headers: { origin: ORIGIN, cookie: support.cookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="invoices-\d{4}-\d{2}-\d{2}\.csv"$/)
    const text = await res.text()
    const lines = text.split('\r\n')
    expect(lines[0]).toBe('Number,Client,Status,Issued,Due,Paid on,Subtotal,VAT,Total,Paid,Balance,Notes')
    expect(text).toContain(`"'=HYPERLINK(""http://evil.example"",""Pay here"")"`)
    expect(text).toContain('"He said ""later"", then paid\nin two parts"')
    expect(text).toContain(",OPEN,")
    expect(text).toContain('1234.50,0.00,1234.50,0.00,1234.50')
    expect(text).toContain(",OVERDUE,")
    expect(text).toContain("'+254 owner number")
    // no cell may start a formula
    expect(text).not.toMatch(/(^|,|\n)"?[=+@]/)
    // filters are the same as the list
    const one = await support.get(`${base}/invoices/export.csv?status=OVERDUE`)
    const rows = (one.body as string).trim().split('\r\n')
    expect(rows).toHaveLength(2)
    expect(rows[1]).toContain('Test Wines')
    expect((await support.get(`${base}/invoices/export.csv?status=NOPE`)).status).toBe(400)
  })

  it('escapes every kind of risky cell', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell(null)).toBe('')
    expect(csvCell('=1+1')).toBe("'=1+1")
    expect(csvCell('+254700')).toBe("'+254700")
    expect(csvCell('-cmd')).toBe("'-cmd")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('\tTabbed')).toBe("'\tTabbed")
    expect(csvCell('a "quoted" word')).toBe('"a ""quoted"" word"')
    expect(csvCell('one, two')).toBe('"one, two"')
    expect(csvCell('=A1,"x"')).toBe(`"'=A1,""x"""`)
  })
})
