import { beforeEach, describe, expect, it } from 'vitest'
import { Client, resetDb, seedFixture, type Fixture } from './helpers.js'
import { connectSocket, nextEvent, noEvent, startServer } from './realtime-helpers.js'
import { prisma, type PayMethod } from '../src/db.js'
import { applyPayment } from '../src/rules/sale-core.js'

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
const pay = (saleId: string, method: PayMethod, amountCents: number, receivedById: string, shiftId: string | null = null) =>
  prisma.$transaction(tx =>
    applyPayment(tx, {
      saleId,
      method,
      amountCents,
      receivedById,
      shiftId,
      verification: method === 'CASH' ? 'CASH' : 'MANUAL_UNVERIFIED',
      mpesaRef: method === 'MPESA' ? `ZXC${String(++refNo).padStart(7, '0')}` : null
    })
  )

const westSale = (qty = 1) =>
  makeSale(fx.branches.west.id, fx.users.cashier.id, [{ productId: fx.products.whisky.id, unitCents: 480000, qty }])
const paidWestSale = async (shiftId: string | null = null) => {
  const s = await westSale(2)
  await pay(s.id, 'CASH', 960000, fx.users.cashier.id, shiftId)
  return s
}
const stockOf = async (branchId: string, productId: string) =>
  (await prisma.stock.findUniqueOrThrow({ where: { branchId_productId: { branchId, productId } } })).qty

describe('approval requests', () => {
  it('validates input', async () => {
    const c = await Client.login('cashier')
    const s = await westSale()
    const bad = [
      { saleId: s.id, kind: 'CANCEL', reason: 'no' },
      { saleId: s.id, kind: 'NUKE', reason: 'because' },
      { saleId: s.id, kind: 'CANCEL', reason: 'x'.repeat(301) },
      { saleId: s.id, kind: 'DISCOUNT', reason: 'regular' },
      { saleId: s.id, kind: 'DISCOUNT', reason: 'regular', amountCents: 0 },
      { saleId: s.id, kind: 'DISCOUNT', reason: 'regular', amountCents: 10.5 },
      { saleId: s.id, kind: 'CANCEL', reason: 'changed mind', refundMethod: 'CASH' },
      { saleId: s.id, kind: 'CANCEL', reason: 'changed mind', amountCents: 5 },
      { kind: 'CANCEL', reason: 'changed mind' }
    ]
    for (const b of bad) expect((await c.post('/api/approvals', b)).status, JSON.stringify(b)).toBe(400)
    expect((await c.post('/api/approvals', { saleId: 'nope', kind: 'CANCEL', reason: 'changed mind' })).status).toBe(404)
  })

  it('a user of another branch cannot request on the sale', async () => {
    const s = await westSale()
    const k = await Client.login('kilicashier')
    expect((await k.post('/api/approvals', { saleId: s.id, kind: 'CANCEL', reason: 'changed mind' })).status).toBe(404)
  })

  it('one pending request per sale and kind', async () => {
    const c = await Client.login('cashier')
    const s = await westSale()
    expect((await c.post('/api/approvals', { saleId: s.id, kind: 'CANCEL', reason: 'changed mind' })).status).toBe(201)
    const dup = await c.post('/api/approvals', { saleId: s.id, kind: 'CANCEL', reason: 'again' })
    expect(dup.status).toBe(409)
    expect(dup.body.error.code).toBe('approval_pending')
    // a different kind is fine
    expect((await c.post('/api/approvals', { saleId: s.id, kind: 'DISCOUNT', reason: 'regular', amountCents: 100 })).status).toBe(201)
  })

  it('two identical requests at once: exactly one is created', async () => {
    const c = await Client.login('cashier')
    const s = await westSale()
    const rs = await Promise.all([1, 2].map(() => c.post('/api/approvals', { saleId: s.id, kind: 'CANCEL', reason: 'changed mind' })))
    expect(rs.map(r => r.status).sort()).toEqual([201, 409])
  })
})

describe('cancel', () => {
  it('cancels an unpaid sale once a manager approves, without touching stock', async () => {
    const c = await Client.login('cashier')
    const m = await Client.login('manager')
    const s = await westSale()
    const req = await c.post('/api/approvals', { saleId: s.id, kind: 'CANCEL', reason: 'Customer left' })
    expect(req.status).toBe(201)
    expect(req.body.approval).toMatchObject({ status: 'PENDING', kind: 'CANCEL', saleNumber: s.number, saleTotalCents: 480000, requestedByName: 'cashier' })

    const ok = await m.post(`/api/approvals/${req.body.approval.id}/approve`, { note: 'fine' })
    expect(ok.status).toBe(200)
    expect(ok.body.approval).toMatchObject({ status: 'APPROVED', decidedByName: 'manager' })
    expect(ok.body.sale.status).toBe('CANCELLED')
    const row = await prisma.sale.findUniqueOrThrow({ where: { id: s.id } })
    expect(row.cancelledAt).not.toBeNull()
    expect(await stockOf(fx.branches.west.id, fx.products.whisky.id)).toBe(50)
    expect(await prisma.auditLog.count({ where: { action: 'sale.cancel', entityId: s.id } })).toBe(1)

    const twice = await m.post(`/api/approvals/${req.body.approval.id}/approve`)
    expect(twice.status).toBe(422)
    expect(twice.body.error.code).toBe('already_decided')
  })

  it('is blocked when the sale is part paid, or paid', async () => {
    const c = await Client.login('cashier')
    const s = await westSale(2)
    await pay(s.id, 'CASH', 100000, fx.users.cashier.id)
    const r = await c.post('/api/approvals', { saleId: s.id, kind: 'CANCEL', reason: 'changed mind' })
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('sale_part_paid')
    expect(r.body.error.message).toMatch(/refund/)

    const p = await paidWestSale()
    const r2 = await c.post('/api/approvals', { saleId: p.id, kind: 'CANCEL', reason: 'changed mind' })
    expect(r2.status).toBe(422)
    expect(r2.body.error.code).toBe('sale_paid')
  })

  it('stays pending if the sale got a payment before the decision', async () => {
    const c = await Client.login('cashier')
    const m = await Client.login('manager')
    const s = await westSale()
    const req = await c.post('/api/approvals', { saleId: s.id, kind: 'CANCEL', reason: 'changed mind' })
    await pay(s.id, 'CASH', 1000, fx.users.cashier.id)
    const r = await m.post(`/api/approvals/${req.body.approval.id}/approve`)
    expect(r.status).toBe(422)
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: req.body.approval.id } })).status).toBe('PENDING')
    expect((await prisma.sale.findUniqueOrThrow({ where: { id: s.id } })).status).toBe('SAVED')
  })
})

describe('refund', () => {
  it('needs a paid sale, a method and the full amount', async () => {
    const c = await Client.login('cashier')
    const unpaid = await westSale()
    const r = await c.post('/api/approvals', { saleId: unpaid.id, kind: 'REFUND', reason: 'broken', refundMethod: 'CASH' })
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('sale_not_paid')

    const p = await paidWestSale()
    expect((await c.post('/api/approvals', { saleId: p.id, kind: 'REFUND', reason: 'broken' })).status).toBe(400)
    const part = await c.post('/api/approvals', { saleId: p.id, kind: 'REFUND', reason: 'broken', refundMethod: 'CASH', amountCents: 1000 })
    expect(part.status).toBe(422)
    expect(part.body.error.code).toBe('partial_refund')
    const full = await c.post('/api/approvals', { saleId: p.id, kind: 'REFUND', reason: 'broken', refundMethod: 'CASH', amountCents: 960000 })
    expect(full.status).toBe(201)
    expect(full.body.approval.amountCents).toBe(960000)
  })

  it('returns stock and pays out of the requester till', async () => {
    const c = await Client.login('cashier')
    const m = await Client.login('manager')
    const shift = (await c.post('/api/shifts/open', { openingFloatCents: 0 })).body.shift
    const p = await paidWestSale(shift.id)
    expect(await stockOf(fx.branches.west.id, fx.products.whisky.id)).toBe(48)

    const req = await c.post('/api/approvals', { saleId: p.id, kind: 'REFUND', reason: 'Corked', refundMethod: 'CASH' })
    const ok = await m.post(`/api/approvals/${req.body.approval.id}/approve`)
    expect(ok.status).toBe(200)
    expect(ok.body.sale.status).toBe('REFUNDED')
    expect(ok.body.sale.payments).toHaveLength(1)

    expect(await stockOf(fx.branches.west.id, fx.products.whisky.id)).toBe(50)
    const mv = await prisma.stockMovement.findMany({ where: { saleId: p.id, reason: 'REFUND' } })
    expect(mv.map(x => x.delta)).toEqual([2])
    const refund = await prisma.refund.findFirstOrThrow({ where: { saleId: p.id } })
    expect(refund).toMatchObject({ amountCents: 960000, method: 'CASH', shiftId: shift.id, paidOutById: fx.users.manager.id })
    const sale = await prisma.sale.findUniqueOrThrow({ where: { id: p.id } })
    expect(sale.refundedAt).not.toBeNull()
  })

  it('falls back to the approver till when the requester has none open', async () => {
    const c = await Client.login('cashier')
    const m = await Client.login('manager')
    const p = await paidWestSale()
    const mShift = (await m.post('/api/shifts/open', { openingFloatCents: 0 })).body.shift
    const req = await c.post('/api/approvals', { saleId: p.id, kind: 'REFUND', reason: 'Corked', refundMethod: 'CASH' })
    expect((await m.post(`/api/approvals/${req.body.approval.id}/approve`)).status).toBe(200)
    expect((await prisma.refund.findFirstOrThrow({ where: { saleId: p.id } })).shiftId).toBe(mShift.id)
  })

  it('a cash refund with no open till anywhere is refused and stays pending', async () => {
    const c = await Client.login('cashier')
    const m = await Client.login('manager')
    const p = await paidWestSale()
    const req = await c.post('/api/approvals', { saleId: p.id, kind: 'REFUND', reason: 'Corked', refundMethod: 'CASH' })
    const r = await m.post(`/api/approvals/${req.body.approval.id}/approve`)
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('no_open_shift')
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: req.body.approval.id } })).status).toBe('PENDING')
    expect((await prisma.sale.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('PAID')
    expect(await prisma.refund.count()).toBe(0)
    expect(await stockOf(fx.branches.west.id, fx.products.whisky.id)).toBe(48)
  })

  it('an M-Pesa refund is recorded without a till', async () => {
    const c = await Client.login('cashier')
    const m = await Client.login('manager')
    const p = await paidWestSale()
    const req = await c.post('/api/approvals', { saleId: p.id, kind: 'REFUND', reason: 'Corked', refundMethod: 'MPESA' })
    expect((await m.post(`/api/approvals/${req.body.approval.id}/approve`)).status).toBe(200)
    expect(await prisma.refund.findFirstOrThrow({ where: { saleId: p.id } })).toMatchObject({ method: 'MPESA', shiftId: null })
  })
})

describe('discount', () => {
  it('applies the discount and recomputes totals', async () => {
    const c = await Client.login('cashier')
    const m = await Client.login('manager')
    const s = await westSale(2)
    expect((await c.post('/api/approvals', { saleId: s.id, kind: 'DISCOUNT', reason: 'Regular', amountCents: 960001 })).status).toBe(422)
    const req = await c.post('/api/approvals', { saleId: s.id, kind: 'DISCOUNT', reason: 'Regular', amountCents: 60000 })
    expect(req.status).toBe(201)
    const ok = await m.post(`/api/approvals/${req.body.approval.id}/approve`)
    expect(ok.status).toBe(200)
    expect(ok.body.sale).toMatchObject({ subtotalCents: 960000, discountCents: 60000, totalCents: 900000, dueCents: 900000 })
  })

  it('is refused on a part paid or paid sale', async () => {
    const c = await Client.login('cashier')
    const m = await Client.login('manager')
    const s = await westSale(2)
    const req = await c.post('/api/approvals', { saleId: s.id, kind: 'DISCOUNT', reason: 'Regular', amountCents: 1000 })
    await pay(s.id, 'CASH', 1000, fx.users.cashier.id)
    expect((await c.post('/api/approvals', { saleId: s.id, kind: 'DISCOUNT', reason: 'Regular', amountCents: 1000 })).status).toBe(409)
    const r = await m.post(`/api/approvals/${req.body.approval.id}/approve`)
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('sale_part_paid')
    const p = await paidWestSale()
    expect((await c.post('/api/approvals', { saleId: p.id, kind: 'DISCOUNT', reason: 'Regular', amountCents: 1000 })).status).toBe(422)
  })
})

describe('deciding', () => {
  it('cashiers cannot decide, other branches get 404', async () => {
    const c = await Client.login('cashier')
    const s = await westSale()
    const req = await c.post('/api/approvals', { saleId: s.id, kind: 'CANCEL', reason: 'changed mind' })
    const id = req.body.approval.id
    expect((await (await Client.login('cashier2')).post(`/api/approvals/${id}/approve`)).status).toBe(403)
    expect((await (await Client.login('kilimanager')).post(`/api/approvals/${id}/approve`)).status).toBe(404)
    expect((await (await Client.login('manager')).post(`/api/approvals/nope/approve`)).status).toBe(404)
  })

  it('a manager cannot decide their own request, the owner can', async () => {
    const m = await Client.login('manager')
    const s = await westSale()
    const req = await m.post('/api/approvals', { saleId: s.id, kind: 'CANCEL', reason: 'changed mind' })
    expect((await m.post(`/api/approvals/${req.body.approval.id}/approve`)).status).toBe(403)
    expect((await m.post(`/api/approvals/${req.body.approval.id}/reject`)).status).toBe(403)

    const o = await Client.login('owner', undefined, fx.branches.west.id)
    const s2 = await westSale()
    const own = await o.post('/api/approvals', { saleId: s2.id, kind: 'CANCEL', reason: 'changed mind' })
    expect((await o.post(`/api/approvals/${own.body.approval.id}/approve`)).status).toBe(200)
    expect((await o.post(`/api/approvals/${req.body.approval.id}/approve`)).status).toBe(200)
  })

  it('reject leaves the sale alone, and cannot be decided again', async () => {
    const c = await Client.login('cashier')
    const m = await Client.login('manager')
    const s = await westSale()
    const req = await c.post('/api/approvals', { saleId: s.id, kind: 'CANCEL', reason: 'changed mind' })
    const r = await m.post(`/api/approvals/${req.body.approval.id}/reject`, { note: 'No' })
    expect(r.status).toBe(200)
    expect(r.body.approval).toMatchObject({ status: 'REJECTED', decidedByName: 'manager' })
    expect((await prisma.sale.findUniqueOrThrow({ where: { id: s.id } })).status).toBe('SAVED')
    expect((await m.post(`/api/approvals/${req.body.approval.id}/approve`)).status).toBe(422)
    // a new request is allowed once the old one is decided
    expect((await c.post('/api/approvals', { saleId: s.id, kind: 'CANCEL', reason: 'really' })).status).toBe(201)
  })

  it('two managers approving at once: exactly one wins, and stock moves once', async () => {
    const c = await Client.login('cashier')
    const shift = (await c.post('/api/shifts/open', { openingFloatCents: 0 })).body.shift
    const p = await paidWestSale(shift.id)
    const req = await c.post('/api/approvals', { saleId: p.id, kind: 'REFUND', reason: 'Corked', refundMethod: 'CASH' })
    const m = await Client.login('manager')
    const o = await Client.login('owner')
    const rs = await Promise.all([
      m.post(`/api/approvals/${req.body.approval.id}/approve`),
      o.post(`/api/approvals/${req.body.approval.id}/approve`),
      m.post(`/api/approvals/${req.body.approval.id}/reject`)
    ])
    expect(rs.map(r => r.status).sort()).toEqual([200, 422, 422])
    expect(await prisma.refund.count()).toBe(rs.findIndex(r => r.status === 200) === 2 ? 0 : 1)
    expect(await stockOf(fx.branches.west.id, fx.products.whisky.id)).toBe(rs[2]!.status === 200 ? 48 : 50)
  })
})

describe('listing', () => {
  it('managers see their branches, cashiers only their own requests', async () => {
    const c = await Client.login('cashier')
    const c2 = await Client.login('cashier2')
    const m = await Client.login('manager')
    const k = await Client.login('kilicashier')
    const s1 = await westSale()
    const s2 = await westSale()
    const ks = await makeSale(fx.branches.kili.id, fx.users.kiliCashier.id, [{ productId: fx.products.beer.id, unitCents: 28000, qty: 1 }])
    const a1 = (await c.post('/api/approvals', { saleId: s1.id, kind: 'CANCEL', reason: 'changed mind' })).body.approval
    await c2.post('/api/approvals', { saleId: s2.id, kind: 'CANCEL', reason: 'changed mind' })
    await k.post('/api/approvals', { saleId: ks.id, kind: 'CANCEL', reason: 'changed mind' })
    await m.post(`/api/approvals/${a1.id}/approve`)

    expect((await c.get('/api/approvals')).body.approvals.map((a: any) => a.saleId)).toEqual([s1.id])
    const all = (await m.get('/api/approvals')).body.approvals
    expect(all.map((a: any) => a.saleId).sort()).toEqual([s1.id, s2.id].sort())
    expect((await m.get('/api/approvals?status=PENDING')).body.approvals.map((a: any) => a.requestedByName)).toEqual(['cashier2'])
    const approved = (await m.get('/api/approvals?status=APPROVED')).body.approvals
    expect(approved[0]).toMatchObject({ saleNumber: s1.number, saleTotalCents: 480000, requestedByName: 'cashier', decidedByName: 'manager' })
    expect((await m.get(`/api/approvals?saleId=${s2.id}`)).body.approvals).toHaveLength(1)
    expect((await m.get('/api/approvals?status=MAYBE')).status).toBe(400)
    expect((await m.get(`/api/approvals?branchId=${fx.branches.kili.id}`)).status).toBe(403)
    const owner = (await (await Client.login('owner')).get('/api/approvals')).body.approvals
    expect(owner).toHaveLength(3)
  })
})

describe('realtime', () => {
  it('approval:updated reaches the branch room and not another branch', async () => {
    const srv = await startServer()
    try {
      const c = await Client.login('cashier')
      const west = await connectSocket(srv.url, (await Client.login('manager')).cookie)
      const kili = await connectSocket(srv.url, (await Client.login('kilimanager')).cookie)
      const s = await westSale()
      const got = nextEvent(west, 'approval:updated')
      const quiet = noEvent(kili, 'approval:updated')
      const req = await c.post('/api/approvals', { saleId: s.id, kind: 'CANCEL', reason: 'changed mind' })
      expect((await got).approval).toMatchObject({ id: req.body.approval.id, status: 'PENDING' })
      await quiet

      const decided = nextEvent(west, 'approval:updated')
      const saleEv = nextEvent(west, 'sale:updated')
      await (await Client.login('manager')).post(`/api/approvals/${req.body.approval.id}/approve`)
      expect((await decided).approval.status).toBe('APPROVED')
      expect((await saleEv).sale.status).toBe('CANCELLED')
      west.close()
      kili.close()
    } finally {
      await srv.stop()
    }
  })
})
