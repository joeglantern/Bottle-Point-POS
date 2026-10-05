import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Client, resetDb, seedFixture, type Fixture } from './helpers.js'
import { connectSocket, nextEvent, noEvent, startServer } from './realtime-helpers.js'
import { prisma } from '../src/db.js'

let fx: Fixture

beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
})

const qtyOf = async (branchId: string, productId: string) =>
  (await prisma.stock.findUniqueOrThrow({ where: { branchId_productId: { branchId, productId } } })).qty

describe('stock list', () => {
  it('lists branch stock with low flags', async () => {
    await prisma.stock.update({
      where: { branchId_productId: { branchId: fx.branches.west.id, productId: fx.products.gin.id } },
      data: { qty: 4 }
    })
    await prisma.stock.update({
      where: { branchId_productId: { branchId: fx.branches.west.id, productId: fx.products.beer.id } },
      data: { qty: 10 }
    })
    const c = await Client.login('cashier')
    const all = await c.get('/api/stock')
    expect(all.status).toBe(200)
    expect(all.body.stock).toHaveLength(3)
    const low = await c.get('/api/stock?low=true')
    // qty equal to reorderAt counts as low
    expect(low.body.stock.map((s: any) => s.name)).toEqual(['Gilbeys Gin', 'Tusker Lager'])
    expect(low.body.stock[0]).toMatchObject({ qty: 4, reorderAt: 10, low: true })
  })

  it('owner must pick a branch, and only sees that branch', async () => {
    const o = await Client.login('owner')
    expect((await o.get('/api/stock')).status).toBe(403)
    o.branchId = fx.branches.kili.id
    const r = await o.get('/api/stock')
    expect(r.body.branchId).toBe(fx.branches.kili.id)
  })

  it('Westlands staff cannot read Kilimani stock', async () => {
    const c = await Client.login('cashier', undefined, fx.branches.kili.id)
    expect((await c.get('/api/stock')).status).toBe(403)
  })
})

describe('receive', () => {
  it('adds stock and records a movement per item in one go', async () => {
    const m = await Client.login('manager')
    const r = await m.post('/api/stock/receive', {
      items: [
        { productId: fx.products.beer.id, qty: 24, note: 'Delivery from EABL' },
        { productId: fx.products.gin.id, qty: 6 }
      ]
    })
    expect(r.status).toBe(200)
    expect(r.body.stock.find((s: any) => s.productId === fx.products.beer.id).qty).toBe(74)
    expect(await qtyOf(fx.branches.west.id, fx.products.gin.id)).toBe(56)
    expect(await qtyOf(fx.branches.kili.id, fx.products.beer.id)).toBe(50)
    const mv = await prisma.stockMovement.findMany({ where: { reason: 'RECEIVE' }, orderBy: { delta: 'desc' } })
    expect(mv.map(x => x.delta)).toEqual([24, 6])
    expect(mv[0]).toMatchObject({ note: 'Delivery from EABL', userId: fx.users.manager.id, branchId: fx.branches.west.id })
    expect(await prisma.auditLog.count({ where: { action: 'stock.received' } })).toBe(1)
  })

  it('creates the stock row if it was missing', async () => {
    await prisma.stock.delete({ where: { branchId_productId: { branchId: fx.branches.west.id, productId: fx.products.gin.id } } })
    const m = await Client.login('manager')
    await m.post('/api/stock/receive', { items: [{ productId: fx.products.gin.id, qty: 5 }] })
    expect(await qtyOf(fx.branches.west.id, fx.products.gin.id)).toBe(5)
  })

  it('is all or nothing when a product is unknown', async () => {
    const m = await Client.login('manager')
    const r = await m.post('/api/stock/receive', { items: [{ productId: fx.products.beer.id, qty: 5 }, { productId: 'nope', qty: 1 }] })
    expect(r.status).toBe(404)
    expect(await qtyOf(fx.branches.west.id, fx.products.beer.id)).toBe(50)
  })

  it('validates quantities', async () => {
    const m = await Client.login('manager')
    for (const items of [[], [{ productId: fx.products.beer.id, qty: 0 }], [{ productId: fx.products.beer.id, qty: 100001 }], [{ productId: fx.products.beer.id, qty: 1.5 }]]) {
      expect((await m.post('/api/stock/receive', { items })).status).toBe(400)
    }
  })

  it('cashier gets 403', async () => {
    const c = await Client.login('cashier')
    expect((await c.post('/api/stock/receive', { items: [{ productId: fx.products.beer.id, qty: 5 }] })).status).toBe(403)
  })
})

describe('adjust', () => {
  it('sets the counted quantity and records the difference', async () => {
    const m = await Client.login('manager')
    const r = await m.post('/api/stock/adjust', { productId: fx.products.whisky.id, countedQty: 47, reason: 'Stock take, 3 broken' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ previousQty: 50, delta: -3, stock: { qty: 47 } })
    const mv = await prisma.stockMovement.findFirstOrThrow({ where: { reason: 'ADJUST' } })
    expect(mv).toMatchObject({ delta: -3, note: 'Stock take, 3 broken' })
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'stock.adjusted' } })).data).toMatchObject({ from: 50, to: 47, delta: -3 })
  })

  it('no movement when the count matches', async () => {
    const m = await Client.login('manager')
    const r = await m.post('/api/stock/adjust', { productId: fx.products.whisky.id, countedQty: 50, reason: 'Count ok' })
    expect(r.body.movement).toBeNull()
    expect(await prisma.stockMovement.count()).toBe(0)
  })

  it('validates input', async () => {
    const m = await Client.login('manager')
    const base = { productId: fx.products.whisky.id, countedQty: 10, reason: 'Count' }
    for (const b of [{ ...base, reason: 'ab' }, { ...base, reason: 'x'.repeat(201) }, { ...base, countedQty: -1 }, { ...base, countedQty: 1.2 }, { productId: base.productId }]) {
      expect((await m.post('/api/stock/adjust', b)).status).toBe(400)
    }
    expect((await m.post('/api/stock/adjust', { ...base, productId: 'missing' })).status).toBe(404)
  })

  it('cashier gets 403', async () => {
    const c = await Client.login('cashier')
    expect((await c.post('/api/stock/adjust', { productId: fx.products.whisky.id, countedQty: 1, reason: 'Count' })).status).toBe(403)
  })

  it('Westlands manager cannot adjust Kilimani stock', async () => {
    const m = await Client.login('manager', undefined, fx.branches.kili.id)
    const r = await m.post('/api/stock/adjust', { productId: fx.products.whisky.id, countedQty: 1, reason: 'Count' })
    expect(r.status).toBe(403)
    expect(await qtyOf(fx.branches.kili.id, fx.products.whisky.id)).toBe(50)
    expect((await m.post('/api/stock/receive', { items: [{ productId: fx.products.whisky.id, qty: 1 }] })).status).toBe(403)
    expect((await m.patch(`/api/stock/${fx.products.whisky.id}`, { reorderAt: 1 })).status).toBe(403)
  })

  it('concurrent adjust and receives end consistent with the movements', async () => {
    const m = await Client.login('manager')
    const o = await Client.login('owner', undefined, fx.branches.west.id)
    const res = await Promise.all([
      m.post('/api/stock/receive', { items: [{ productId: fx.products.beer.id, qty: 12 }] }),
      o.post('/api/stock/adjust', { productId: fx.products.beer.id, countedQty: 30, reason: 'Stock take' }),
      m.post('/api/stock/receive', { items: [{ productId: fx.products.beer.id, qty: 5 }] })
    ])
    expect(res.map(r => r.status)).toEqual([200, 200, 200])
    const qty = await qtyOf(fx.branches.west.id, fx.products.beer.id)
    const deltas = await prisma.stockMovement.aggregate({ where: { productId: fx.products.beer.id, branchId: fx.branches.west.id }, _sum: { delta: true } })
    // nothing lost: start + every recorded movement equals what is on the shelf
    expect(50 + (deltas._sum.delta ?? 0)).toBe(qty)
    expect([30, 35, 42, 47]).toContain(qty)
  })

  it('a sale paid during a stock take is not lost', async () => {
    const m = await Client.login('manager')
    const runs = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        i % 2
          ? m.post('/api/stock/adjust', { productId: fx.products.gin.id, countedQty: 20 + i, reason: 'Stock take' })
          : prisma.$transaction(async tx => {
              // what applyPayment does to stock
              await tx.stock.update({
                where: { branchId_productId: { branchId: fx.branches.west.id, productId: fx.products.gin.id } },
                data: { qty: { decrement: 2 } }
              })
              await tx.stockMovement.create({
                data: { branchId: fx.branches.west.id, productId: fx.products.gin.id, delta: -2, reason: 'SALE', userId: fx.users.cashier.id }
              })
            })
      )
    )
    expect(runs).toHaveLength(4)
    const qty = await qtyOf(fx.branches.west.id, fx.products.gin.id)
    const sum = await prisma.stockMovement.aggregate({ where: { productId: fx.products.gin.id }, _sum: { delta: true } })
    expect(50 + (sum._sum.delta ?? 0)).toBe(qty)
  })
})

describe('reorder level and movements', () => {
  it('manager sets the reorder level, which drives the low filter', async () => {
    const m = await Client.login('manager')
    const r = await m.patch(`/api/stock/${fx.products.whisky.id}`, { reorderAt: 60 })
    expect(r.status).toBe(200)
    expect(r.body.stock).toMatchObject({ reorderAt: 60, low: true })
    expect((await m.get('/api/stock?low=true')).body.stock.map((s: any) => s.productId)).toEqual([fx.products.whisky.id])
    expect((await m.patch(`/api/stock/${fx.products.whisky.id}`, { reorderAt: -1 })).status).toBe(400)
    const c = await Client.login('cashier')
    expect((await c.patch(`/api/stock/${fx.products.whisky.id}`, { reorderAt: 5 })).status).toBe(403)
  })

  it('lists movements newest first, for managers only and only their branch', async () => {
    const m = await Client.login('manager')
    await m.post('/api/stock/receive', { items: [{ productId: fx.products.beer.id, qty: 10 }] })
    await m.post('/api/stock/adjust', { productId: fx.products.beer.id, countedQty: 55, reason: 'Recount' })
    await m.post('/api/stock/receive', { items: [{ productId: fx.products.gin.id, qty: 1 }] })
    const km = await Client.login('kilimanager')
    await km.post('/api/stock/receive', { items: [{ productId: fx.products.beer.id, qty: 3 }] })

    const r = await m.get(`/api/stock/movements?productId=${fx.products.beer.id}`)
    expect(r.status).toBe(200)
    expect(r.body.movements.map((x: any) => [x.reason, x.delta])).toEqual([
      ['ADJUST', -5],
      ['RECEIVE', 10]
    ])
    expect(r.body.movements[0]).toMatchObject({ productName: 'Tusker Lager', userName: 'manager' })
    expect((await m.get('/api/stock/movements?limit=1')).body.movements).toHaveLength(1)
    expect((await m.get('/api/stock/movements?limit=0')).status).toBe(400)
    const c = await Client.login('cashier')
    expect((await c.get('/api/stock/movements')).status).toBe(403)
  })
})

describe('stock realtime', () => {
  let srv: Awaited<ReturnType<typeof startServer>>
  beforeAll(async () => {
    srv = await startServer()
  })
  afterAll(async () => {
    await srv.stop()
  })

  it('stock:updated goes to the branch room only', async () => {
    const west = await connectSocket(srv.url, (await Client.login('cashier')).cookie)
    const kili = await connectSocket(srv.url, (await Client.login('kilicashier')).cookie)
    const got = nextEvent(west, 'stock:updated')
    const quiet = noEvent(kili, 'stock:updated')
    const m = await Client.login('manager')
    await m.post('/api/stock/receive', { items: [{ productId: fx.products.beer.id, qty: 7 }] })
    expect(await got).toMatchObject({ branchId: fx.branches.west.id, productId: fx.products.beer.id, qty: 57 })
    await quiet
    west.close()
    kili.close()
  })
})
