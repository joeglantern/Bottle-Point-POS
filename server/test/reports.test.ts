import { beforeEach, describe, expect, it } from 'vitest'
import { Client, resetDb, seedFixture, type Fixture } from './helpers.js'
import { prisma, type PayMethod, type PaymentVerification } from '../src/db.js'
import { applyPayment } from '../src/rules/sale-core.js'
import { dailyReport, dayRange, todayNairobi } from '../src/rules/reports.js'

let fx: Fixture
beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
})

// Nairobi wall clock to a UTC instant
const nbo = (s: string) => new Date(`${s}+03:00`)

async function makeSale(
  branchId: string,
  userId: string,
  items: { productId: string; unitCents: number; qty: number }[],
  extra: { discountCents?: number; createdAt?: Date; status?: 'SAVED' | 'CANCELLED'; cancelledAt?: Date; label?: string } = {}
) {
  const b = await prisma.branch.update({ where: { id: branchId }, data: { nextSaleNo: { increment: 1 } } })
  const subtotal = items.reduce((a, i) => a + i.unitCents * i.qty, 0)
  const discount = extra.discountCents ?? 0
  return prisma.sale.create({
    data: {
      branchId,
      number: b.nextSaleNo - 1,
      createdById: userId,
      status: extra.status ?? 'SAVED',
      label: extra.label,
      subtotalCents: subtotal,
      discountCents: discount,
      totalCents: subtotal - discount,
      createdAt: extra.createdAt,
      cancelledAt: extra.cancelledAt,
      lines: { create: items.map(i => ({ productId: i.productId, name: `p-${i.productId.slice(-4)}`, unitCents: i.unitCents, qty: i.qty })) }
    }
  })
}

let refNo = 0
// pays through applyPayment, then moves the payment (and paidAt) to `at`
async function payAt(saleId: string, method: PayMethod, amountCents: number, userId: string, at: Date, opts: { verification?: PaymentVerification; shiftId?: string } = {}) {
  const r = await prisma.$transaction(tx =>
    applyPayment(tx, {
      saleId,
      method,
      amountCents,
      receivedById: userId,
      shiftId: opts.shiftId ?? null,
      verification: opts.verification ?? (method === 'CASH' ? 'CASH' : 'MANUAL_UNVERIFIED'),
      mpesaRef: method === 'MPESA' ? `RPT${String(++refNo).padStart(7, '0')}` : null
    })
  )
  await prisma.payment.update({ where: { id: r.payment.id }, data: { createdAt: at } })
  if (r.paid) await prisma.sale.update({ where: { id: saleId }, data: { paidAt: at } })
  return r
}

const DAY = '2026-03-10'
const NOW = nbo('2026-03-10T23:59:00')

async function buildDay() {
  const w = fx.branches.west.id
  const { cashier, cashier2, manager, kiliCashier } = fx.users
  const { whisky, beer, gin } = fx.products
  const W = { productId: whisky.id, unitCents: 480000 }
  const B = { productId: beer.id, unitCents: 28000 }
  const G = { productId: gin.id, unitCents: 145000 }

  const shift = await prisma.shift.create({
    data: { branchId: w, userId: cashier.id, openingFloatCents: 100000, openedAt: nbo(`${DAY}T08:00:00`) }
  })

  // S1: whisky with an approved discount, cash, 10:00
  const s1 = await makeSale(w, cashier.id, [{ ...W, qty: 1 }], { discountCents: 5000 })
  await payAt(s1.id, 'CASH', 475000, cashier.id, nbo(`${DAY}T10:00:00`), { shiftId: shift.id })
  await prisma.approval.create({
    data: { saleId: s1.id, kind: 'DISCOUNT', status: 'APPROVED', reason: 'regular', amountCents: 5000, requestedById: cashier.id, decidedById: manager.id, decidedAt: nbo(`${DAY}T09:55:00`) }
  })

  // S2: two beers on typed M-Pesa at 23:30 Nairobi: still this day
  const s2 = await makeSale(w, cashier2.id, [{ ...B, qty: 2 }])
  await payAt(s2.id, 'MPESA', 56000, cashier2.id, nbo(`${DAY}T23:30:00`))

  // S3: gin cash at 00:30 the next morning: belongs to the next day
  const s3 = await makeSale(w, cashier.id, [{ ...G, qty: 1 }])
  await payAt(s3.id, 'CASH', 145000, cashier.id, nbo('2026-03-11T00:30:00'))

  // S4: split payment, then refunded in cash the same afternoon
  const s4 = await makeSale(w, manager.id, [{ ...G, qty: 1 }, { ...B, qty: 1 }])
  await payAt(s4.id, 'CASH', 100000, manager.id, nbo(`${DAY}T12:00:00`), { shiftId: shift.id })
  await payAt(s4.id, 'MPESA', 73000, manager.id, nbo(`${DAY}T12:01:00`), { verification: 'STK_CONFIRMED' })
  const ap = await prisma.approval.create({
    data: { saleId: s4.id, kind: 'REFUND', status: 'APPROVED', reason: 'corked', amountCents: 173000, refundMethod: 'CASH', requestedById: cashier.id, decidedById: manager.id, decidedAt: nbo(`${DAY}T14:00:00`) }
  })
  await prisma.refund.create({ data: { saleId: s4.id, approvalId: ap.id, amountCents: 173000, method: 'CASH', shiftId: shift.id, paidOutById: manager.id, createdAt: nbo(`${DAY}T14:00:00`) } })
  await prisma.sale.update({ where: { id: s4.id }, data: { status: 'REFUNDED', refundedAt: nbo(`${DAY}T14:00:00`) } })

  // S5: cancelled
  await makeSale(w, cashier.id, [{ ...B, qty: 1 }], { status: 'CANCELLED', cancelledAt: nbo(`${DAY}T15:00:00`), createdAt: nbo(`${DAY}T14:30:00`) })

  // unpaid saved tabs: 30 min, 2h and 5h old at NOW; the oldest is part paid
  await makeSale(w, cashier.id, [{ ...B, qty: 1 }], { createdAt: new Date(NOW.getTime() - 30 * 60000), label: 'Table 1' })
  await makeSale(w, cashier2.id, [{ ...G, qty: 1 }], { createdAt: new Date(NOW.getTime() - 2 * 3600000), label: 'Table 2' })
  const u3 = await makeSale(w, cashier.id, [{ ...W, qty: 1 }], { createdAt: new Date(NOW.getTime() - 5 * 3600000), label: 'Table 3' })
  await payAt(u3.id, 'CASH', 10000, cashier.id, nbo(`${DAY}T19:00:00`), { shiftId: shift.id })

  // an STK push that succeeded but never got linked to a payment
  await prisma.mpesaRequest.create({
    data: { saleId: u3.id, branchId: w, phone: '254712345678', amountCents: 30000, status: 'SUCCESS', receipt: 'STK0000001', requestedById: cashier.id, createdAt: nbo(`${DAY}T19:05:00`) }
  })

  await prisma.shift.update({ where: { id: shift.id }, data: { closedAt: nbo(`${DAY}T22:00:00`), expectedCashCents: 512000, countedCashCents: 510000, varianceCents: -2000 } })

  // Kilimani: must not leak into Westlands
  const k = await makeSale(fx.branches.kili.id, kiliCashier.id, [{ ...W, qty: 3 }])
  await payAt(k.id, 'CASH', 1440000, kiliCashier.id, nbo(`${DAY}T11:00:00`))

  return { s1, s2, s3, s4, u3, shift }
}

describe('day boundaries', () => {
  it('uses Nairobi midnight', () => {
    const { start, end } = dayRange('2026-03-10')
    expect(start.toISOString()).toBe('2026-03-09T21:00:00.000Z')
    expect(end.toISOString()).toBe('2026-03-10T21:00:00.000Z')
    expect(todayNairobi(new Date('2026-03-10T20:59:00Z'))).toBe('2026-03-10')
    expect(todayNairobi(new Date('2026-03-10T21:00:00Z'))).toBe('2026-03-11')
  })
})

describe('daily report', () => {
  it('adds up a constructed day', async () => {
    const d = await buildDay()
    const r = await dailyReport(fx.branches.west.id, DAY, NOW)

    expect(r.takings).toEqual({ cashCents: 575000, mpesaCents: 129000, totalCents: 704000 })
    expect(r.partPayments).toEqual({ count: 1, cents: 10000 })
    expect(r.paidSales).toEqual({ count: 3, valueCents: 704000, averageCents: 234667 })
    expect(r.refunds).toEqual({ count: 1, valueCents: 173000, cashCents: 173000, mpesaCents: 0 })
    expect(r.netCents).toBe(531000)
    expect(r.cancellations).toEqual({ count: 1, valueCents: 28000 })
    expect(r.discounts).toEqual({ count: 1, valueCents: 5000 })

    expect(r.unpaid).toMatchObject({
      count: 3,
      valueCents: 28000 + 145000 + 480000,
      dueCents: 28000 + 145000 + 470000,
      buckets: { under1h: { count: 1, valueCents: 28000 }, from1to4h: { count: 1, valueCents: 145000 }, over4h: { count: 1, valueCents: 480000 } }
    })
    expect(r.unpaid.oldest.map(o => o.label)).toEqual(['Table 3', 'Table 2', 'Table 1'])
    expect(r.unpaid.oldest[0]).toMatchObject({ id: d.u3.id, openedByName: 'cashier', ageMinutes: 300 })

    expect(r.cashiers).toEqual([
      { userId: fx.users.cashier.id, name: 'cashier', count: 1, valueCents: 475000 },
      { userId: fx.users.manager.id, name: 'manager', count: 1, valueCents: 173000 },
      { userId: fx.users.cashier2.id, name: 'cashier2', count: 1, valueCents: 56000 }
    ])
    // refunded S4 is not in the top products; S3 is the next day
    expect(r.topProducts.byValue.map(p => [p.productId, p.qty, p.valueCents])).toEqual([
      [fx.products.whisky.id, 1, 480000],
      [fx.products.beer.id, 2, 56000]
    ])
    expect(r.topProducts.byQty[0]!.productId).toBe(fx.products.beer.id)

    expect(r.mpesaUnverified).toEqual({ count: 1, valueCents: 56000 })
    expect(r.stkUnlinked).toMatchObject({ count: 1, valueCents: 30000 })
    expect(r.stkUnlinked.requests[0]!.receipt).toBe('STK0000001')

    expect(r.shifts).toHaveLength(1)
    expect(r.shifts[0]).toMatchObject({
      id: d.shift.id,
      userName: 'cashier',
      cashTakenCents: 475000 + 100000 + 10000,
      cashRefundsCents: 173000,
      expectedCashCents: 512000,
      countedCashCents: 510000,
      varianceCents: -2000
    })
  })

  it('a payment at 00:30 Nairobi counts on the next day', async () => {
    await buildDay()
    const r = await dailyReport(fx.branches.west.id, '2026-03-11', nbo('2026-03-11T12:00:00'))
    expect(r.takings).toEqual({ cashCents: 145000, mpesaCents: 0, totalCents: 145000 })
    expect(r.paidSales.count).toBe(1)
    expect(r.refunds.count).toBe(0)
    expect(r.shifts).toHaveLength(0)
  })

  it('is served over HTTP for managers of the branch only', async () => {
    await buildDay()
    const m = await Client.login('manager')
    const r = await m.get(`/api/reports/daily?date=${DAY}`)
    expect(r.status).toBe(200)
    expect(r.body.report.takings.totalCents).toBe(704000)
    expect(r.body.report.netCents).toBe(531000)

    expect((await (await Client.login('cashier')).get(`/api/reports/daily?date=${DAY}`)).status).toBe(403)
    expect((await m.get(`/api/reports/daily?date=${DAY}&branchId=${fx.branches.kili.id}`)).status).toBe(403)
    expect((await m.get('/api/reports/daily?date=10-03-2026')).status).toBe(400)
    expect((await m.get('/api/reports/daily?date=2026-02-30')).status).toBe(400)

    const k = await Client.login('kilimanager')
    const kr = await k.get(`/api/reports/daily?date=${DAY}`)
    expect(kr.body.report.takings).toEqual({ cashCents: 1440000, mpesaCents: 0, totalCents: 1440000 })
    expect(kr.body.report.unpaid.count).toBe(0)

    const o = await Client.login('owner')
    expect((await o.get(`/api/reports/daily?date=${DAY}`)).status).toBe(403)
    expect((await o.get(`/api/reports/daily?date=${DAY}&branchId=${fx.branches.west.id}`)).body.report.netCents).toBe(531000)
  })

  it('defaults to today', async () => {
    const m = await Client.login('manager')
    const r = await m.get('/api/reports/daily')
    expect(r.status).toBe(200)
    expect(r.body.report.date).toBe(todayNairobi())
    expect(r.body.report.takings.totalCents).toBe(0)
  })
})

describe('branches report', () => {
  it('owner sees every branch and a combined row', async () => {
    await buildDay()
    const o = await Client.login('owner')
    const r = await o.get(`/api/reports/branches?date=${DAY}`)
    expect(r.status).toBe(200)
    const by = Object.fromEntries(r.body.branches.map((b: any) => [b.branchName, b]))
    expect(by.Westlands.takings.totalCents).toBe(704000)
    expect(by.Kilimani.takings.totalCents).toBe(1440000)
    expect(r.body.total.takings).toEqual({ cashCents: 575000 + 1440000, mpesaCents: 129000, totalCents: 2144000 })
    expect(r.body.total.paidSales).toEqual({ count: 4, valueCents: 2144000, averageCents: 536000 })
    expect(r.body.total.netCents).toBe(531000 + 1440000)
    expect(r.body.total.refunds.valueCents).toBe(173000)
  })

  it('is owner only', async () => {
    expect((await (await Client.login('manager')).get('/api/reports/branches')).status).toBe(403)
    expect((await (await Client.login('cashier')).get('/api/reports/branches')).status).toBe(403)
  })
})
