import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Client, resetDb, seedFixture, type Fixture } from './helpers.js'
import { connectSocket, nextEvent, noEvent, startServer } from './realtime-helpers.js'
import { prisma } from '../src/db.js'
import { createStaff } from '../src/lib/users.js'

let fx: Fixture

beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
})

const newProduct = { name: 'Hennessy VS', category: 'Cognac', sizeMl: 700, barcode: '3245990001218', priceCents: 690000 }

describe('product list and lookup', () => {
  it('lists active products sorted by name with branch stock', async () => {
    const c = await Client.login('cashier')
    const r = await c.get('/api/products')
    expect(r.status).toBe(200)
    expect(r.body.branchId).toBe(fx.branches.west.id)
    expect(r.body.products.map((p: any) => p.name)).toEqual(['Gilbeys Gin', 'Johnnie Walker Black', 'Tusker Lager'])
    expect(r.body.products[0]).toMatchObject({ qty: 50, reorderAt: 10, priceCents: 145000 })
  })

  it('filters by search and category', async () => {
    const c = await Client.login('cashier')
    expect((await c.get('/api/products?q=tusk')).body.products.map((p: any) => p.name)).toEqual(['Tusker Lager'])
    expect((await c.get('/api/products?q=500026')).body.products.map((p: any) => p.name)).toEqual(['Johnnie Walker Black'])
    expect((await c.get('/api/products?category=beer')).body.products).toHaveLength(1)
  })

  it('returns null stock when the product has no stock row in the branch', async () => {
    await prisma.stock.delete({ where: { branchId_productId: { branchId: fx.branches.west.id, productId: fx.products.gin.id } } })
    const c = await Client.login('cashier')
    const gin = (await c.get('/api/products')).body.products.find((p: any) => p.id === fx.products.gin.id)
    expect(gin.qty).toBeNull()
    expect(gin.reorderAt).toBeNull()
  })

  it('owner without a picked branch gets no stock figures, with a branch gets them', async () => {
    const o = await Client.login('owner')
    const r = await o.get('/api/products')
    expect(r.body.branchId).toBeNull()
    expect(r.body.products[0].qty).toBeNull()
    const k = await o.get(`/api/products?branchId=${fx.branches.kili.id}`)
    expect(k.body.products[0].qty).toBe(50)
  })

  it('hides inactive products unless a manager asks for them', async () => {
    await prisma.product.update({ where: { id: fx.products.gin.id }, data: { active: false } })
    const c = await Client.login('cashier')
    expect((await c.get('/api/products?includeInactive=true')).body.products).toHaveLength(2)
    const m = await Client.login('manager')
    expect((await m.get('/api/products?includeInactive=true')).body.products).toHaveLength(3)
  })

  it('lists distinct categories', async () => {
    const c = await Client.login('cashier')
    expect((await c.get('/api/products/categories')).body.categories).toEqual(['Beer', 'Gin', 'Whisky'])
  })

  it('finds a product by exact barcode', async () => {
    const c = await Client.login('cashier')
    const r = await c.get('/api/products/barcode/6161100010017')
    expect(r.status).toBe(200)
    expect(r.body.product).toMatchObject({ name: 'Tusker Lager', qty: 50 })
  })

  it('unknown or inactive barcode is a clear 404', async () => {
    const c = await Client.login('cashier')
    const r = await c.get('/api/products/barcode/1111111111')
    expect(r.status).toBe(404)
    expect(r.body.error.message).toContain('No product has barcode 1111111111')
    expect((await c.get('/api/products/barcode/616110001')).status).toBe(404)
    await prisma.product.update({ where: { id: fx.products.beer.id }, data: { active: false } })
    expect((await c.get('/api/products/barcode/6161100010017')).status).toBe(404)
  })

  it('does not show another business products', async () => {
    const other = await prisma.business.create({ data: { name: 'Other' } })
    const p = await prisma.product.create({ data: { businessId: other.id, name: 'Secret', category: 'Gin', barcode: '1234567890', priceCents: 100 } })
    const c = await Client.login('cashier')
    expect((await c.get('/api/products?q=Secret')).body.products).toHaveLength(0)
    expect((await c.get('/api/products/barcode/1234567890')).status).toBe(404)
    expect((await c.get(`/api/products/${p.id}`)).status).toBe(404)
  })

  it('branch query must be one of mine', async () => {
    const c = await Client.login('cashier')
    expect((await c.get(`/api/products?branchId=${fx.branches.kili.id}`)).status).toBe(403)
  })
})

describe('product changes', () => {
  it('manager creates a product and every branch gets a stock row', async () => {
    const m = await Client.login('manager')
    const r = await m.post('/api/products', newProduct)
    expect(r.status).toBe(201)
    expect(r.body.product).toMatchObject({ name: 'Hennessy VS', priceCents: 690000, active: true })
    const rows = await prisma.stock.findMany({ where: { productId: r.body.product.id } })
    expect(rows).toHaveLength(2)
    expect(rows.every(s => s.qty === 0)).toBe(true)
    const log = await prisma.auditLog.findFirst({ where: { action: 'product.created', entityId: r.body.product.id } })
    expect(log).not.toBeNull()
  })

  it('cashier cannot create, change or delete products', async () => {
    const c = await Client.login('cashier')
    expect((await c.post('/api/products', newProduct)).status).toBe(403)
    expect((await c.patch(`/api/products/${fx.products.beer.id}`, { priceCents: 1 })).status).toBe(403)
    expect((await c.del(`/api/products/${fx.products.beer.id}`)).status).toBe(403)
  })

  it('validates input', async () => {
    const m = await Client.login('manager')
    const bad = [
      { ...newProduct, name: '' },
      { ...newProduct, category: ' ' },
      { ...newProduct, priceCents: 10.5 },
      { ...newProduct, priceCents: -1 },
      { ...newProduct, priceCents: 0 },
      { ...newProduct, barcode: '12345' },
      { ...newProduct, barcode: '123456789012345' },
      { ...newProduct, barcode: '12345abc' },
      { ...newProduct, sizeMl: 0 },
      { name: 'x' }
    ]
    for (const b of bad) {
      const r = await m.post('/api/products', b)
      expect(r.status, JSON.stringify(b)).toBe(400)
    }
    expect((await m.patch(`/api/products/${fx.products.beer.id}`, {})).status).toBe(400)
  })

  it('a product without a barcode is fine, and many of them can exist', async () => {
    const m = await Client.login('manager')
    expect((await m.post('/api/products', { name: 'House wine glass', category: 'Wine', priceCents: 50000 })).status).toBe(201)
    expect((await m.post('/api/products', { name: 'House red glass', category: 'Wine', priceCents: 50000, barcode: null })).status).toBe(201)
  })

  it('duplicate barcode is 409 on create and on change', async () => {
    const m = await Client.login('manager')
    const r = await m.post('/api/products', { ...newProduct, barcode: '6161100010017' })
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('duplicate_barcode')
    const p = await m.patch(`/api/products/${fx.products.gin.id}`, { barcode: '6161100010017' })
    expect(p.status).toBe(409)
    expect(p.body.error.code).toBe('duplicate_barcode')
    // its own barcode is not a clash
    expect((await m.patch(`/api/products/${fx.products.gin.id}`, { barcode: '6161101560203' })).status).toBe(200)
  })

  it('the same barcode may exist in another business', async () => {
    const other = await prisma.business.create({ data: { name: 'Other' } })
    await prisma.product.create({ data: { businessId: other.id, name: 'X', category: 'Gin', barcode: '3245990001218', priceCents: 100 } })
    const m = await Client.login('manager')
    expect((await m.post('/api/products', newProduct)).status).toBe(201)
  })

  it('two managers racing to add the same barcode: exactly one wins', async () => {
    const m = await Client.login('manager')
    const o = await Client.login('owner')
    const res = await Promise.all([m.post('/api/products', newProduct), o.post('/api/products', newProduct)])
    expect(res.map(r => r.status).sort()).toEqual([201, 409])
  })

  it('price change is audited with old and new price and old sale lines keep their price', async () => {
    const sale = await prisma.sale.create({
      data: {
        number: 1,
        branchId: fx.branches.west.id,
        createdById: fx.users.cashier.id,
        status: 'SAVED',
        subtotalCents: 28000,
        totalCents: 28000,
        lines: { create: { productId: fx.products.beer.id, name: 'Tusker Lager', unitCents: 28000, qty: 1 } }
      }
    })
    const m = await Client.login('manager')
    const r = await m.patch(`/api/products/${fx.products.beer.id}`, { priceCents: 30000, name: 'Tusker Lager 500ml' })
    expect(r.status).toBe(200)
    expect(r.body.product).toMatchObject({ priceCents: 30000, name: 'Tusker Lager 500ml' })
    const log = await prisma.auditLog.findFirst({ where: { action: 'product.price_changed', entityId: fx.products.beer.id } })
    expect(log?.data).toMatchObject({ oldPriceCents: 28000, newPriceCents: 30000 })
    const line = await prisma.saleLine.findFirstOrThrow({ where: { saleId: sale.id } })
    expect(line).toMatchObject({ unitCents: 28000, name: 'Tusker Lager' })
  })

  it('no price audit when the price did not change', async () => {
    const m = await Client.login('manager')
    await m.patch(`/api/products/${fx.products.beer.id}`, { priceCents: 28000 })
    expect(await prisma.auditLog.count({ where: { action: 'product.price_changed' } })).toBe(0)
  })

  it('delete is a soft delete and the product can come back', async () => {
    const m = await Client.login('manager')
    const r = await m.del(`/api/products/${fx.products.beer.id}`)
    expect(r.status).toBe(200)
    expect(r.body.product.active).toBe(false)
    expect(await prisma.product.count({ where: { id: fx.products.beer.id } })).toBe(1)
    expect((await m.get('/api/products')).body.products).toHaveLength(2)
    const back = await m.patch(`/api/products/${fx.products.beer.id}`, { active: true })
    expect(back.body.product.active).toBe(true)
  })

  it('cannot change a product of another business', async () => {
    const other = await prisma.business.create({ data: { name: 'Other' } })
    const p = await prisma.product.create({ data: { businessId: other.id, name: 'X', category: 'Gin', priceCents: 100 } })
    const m = await Client.login('manager')
    expect((await m.patch(`/api/products/${p.id}`, { priceCents: 1 })).status).toBe(404)
    expect((await m.del(`/api/products/${p.id}`)).status).toBe(404)
  })
})

describe('product realtime', () => {
  let srv: Awaited<ReturnType<typeof startServer>>
  beforeAll(async () => {
    srv = await startServer()
  })
  afterAll(async () => {
    await srv.stop()
  })

  it('product:updated reaches the whole business and not another business', async () => {
    const other = await prisma.business.create({ data: { name: 'Other' } })
    const ob = await prisma.branch.create({ data: { businessId: other.id, name: 'Elsewhere' } })
    await createStaff(prisma, { businessId: other.id, name: 'x', username: 'outsider', pin: '1234', role: 'CASHIER', branchIds: [ob.id] })

    const west = await connectSocket(srv.url, (await Client.login('cashier')).cookie)
    const kili = await connectSocket(srv.url, (await Client.login('kilicashier')).cookie)
    const outsider = await connectSocket(srv.url, (await Client.login('outsider')).cookie)

    const a = nextEvent(west, 'product:updated')
    const b = nextEvent(kili, 'product:updated')
    const quiet = noEvent(outsider, 'product:updated')
    const m = await Client.login('manager')
    await m.patch(`/api/products/${fx.products.beer.id}`, { priceCents: 30000 })
    expect((await a).product).toMatchObject({ id: fx.products.beer.id, priceCents: 30000 })
    expect((await b).product.priceCents).toBe(30000)
    await quiet
    for (const s of [west, kili, outsider]) s.close()
  })
})
