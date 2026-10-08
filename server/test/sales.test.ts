import { beforeEach, describe, expect, it } from 'vitest'
import { Client, resetDb, seedFixture, type Fixture } from './helpers.js'
import { prisma } from '../src/db.js'

let fx: Fixture
let cashier: Client

beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
  cashier = await Client.login('cashier')
})

const openShiftFor = (userId: string, branchId: string) =>
  prisma.shift.create({ data: { userId, branchId, openingFloatCents: 500000 } })

async function newSale(c: Client = cashier, lines?: { productId: string; qty: number }[], extra: Record<string, unknown> = {}) {
  const r = await c.post('/api/sales', { lines: lines ?? [{ productId: fx.products.whisky.id, qty: 1 }, { productId: fx.products.beer.id, qty: 2 }], ...extra })
  expect(r.status).toBe(201)
  return r.body.sale
}

const stockOf = async (branchId: string, productId: string) =>
  (await prisma.stock.findUniqueOrThrow({ where: { branchId_productId: { branchId, productId } } })).qty

describe('create sale', () => {
  it('saves immediately with a branch number and snapshots', async () => {
    const sale = await newSale(cashier, undefined, { label: ' Table 4 ' })
    expect(sale.status).toBe('SAVED')
    expect(sale.number).toBe(1001)
    expect(sale.label).toBe('Table 4')
    expect(sale.subtotalCents).toBe(480000 + 2 * 28000)
    expect(sale.totalCents).toBe(536000)
    expect(sale.dueCents).toBe(536000)
    expect(sale.lines.find((l: any) => l.productId === fx.products.beer.id)).toMatchObject({ name: 'Tusker Lager', unitCents: 28000, qty: 2, lineCents: 56000 })
    expect(sale.branchId).toBe(fx.branches.west.id)
    const next = await newSale()
    expect(next.number).toBe(1002)
    const b = await prisma.branch.findUniqueOrThrow({ where: { id: fx.branches.west.id } })
    expect(b.nextSaleNo).toBe(1003)
    expect(await prisma.auditLog.count({ where: { action: 'sale.create' } })).toBe(2)
  })

  it('merges duplicate products', async () => {
    const s = await newSale(cashier, [
      { productId: fx.products.beer.id, qty: 2 },
      { productId: fx.products.beer.id, qty: 3 }
    ])
    expect(s.lines).toHaveLength(1)
    expect(s.lines[0].qty).toBe(5)
    expect(s.totalCents).toBe(140000)
  })

  it('later price changes do not rewrite the sale', async () => {
    const s = await newSale()
    await prisma.product.update({ where: { id: fx.products.whisky.id }, data: { priceCents: 999900, name: 'Renamed' } })
    const r = await cashier.get(`/api/sales/${s.id}`)
    expect(r.body.sale.totalCents).toBe(536000)
    expect(r.body.sale.lines.some((l: any) => l.name === 'Renamed')).toBe(false)
  })

  it('numbers never repeat under concurrency', async () => {
    const c2 = await Client.login('cashier2')
    const all = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 ? cashier : c2).post('/api/sales', { lines: [{ productId: fx.products.beer.id, qty: 1 }] }))
    )
    expect(all.every(r => r.status === 201)).toBe(true)
    const nums = all.map(r => r.body.sale.number)
    expect(new Set(nums).size).toBe(10)
    expect([...nums].sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, i) => 1001 + i))
  })

  it('numbers are per branch', async () => {
    const k = await Client.login('kilicashier')
    await newSale()
    const ks = await newSale(k)
    expect(ks.number).toBe(1001)
    expect(ks.branchId).toBe(fx.branches.kili.id)
  })

  it('validates input with 400', async () => {
    const bad = [
      {},
      { lines: [] },
      { lines: [{ productId: fx.products.beer.id, qty: 0 }] },
      { lines: [{ productId: fx.products.beer.id, qty: 1000 }] },
      { lines: [{ productId: fx.products.beer.id, qty: 1.5 }] },
      { lines: [{ productId: fx.products.beer.id, qty: '2' }] },
      { lines: [{ productId: '', qty: 1 }] },
      { lines: [{ productId: fx.products.beer.id, qty: 1 }], label: 'x'.repeat(61) },
      { lines: [{ productId: fx.products.beer.id, qty: 600 }, { productId: fx.products.beer.id, qty: 600 }] }
    ]
    for (const b of bad) {
      const r = await cashier.post('/api/sales', b)
      expect(r.status, JSON.stringify(b)).toBe(400)
      expect(r.body.error.code).toBe('bad_request')
    }
    const r = await cashier.post('/api/sales', { lines: [{ productId: fx.products.beer.id, qty: 0 }] })
    expect(r.body.error.details).toBeTruthy()
    expect(await prisma.sale.count()).toBe(0)
  })

  it('refuses inactive or foreign products and unknown customers', async () => {
    await prisma.product.update({ where: { id: fx.products.gin.id }, data: { active: false } })
    const other = await prisma.business.create({ data: { name: 'Other' } })
    const foreign = await prisma.product.create({ data: { businessId: other.id, name: 'X', priceCents: 100, category: 'Beer' } })
    const foreignCustomer = await prisma.customer.create({ data: { businessId: other.id, name: 'Y' } })
    for (const pid of [fx.products.gin.id, foreign.id, 'nope']) {
      const r = await cashier.post('/api/sales', { lines: [{ productId: pid, qty: 1 }] })
      expect(r.status).toBe(422)
      expect(r.body.error.code).toBe('unknown_product')
    }
    const r = await cashier.post('/api/sales', { lines: [{ productId: fx.products.beer.id, qty: 1 }], customerId: foreignCustomer.id })
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('unknown_customer')
    const mine = await prisma.customer.create({ data: { businessId: fx.business.id, name: 'Wanjiru', phone: '254712345678' } })
    const ok = await newSale(cashier, undefined, { customerId: mine.id })
    expect(ok.customer).toMatchObject({ id: mine.id, name: 'Wanjiru' })
    expect(await prisma.sale.count()).toBe(1)
  })

  it('owner picks the branch with x-branch-id, cannot skip it, cashier cannot pick another branch', async () => {
    const owner = await Client.login('owner')
    const none = await owner.post('/api/sales', { lines: [{ productId: fx.products.beer.id, qty: 1 }] })
    expect(none.status).toBe(403)
    owner.branchId = fx.branches.kili.id
    const s = await newSale(owner)
    expect(s.branchId).toBe(fx.branches.kili.id)
    cashier.branchId = fx.branches.kili.id
    const r = await cashier.post('/api/sales', { lines: [{ productId: fx.products.beer.id, qty: 1 }] })
    expect(r.status).toBe(403)
  })
})

describe('list and read', () => {
  it('lists the branch only, newest first, with filters', async () => {
    const k = await Client.login('kilicashier')
    const a = await newSale(cashier, undefined, { label: 'Table 1' })
    const b = await newSale(cashier, undefined, { label: 'Bar counter' })
    await newSale(k)
    await openShiftFor(fx.users.cashier.id, fx.branches.west.id)
    await cashier.post(`/api/sales/${a.id}/pay`, { payments: [{ method: 'CASH', amountCents: a.totalCents }] })

    const all = await cashier.get('/api/sales')
    expect(all.status).toBe(200)
    expect(all.body.sales.map((s: any) => s.id)).toEqual([b.id, a.id])

    const unpaid = await cashier.get('/api/sales?status=SAVED')
    expect(unpaid.body.sales.map((s: any) => s.id)).toEqual([b.id])

    // shared by every cashier of the branch
    const c2 = await Client.login('cashier2')
    expect((await c2.get('/api/sales?status=SAVED')).body.sales.map((s: any) => s.id)).toEqual([b.id])

    expect((await cashier.get('/api/sales?status=PAID')).body.sales.map((s: any) => s.id)).toEqual([a.id])
    expect((await cashier.get('/api/sales?q=bar')).body.sales.map((s: any) => s.id)).toEqual([b.id])
    expect((await cashier.get(`/api/sales?q=%23${a.number}`)).body.sales.map((s: any) => s.id)).toEqual([a.id])
    expect((await cashier.get('/api/sales?limit=1')).body.sales).toHaveLength(1)

    const kl = await k.get('/api/sales')
    expect(kl.body.sales).toHaveLength(1)
    expect(kl.body.sales[0].branchId).toBe(fx.branches.kili.id)
  })

  it('filters by Nairobi day', async () => {
    const s = await newSale()
    // 22:30 UTC on 4 Oct is 01:30 on 5 Oct in Nairobi
    await prisma.sale.update({ where: { id: s.id }, data: { createdAt: new Date('2026-10-04T22:30:00Z') } })
    expect((await cashier.get('/api/sales?date=2026-10-05')).body.sales).toHaveLength(1)
    expect((await cashier.get('/api/sales?date=2026-10-04')).body.sales).toHaveLength(0)
  })

  it('validates the query', async () => {
    for (const qs of ['status=NOPE', 'date=2026-13-01', 'date=05-10-2026', 'limit=0', 'limit=501', 'limit=abc']) {
      const r = await cashier.get(`/api/sales?${qs}`)
      expect(r.status, qs).toBe(400)
    }
    expect((await cashier.get('/api/sales?limit=500')).status).toBe(200)
  })

  it('another branch sale is 404, owner sees it by id', async () => {
    const k = await Client.login('kilicashier')
    const ks = await newSale(k)
    expect((await cashier.get(`/api/sales/${ks.id}`)).status).toBe(404)
    expect((await cashier.get('/api/sales/does-not-exist')).status).toBe(404)
    const owner = await Client.login('owner')
    const r = await owner.get(`/api/sales/${ks.id}`)
    expect(r.status).toBe(200)
    expect(r.body.sale.id).toBe(ks.id)
    const km = await Client.login('kilimanager')
    expect((await km.get(`/api/sales/${ks.id}`)).status).toBe(200)
    const wm = await Client.login('manager')
    expect((await wm.get(`/api/sales/${ks.id}`)).status).toBe(404)
  })
})

describe('edit lines', () => {
  it('replaces lines, keeps old prices, new items take current price', async () => {
    const s = await newSale()
    await prisma.product.update({ where: { id: fx.products.beer.id }, data: { priceCents: 30000 } })
    const r = await cashier.put(`/api/sales/${s.id}/lines`, {
      version: s.version,
      lines: [
        { productId: fx.products.beer.id, qty: 4 },
        { productId: fx.products.gin.id, qty: 1 }
      ]
    })
    expect(r.status).toBe(200)
    const sale = r.body.sale
    expect(sale.lines).toHaveLength(2)
    expect(sale.lines.find((l: any) => l.productId === fx.products.beer.id).unitCents).toBe(28000)
    expect(sale.lines.find((l: any) => l.productId === fx.products.gin.id).unitCents).toBe(145000)
    expect(sale.totalCents).toBe(4 * 28000 + 145000)
    expect(sale.version).toBe(s.version + 1)
    expect(await prisma.auditLog.count({ where: { action: 'sale.lines' } })).toBe(1)
  })

  it('stale version is 409 with the current sale', async () => {
    const s = await newSale()
    const first = await cashier.put(`/api/sales/${s.id}/lines`, { version: s.version, lines: [{ productId: fx.products.beer.id, qty: 1 }] })
    expect(first.status).toBe(200)
    const second = await cashier.put(`/api/sales/${s.id}/lines`, { version: s.version, lines: [{ productId: fx.products.gin.id, qty: 1 }] })
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('stale_sale')
    expect(second.body.error.details.sale.version).toBe(first.body.sale.version)
    expect(second.body.error.details.sale.lines[0].productId).toBe(fx.products.beer.id)
  })

  it('two concurrent edits on the same version: exactly one wins', async () => {
    const s = await newSale()
    const c2 = await Client.login('cashier2')
    const rs = await Promise.all([
      cashier.put(`/api/sales/${s.id}/lines`, { version: s.version, lines: [{ productId: fx.products.beer.id, qty: 1 }] }),
      c2.put(`/api/sales/${s.id}/lines`, { version: s.version, lines: [{ productId: fx.products.gin.id, qty: 1 }] })
    ])
    expect(rs.map(r => r.status).sort()).toEqual([200, 409])
  })

  it('empty is allowed without payments, not with them', async () => {
    const s = await newSale()
    const r = await cashier.put(`/api/sales/${s.id}/lines`, { version: s.version, lines: [] })
    expect(r.status).toBe(200)
    expect(r.body.sale.totalCents).toBe(0)
    expect(r.body.sale.status).toBe('SAVED')
    // an empty sale cannot be paid
    const pay = await cashier.post(`/api/sales/${s.id}/pay`, { payments: [{ method: 'MPESA', amountCents: 100, mpesaRef: 'ABC1234567' }] })
    expect(pay.status).toBe(422)
  })

  it('cannot drop below what has been paid', async () => {
    const s = await newSale()
    const paid = await cashier.post(`/api/sales/${s.id}/pay`, { payments: [{ method: 'MPESA', amountCents: 100000, mpesaRef: 'QWE1234567' }] })
    expect(paid.status).toBe(200)
    const v = paid.body.sale.version
    for (const lines of [[], [{ productId: fx.products.beer.id, qty: 1 }]]) {
      const r = await cashier.put(`/api/sales/${s.id}/lines`, { version: v, lines })
      expect(r.status).toBe(422)
      expect(r.body.error.code).toBe('below_paid')
    }
    const ok = await cashier.put(`/api/sales/${s.id}/lines`, { version: v, lines: [{ productId: fx.products.gin.id, qty: 1 }] })
    expect(ok.status).toBe(200)
    expect(ok.body.sale.dueCents).toBe(45000)
  })

  it('validates, refuses paid sales and other branches', async () => {
    const s = await newSale()
    for (const b of [{ lines: [] }, { version: 0 }, { version: -1, lines: [] }, { version: 0, lines: [{ productId: fx.products.beer.id, qty: 0 }] }]) {
      expect((await cashier.put(`/api/sales/${s.id}/lines`, b)).status).toBe(400)
    }
    const k = await Client.login('kilicashier')
    expect((await k.put(`/api/sales/${s.id}/lines`, { version: s.version, lines: [] })).status).toBe(404)

    await openShiftFor(fx.users.cashier.id, fx.branches.west.id)
    const p = await cashier.post(`/api/sales/${s.id}/pay`, { payments: [{ method: 'CASH', amountCents: s.totalCents }] })
    const r = await cashier.put(`/api/sales/${s.id}/lines`, { version: p.body.sale.version, lines: [{ productId: fx.products.beer.id, qty: 9 }] })
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('sale_not_editable')
    for (const status of ['CANCELLED', 'REFUNDED'] as const) {
      const x = await newSale()
      await prisma.sale.update({ where: { id: x.id }, data: { status } })
      const e = await cashier.put(`/api/sales/${x.id}/lines`, { version: x.version, lines: [] })
      expect(e.status).toBe(422)
    }
  })
})

describe('patch', () => {
  it('sets and clears label and customer', async () => {
    const s = await newSale()
    const cust = await prisma.customer.create({ data: { businessId: fx.business.id, name: 'Otieno' } })
    const r = await cashier.patch(`/api/sales/${s.id}`, { label: 'Table 9', customerId: cust.id })
    expect(r.status).toBe(200)
    expect(r.body.sale.label).toBe('Table 9')
    expect(r.body.sale.customer.id).toBe(cust.id)
    const r2 = await cashier.patch(`/api/sales/${s.id}`, { label: null, customerId: null })
    expect(r2.body.sale.label).toBeNull()
    expect(r2.body.sale.customer).toBeNull()
  })

  it('validates and guards', async () => {
    const s = await newSale()
    expect((await cashier.patch(`/api/sales/${s.id}`, {})).status).toBe(400)
    expect((await cashier.patch(`/api/sales/${s.id}`, { label: 5 })).status).toBe(400)
    expect((await cashier.patch(`/api/sales/${s.id}`, { customerId: 'nope' })).body.error.code).toBe('unknown_customer')
    const k = await Client.login('kilicashier')
    expect((await k.patch(`/api/sales/${s.id}`, { label: 'x' })).status).toBe(404)
    await prisma.sale.update({ where: { id: s.id }, data: { status: 'PAID' } })
    const r = await cashier.patch(`/api/sales/${s.id}`, { label: 'x' })
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('sale_not_editable')
  })
})

describe('pay', () => {
  it('cash needs an open shift in that branch', async () => {
    const s = await newSale()
    const r = await cashier.post(`/api/sales/${s.id}/pay`, { payments: [{ method: 'CASH', amountCents: s.totalCents }] })
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('no_open_shift')
    // a shift in another branch or a closed one does not count
    await prisma.shift.create({ data: { userId: fx.users.cashier.id, branchId: fx.branches.kili.id, openingFloatCents: 0 } })
    await prisma.shift.create({ data: { userId: fx.users.cashier.id, branchId: fx.branches.west.id, openingFloatCents: 0, closedAt: new Date() } })
    expect((await cashier.post(`/api/sales/${s.id}/pay`, { payments: [{ method: 'CASH', amountCents: s.totalCents }] })).body.error.code).toBe('no_open_shift')
    expect(await prisma.payment.count()).toBe(0)
  })

  it('full cash payment with change, stock taken once, locked afterwards', async () => {
    const shift = await openShiftFor(fx.users.cashier.id, fx.branches.west.id)
    const s = await newSale()
    const r = await cashier.post(`/api/sales/${s.id}/pay`, { payments: [{ method: 'CASH', amountCents: 536000, tenderedCents: 600000 }] })
    expect(r.status).toBe(200)
    expect(r.body.changeCents).toBe(64000)
    expect(r.body.sale.status).toBe('PAID')
    expect(r.body.sale.paidById).toBe(fx.users.cashier.id)
    expect(r.body.sale.paidAt).toBeTruthy()
    expect(r.body.sale.dueCents).toBe(0)
    expect(r.body.sale.payments[0]).toMatchObject({ method: 'CASH', amountCents: 536000, tenderedCents: 600000, changeCents: 64000, verification: 'CASH' })
    const pay = await prisma.payment.findFirstOrThrow()
    expect(pay.shiftId).toBe(shift.id)
    expect(await stockOf(fx.branches.west.id, fx.products.whisky.id)).toBe(49)
    expect(await stockOf(fx.branches.west.id, fx.products.beer.id)).toBe(48)
    expect(await stockOf(fx.branches.kili.id, fx.products.beer.id)).toBe(50)
    expect(await prisma.stockMovement.count({ where: { saleId: s.id } })).toBe(2)
    expect(await prisma.auditLog.count({ where: { action: 'sale.pay' } })).toBe(1)

    const again = await cashier.post(`/api/sales/${s.id}/pay`, { payments: [{ method: 'CASH', amountCents: 100 }] })
    expect(again.status).toBe(422)
    expect(again.body.error.code).toBe('sale_not_payable')
    expect(await prisma.stockMovement.count({ where: { saleId: s.id } })).toBe(2)
  })

  it('split payment cash plus M-Pesa', async () => {
    await openShiftFor(fx.users.cashier.id, fx.branches.west.id)
    const s = await newSale()
    const r = await cashier.post(`/api/sales/${s.id}/pay`, {
      payments: [
        { method: 'CASH', amountCents: 136000, tenderedCents: 140000 },
        { method: 'MPESA', amountCents: 400000, mpesaRef: 'rkt4abc123', phone: '0712 345 678' }
      ]
    })
    expect(r.status).toBe(200)
    expect(r.body.changeCents).toBe(4000)
    expect(r.body.sale.status).toBe('PAID')
    expect(r.body.sale.paidCents).toBe(536000)
    const m = r.body.sale.payments.find((p: any) => p.method === 'MPESA')
    expect(m).toMatchObject({ mpesaRef: 'RKT4ABC123', phone: '254712345678', verification: 'MANUAL_UNVERIFIED', changeCents: null })
    expect(await prisma.stockMovement.count({ where: { saleId: s.id } })).toBe(2)
  })

  it('partial payments stay SAVED until covered, M-Pesa without a shift is fine', async () => {
    const s = await newSale()
    const r = await cashier.post(`/api/sales/${s.id}/pay`, { payments: [{ method: 'MPESA', amountCents: 36000, mpesaRef: 'AAA1111111' }] })
    expect(r.status).toBe(200)
    expect(r.body.sale.status).toBe('SAVED')
    expect(r.body.sale.dueCents).toBe(500000)
    expect(r.body.changeCents).toBe(0)
    expect((await prisma.payment.findFirstOrThrow()).shiftId).toBeNull()
    expect(await prisma.stockMovement.count()).toBe(0)

    // a colleague finishes it on another till
    const c2 = await Client.login('cashier2')
    const shift2 = await openShiftFor(fx.users.cashier2.id, fx.branches.west.id)
    const done = await c2.post(`/api/sales/${s.id}/pay`, { payments: [{ method: 'CASH', amountCents: 500000, tenderedCents: 500000 }] })
    expect(done.body.sale.status).toBe('PAID')
    expect(done.body.sale.paidById).toBe(fx.users.cashier2.id)
    expect(done.body.changeCents).toBe(0)
    expect((await prisma.payment.findFirstOrThrow({ where: { method: 'CASH' } })).shiftId).toBe(shift2.id)
    expect(await stockOf(fx.branches.west.id, fx.products.beer.id)).toBe(48)
  })

  it('M-Pesa uses the open shift if there is one', async () => {
    const shift = await openShiftFor(fx.users.cashier.id, fx.branches.west.id)
    const s = await newSale()
    await cashier.post(`/api/sales/${s.id}/pay`, { payments: [{ method: 'MPESA', amountCents: s.totalCents, mpesaRef: 'BBB2222222' }] })
    expect((await prisma.payment.findFirstOrThrow()).shiftId).toBe(shift.id)
  })

  it('refuses overpayment and rolls back everything', async () => {
    await openShiftFor(fx.users.cashier.id, fx.branches.west.id)
    const s = await newSale()
    const r = await cashier.post(`/api/sales/${s.id}/pay`, {
      payments: [
        { method: 'MPESA', amountCents: 500000, mpesaRef: 'CCC3333333' },
        { method: 'CASH', amountCents: 50000 }
      ]
    })
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('overpayment')
    expect(await prisma.payment.count()).toBe(0)
    const single = await cashier.post(`/api/sales/${s.id}/pay`, { payments: [{ method: 'CASH', amountCents: 536001 }] })
    expect(single.body.error.code).toBe('overpayment')
  })

  it('short cash is refused', async () => {
    await openShiftFor(fx.users.cashier.id, fx.branches.west.id)
    const s = await newSale()
    const r = await cashier.post(`/api/sales/${s.id}/pay`, { payments: [{ method: 'CASH', amountCents: 536000, tenderedCents: 500000 }] })
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('short_cash')
  })

  it('M-Pesa codes: same code twice in a request, or already used anywhere', async () => {
    const s = await newSale()
    const twice = await cashier.post(`/api/sales/${s.id}/pay`, {
      payments: [
        { method: 'MPESA', amountCents: 100, mpesaRef: 'DDD4444444' },
        { method: 'MPESA', amountCents: 100, mpesaRef: 'ddd4444444' }
      ]
    })
    expect(twice.status).toBe(422)
    expect(twice.body.error.code).toBe('mpesa_code_repeated')

    expect((await cashier.post(`/api/sales/${s.id}/pay`, { payments: [{ method: 'MPESA', amountCents: 100, mpesaRef: 'DDD4444444' }] })).status).toBe(200)
    const s2 = await newSale()
    const used = await cashier.post(`/api/sales/${s2.id}/pay`, { payments: [{ method: 'MPESA', amountCents: 100, mpesaRef: 'DDD4444444' }] })
    expect(used.status).toBe(409)
    expect(used.body.error.code).toBe('mpesa_code_used')
    // a Kilimani sale cannot reuse it either
    const k = await Client.login('kilicashier')
    const ks = await newSale(k)
    expect((await k.post(`/api/sales/${ks.id}/pay`, { payments: [{ method: 'MPESA', amountCents: 100, mpesaRef: 'DDD4444444' }] })).body.error.code).toBe('mpesa_code_used')
  })

  it('the same code raced on two sales: exactly one wins', async () => {
    const a = await newSale()
    const b = await newSale()
    const c2 = await Client.login('cashier2')
    const rs = await Promise.all([
      cashier.post(`/api/sales/${a.id}/pay`, { payments: [{ method: 'MPESA', amountCents: 100, mpesaRef: 'EEE5555555' }] }),
      c2.post(`/api/sales/${b.id}/pay`, { payments: [{ method: 'MPESA', amountCents: 100, mpesaRef: 'EEE5555555' }] })
    ])
    expect(rs.map(r => r.status).sort()).toEqual([200, 409])
    expect(rs.find(r => r.status === 409)!.body.error.code).toBe('mpesa_code_used')
    expect(await prisma.payment.count()).toBe(1)
  })

  it('two concurrent full payments: exactly one wins, stock moves once', async () => {
    await openShiftFor(fx.users.cashier.id, fx.branches.west.id)
    await openShiftFor(fx.users.cashier2.id, fx.branches.west.id)
    const c2 = await Client.login('cashier2')
    const s = await newSale()
    const rs = await Promise.all([
      cashier.post(`/api/sales/${s.id}/pay`, { payments: [{ method: 'CASH', amountCents: s.totalCents }] }),
      c2.post(`/api/sales/${s.id}/pay`, { payments: [{ method: 'MPESA', amountCents: s.totalCents, mpesaRef: 'FFF6666666' }] })
    ])
    expect(rs.map(r => r.status).sort()).toEqual([200, 422])
    expect(['sale_not_payable', 'overpayment']).toContain(rs.find(r => r.status === 422)!.body.error.code)
    expect(await prisma.payment.count()).toBe(1)
    expect(await prisma.stockMovement.count({ where: { saleId: s.id } })).toBe(2)
    expect(await stockOf(fx.branches.west.id, fx.products.whisky.id)).toBe(49)
  })

  it('validates the body', async () => {
    const s = await newSale()
    const bad = [
      {},
      { payments: [] },
      { payments: Array.from({ length: 5 }, () => ({ method: 'CASH', amountCents: 1 })) },
      { payments: [{ method: 'CARD', amountCents: 100 }] },
      { payments: [{ method: 'CASH', amountCents: 0 }] },
      { payments: [{ method: 'CASH', amountCents: 10.5 }] },
      { payments: [{ method: 'CASH', amountCents: -5 }] },
      { payments: [{ method: 'MPESA', amountCents: 100, mpesaRef: 'SHORT' }] },
      { payments: [{ method: 'MPESA', amountCents: 100, mpesaRef: 'ABC123456!' }] },
      { payments: [{ method: 'MPESA', amountCents: 100, mpesaRef: 'ABC1234567', phone: '12345' }] }
    ]
    for (const b of bad) {
      const r = await cashier.post(`/api/sales/${s.id}/pay`, b)
      expect(r.status, JSON.stringify(b)).toBe(400)
    }
    // no code at all: the shop requires one by default
    const none = await cashier.post(`/api/sales/${s.id}/pay`, { payments: [{ method: 'MPESA', amountCents: 100 }] })
    expect(none.status).toBe(422)
    expect(none.body.error.code).toBe('mpesa_code_required')
  })

  it('cannot pay another branch sale, owner can by id, cancelled cannot be paid', async () => {
    const k = await Client.login('kilicashier')
    const ks = await newSale(k)
    const r = await cashier.post(`/api/sales/${ks.id}/pay`, { payments: [{ method: 'MPESA', amountCents: 100, mpesaRef: 'GGG7777777' }] })
    expect(r.status).toBe(404)
    const owner = await Client.login('owner')
    const o = await owner.post(`/api/sales/${ks.id}/pay`, { payments: [{ method: 'MPESA', amountCents: ks.totalCents, mpesaRef: 'GGG7777777' }] })
    expect(o.status).toBe(200)
    expect(o.body.sale.status).toBe('PAID')
    expect(await stockOf(fx.branches.kili.id, fx.products.whisky.id)).toBe(49)
    expect(await stockOf(fx.branches.west.id, fx.products.whisky.id)).toBe(50)

    const s = await newSale()
    await prisma.sale.update({ where: { id: s.id }, data: { status: 'CANCELLED' } })
    const c = await cashier.post(`/api/sales/${s.id}/pay`, { payments: [{ method: 'MPESA', amountCents: 100, mpesaRef: 'HHH8888888' }] })
    expect(c.status).toBe(422)
    expect(c.body.error.code).toBe('sale_not_payable')
  })
})

describe('receipt', () => {
  it('has everything a printed receipt needs', async () => {
    await openShiftFor(fx.users.cashier2.id, fx.branches.west.id)
    const s = await newSale(cashier, undefined, { label: 'Table 2' })
    const c2 = await Client.login('cashier2')
    await c2.post(`/api/sales/${s.id}/pay`, {
      payments: [
        { method: 'CASH', amountCents: 36000, tenderedCents: 50000 },
        { method: 'MPESA', amountCents: 500000, mpesaRef: 'JJJ9999999' }
      ]
    })
    const r = await cashier.get(`/api/sales/${s.id}/receipt`)
    expect(r.status).toBe(200)
    const rc = r.body.receipt
    expect(rc).toMatchObject({
      businessName: 'Test Wines',
      branchName: 'Westlands',
      number: s.number,
      label: 'Table 2',
      status: 'PAID',
      createdBy: { id: fx.users.cashier.id, name: 'cashier' },
      paidBy: { id: fx.users.cashier2.id, name: 'cashier2' },
      subtotalCents: 536000,
      discountCents: 0,
      totalCents: 536000,
      paidCents: 536000,
      changeCents: 14000
    })
    expect(rc.paidAt).toBeTruthy()
    expect(rc.lines).toHaveLength(2)
    expect(rc.payments.map((p: any) => p.method)).toEqual(['CASH', 'MPESA'])
    expect(rc.payments[1].mpesaRef).toBe('JJJ9999999')
    expect(rc.payments[0].changeCents).toBe(14000)
    // the shop's own details and the VAT held in the total (16% by default)
    expect(rc.business).toEqual({
      name: 'Test Wines',
      legalName: null,
      address: null,
      phone: null,
      email: null,
      kraPin: null,
      receiptFooter: null,
      vatRateBps: 1600,
      logoUrl: null
    })
    expect(rc.vatCents).toBe(73931)
  })

  it('only for paid or refunded sales, and only in your branch', async () => {
    const s = await newSale()
    const r = await cashier.get(`/api/sales/${s.id}/receipt`)
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('sale_not_paid')
    await cashier.post(`/api/sales/${s.id}/pay`, { payments: [{ method: 'MPESA', amountCents: s.totalCents, mpesaRef: 'KKK1010101' }] })
    const k = await Client.login('kilicashier')
    expect((await k.get(`/api/sales/${s.id}/receipt`)).status).toBe(404)
    await prisma.sale.update({ where: { id: s.id }, data: { status: 'REFUNDED', refundedAt: new Date() } })
    expect((await cashier.get(`/api/sales/${s.id}/receipt`)).status).toBe(200)
  })
})
