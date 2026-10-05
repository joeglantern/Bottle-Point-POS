import { beforeEach, describe, expect, it } from 'vitest'
import { Client, resetDb, seedFixture, type Fixture } from './helpers.js'
import { prisma, type PayMethod } from '../src/db.js'
import { applyPayment } from '../src/rules/sale-core.js'
import { todayNairobi } from '../src/rules/reports.js'

let fx: Fixture
beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
})

async function makeSale(branchId: string, userId: string, items: { productId: string; unitCents: number; qty: number }[]) {
  const b = await prisma.branch.update({ where: { id: branchId }, data: { nextSaleNo: { increment: 1 } } })
  const subtotal = items.reduce((a, i) => a + i.unitCents * i.qty, 0)
  return prisma.sale.create({
    data: {
      branchId,
      number: b.nextSaleNo - 1,
      createdById: userId,
      status: 'SAVED',
      subtotalCents: subtotal,
      totalCents: subtotal,
      lines: { create: items.map(i => ({ productId: i.productId, name: 'x', unitCents: i.unitCents, qty: i.qty })) }
    }
  })
}

let refNo = 0
const pay = (saleId: string, method: PayMethod, amountCents: number, receivedById: string, shiftId: string | null) =>
  prisma.$transaction(tx =>
    applyPayment(tx, {
      saleId,
      method,
      amountCents,
      receivedById,
      shiftId,
      verification: method === 'CASH' ? 'CASH' : 'MANUAL_UNVERIFIED',
      mpesaRef: method === 'MPESA' ? `QWE${String(++refNo).padStart(7, '0')}` : null
    })
  )

describe('shifts', () => {
  it('opens a shift with a float, and a second open is refused with the existing shift', async () => {
    const c = await Client.login('cashier')
    const r = await c.post('/api/shifts/open', { openingFloatCents: 500000 })
    expect(r.status).toBe(201)
    expect(r.body.shift).toMatchObject({ open: true, openingFloatCents: 500000, expectedCashCents: 500000, userName: 'cashier' })

    const again = await c.post('/api/shifts/open', { openingFloatCents: 100 })
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('shift_already_open')
    expect(again.body.error.details.shift.id).toBe(r.body.shift.id)
  })

  it('two opens at once: exactly one wins', async () => {
    const c = await Client.login('cashier')
    const rs = await Promise.all([c.post('/api/shifts/open', { openingFloatCents: 0 }), c.post('/api/shifts/open', { openingFloatCents: 0 })])
    expect(rs.map(r => r.status).sort()).toEqual([201, 409])
    expect(await prisma.shift.count()).toBe(1)
  })

  it('validates the float', async () => {
    const c = await Client.login('cashier')
    expect((await c.post('/api/shifts/open', { openingFloatCents: -1 })).status).toBe(400)
    expect((await c.post('/api/shifts/open', { openingFloatCents: 10.5 })).status).toBe(400)
    expect((await c.post('/api/shifts/open', {})).status).toBe(400)
  })

  it('owner must pick a branch, and cannot use a branch outside the business', async () => {
    const o = await Client.login('owner')
    expect((await o.post('/api/shifts/open', { openingFloatCents: 0 })).status).toBe(403)
    const k = await Client.login('kilicashier', undefined, fx.branches.west.id)
    expect((await k.post('/api/shifts/open', { openingFloatCents: 0 })).status).toBe(403)
    const ow = await Client.login('owner', undefined, fx.branches.kili.id)
    expect((await ow.post('/api/shifts/open', { openingFloatCents: 0 })).status).toBe(201)
  })

  it('current shift is null when none is open', async () => {
    const c = await Client.login('cashier')
    const r = await c.get('/api/shifts/current')
    expect(r.status).toBe(200)
    expect(r.body.shift).toBeNull()
  })

  it('tracks cash, M-Pesa and cash refunds, and closes with the right variance', async () => {
    const c = await Client.login('cashier')
    const m = await Client.login('manager')
    const opened = (await c.post('/api/shifts/open', { openingFloatCents: 500000 })).body.shift
    const { whisky, beer, gin } = fx.products
    const u = fx.users

    const a = await makeSale(fx.branches.west.id, u.cashier.id, [{ productId: whisky.id, unitCents: 480000, qty: 1 }])
    await pay(a.id, 'CASH', 480000, u.cashier.id, opened.id)
    const b = await makeSale(fx.branches.west.id, u.cashier.id, [{ productId: beer.id, unitCents: 28000, qty: 2 }])
    await pay(b.id, 'MPESA', 56000, u.cashier.id, opened.id)
    const g = await makeSale(fx.branches.west.id, u.cashier.id, [{ productId: gin.id, unitCents: 145000, qty: 1 }])
    await pay(g.id, 'CASH', 145000, u.cashier.id, opened.id)

    // refund of the gin, approved by a manager without a shift: it comes out of the cashier's till
    const req = await c.post('/api/approvals', { saleId: g.id, kind: 'REFUND', reason: 'Wrong bottle', refundMethod: 'CASH' })
    expect(req.status).toBe(201)
    expect((await m.post(`/api/approvals/${req.body.approval.id}/approve`)).status).toBe(200)

    const cur = (await c.get('/api/shifts/current')).body.shift
    expect(cur).toMatchObject({
      id: opened.id,
      cashTakenCents: 625000,
      mpesaTakenCents: 56000,
      cashRefundsCents: 145000,
      expectedCashCents: 500000 + 625000 - 145000
    })

    const closed = await c.post(`/api/shifts/${opened.id}/close`, { countedCashCents: 975000, note: 'short 50' })
    expect(closed.status).toBe(200)
    expect(closed.body.shift).toMatchObject({ open: false, expectedCashCents: 980000, countedCashCents: 975000, varianceCents: -5000, closeNote: 'short 50' })
    const row = await prisma.shift.findUniqueOrThrow({ where: { id: opened.id } })
    expect(row.varianceCents).toBe(-5000)
    expect(row.closedAt).not.toBeNull()

    const twice = await c.post(`/api/shifts/${opened.id}/close`, { countedCashCents: 975000 })
    expect(twice.status).toBe(422)
    expect(twice.body.error.code).toBe('shift_closed')
    expect((await c.get('/api/shifts/current')).body.shift).toBeNull()
    // a new shift can be opened after closing
    expect((await c.post('/api/shifts/open', { openingFloatCents: 0 })).status).toBe(201)
  })

  it('over counted cash gives a positive variance', async () => {
    const c = await Client.login('cashier')
    const s = (await c.post('/api/shifts/open', { openingFloatCents: 1000 })).body.shift
    const r = await c.post(`/api/shifts/${s.id}/close`, { countedCashCents: 1500 })
    expect(r.body.shift.varianceCents).toBe(500)
  })

  it('only the owner of the shift or a manager of that branch can close it', async () => {
    const c = await Client.login('cashier')
    const s = (await c.post('/api/shifts/open', { openingFloatCents: 0 })).body.shift
    const other = await Client.login('cashier2')
    expect((await other.post(`/api/shifts/${s.id}/close`, { countedCashCents: 0 })).status).toBe(403)
    const kili = await Client.login('kilimanager')
    expect((await kili.post(`/api/shifts/${s.id}/close`, { countedCashCents: 0 })).status).toBe(404)
    expect((await c.post(`/api/shifts/nope/close`, { countedCashCents: 0 })).status).toBe(404)
    expect((await c.post(`/api/shifts/${s.id}/close`, { countedCashCents: -5 })).status).toBe(400)
    const m = await Client.login('manager')
    expect((await m.post(`/api/shifts/${s.id}/close`, { countedCashCents: 0 })).status).toBe(200)
  })

  it('two closes at once: exactly one wins', async () => {
    const c = await Client.login('cashier')
    const m = await Client.login('manager')
    const s = (await c.post('/api/shifts/open', { openingFloatCents: 100 })).body.shift
    const rs = await Promise.all([
      c.post(`/api/shifts/${s.id}/close`, { countedCashCents: 100 }),
      m.post(`/api/shifts/${s.id}/close`, { countedCashCents: 90 })
    ])
    expect(rs.map(r => r.status).sort()).toEqual([200, 422])
  })

  it('lists the day shifts for managers, branch scoped, with names', async () => {
    const c = await Client.login('cashier')
    const c2 = await Client.login('cashier2')
    await c.post('/api/shifts/open', { openingFloatCents: 100 })
    const s2 = (await c2.post('/api/shifts/open', { openingFloatCents: 200 })).body.shift
    await c2.post(`/api/shifts/${s2.id}/close`, { countedCashCents: 200 })
    await (await Client.login('kilicashier')).post('/api/shifts/open', { openingFloatCents: 300 })

    const m = await Client.login('manager')
    const r = await m.get(`/api/shifts?date=${todayNairobi()}`)
    expect(r.status).toBe(200)
    expect(r.body.shifts.map((s: any) => s.userName).sort()).toEqual(['cashier', 'cashier2'])
    expect(r.body.shifts.find((s: any) => s.userName === 'cashier2')).toMatchObject({ varianceCents: 0, open: false })

    // a day with nothing
    expect((await m.get('/api/shifts?date=2020-01-01')).body.shifts).toEqual([])
    expect((await m.get('/api/shifts?date=2020-13-01')).status).toBe(400)
    expect((await c.get('/api/shifts')).status).toBe(403)
    expect((await m.get(`/api/shifts?branchId=${fx.branches.kili.id}`)).status).toBe(403)
  })

  it('a shift that spans midnight shows on both days', async () => {
    const s = await prisma.shift.create({
      data: {
        branchId: fx.branches.west.id,
        userId: fx.users.cashier.id,
        openingFloatCents: 0,
        openedAt: new Date('2026-03-10T22:00:00+03:00'),
        closedAt: new Date('2026-03-11T02:00:00+03:00')
      }
    })
    const m = await Client.login('manager')
    for (const d of ['2026-03-10', '2026-03-11']) expect((await m.get(`/api/shifts?date=${d}`)).body.shifts.map((x: any) => x.id)).toEqual([s.id])
    expect((await m.get('/api/shifts?date=2026-03-12')).body.shifts).toEqual([])
    expect((await m.get('/api/shifts?date=2026-03-09')).body.shifts).toEqual([])
  })
})
