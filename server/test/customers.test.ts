import { beforeEach, describe, expect, it } from 'vitest'
import { Client, resetDb, seedFixture, type Fixture } from './helpers.js'
import { prisma } from '../src/db.js'

let fx: Fixture

beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
})

describe('customers', () => {
  it('cashier adds a customer and the phone is normalised', async () => {
    const c = await Client.login('cashier')
    const r = await c.post('/api/customers', { name: 'James Kamau', phone: '0712 345 481' })
    expect(r.status).toBe(201)
    expect(r.body.customer).toMatchObject({ name: 'James Kamau', phone: '254712345481' })
    for (const p of ['+254712345481', '254-712-345-481', '0712345481']) {
      const d = await c.post('/api/customers', { name: 'Other', phone: p })
      expect(d.status).toBe(409)
      expect(d.body.error.code).toBe('duplicate_phone')
    }
    expect(await prisma.auditLog.count({ where: { action: 'customer.created' } })).toBe(1)
  })

  it('phone is optional and validated', async () => {
    const c = await Client.login('cashier')
    expect((await c.post('/api/customers', { name: 'Table 4 regulars' })).status).toBe(201)
    expect((await c.post('/api/customers', { name: 'Table 5', phone: null })).status).toBe(201)
    expect((await c.post('/api/customers', { name: 'Bad', phone: '0812345678' })).status).toBe(400)
    expect((await c.post('/api/customers', { name: '', phone: '0712345678' })).status).toBe(400)
  })

  it('searches by name and by phone in any format', async () => {
    const c = await Client.login('cashier')
    await c.post('/api/customers', { name: 'James Kamau', phone: '0712345481' })
    await c.post('/api/customers', { name: 'Grace Wambui', phone: '0722118106' })
    expect((await c.get('/api/customers?q=kam')).body.customers.map((x: any) => x.name)).toEqual(['James Kamau'])
    expect((await c.get('/api/customers?q=0722')).body.customers.map((x: any) => x.name)).toEqual(['Grace Wambui'])
    expect((await c.get('/api/customers?q=345481')).body.customers.map((x: any) => x.name)).toEqual(['James Kamau'])
    expect((await c.get('/api/customers')).body.customers).toHaveLength(2)
  })

  it('only managers may edit, and phone uniqueness holds', async () => {
    const c = await Client.login('cashier')
    const a = (await c.post('/api/customers', { name: 'A', phone: '0712000001' })).body.customer
    await c.post('/api/customers', { name: 'B', phone: '0712000002' })
    expect((await c.patch(`/api/customers/${a.id}`, { name: 'AA' })).status).toBe(403)
    const m = await Client.login('manager')
    const r = await m.patch(`/api/customers/${a.id}`, { name: 'AA', phone: '0712 000 003' })
    expect(r.status).toBe(200)
    expect(r.body.customer).toMatchObject({ name: 'AA', phone: '254712000003' })
    const d = await m.patch(`/api/customers/${a.id}`, { phone: '0712000002' })
    expect(d.status).toBe(409)
    expect(d.body.error.code).toBe('duplicate_phone')
    expect((await m.patch(`/api/customers/${a.id}`, { phone: null })).body.customer.phone).toBeNull()
  })

  it('shows lifetime spend, visits, last visit and the open tab', async () => {
    const cu = await prisma.customer.create({ data: { businessId: fx.business.id, name: 'Peter', phone: '254733450920' } })
    const mk = (n: number, status: 'PAID' | 'SAVED' | 'CANCELLED', total: number, at: Date, branchId = fx.branches.west.id) =>
      prisma.sale.create({
        data: { number: n, branchId, createdById: fx.users.cashier.id, customerId: cu.id, status, subtotalCents: total, totalCents: total, createdAt: at }
      })
    await mk(1, 'PAID', 480000, new Date('2026-10-01T10:00:00Z'))
    await mk(2, 'PAID', 28000, new Date('2026-10-02T10:00:00Z'), fx.branches.kili.id)
    await mk(3, 'CANCELLED', 99900, new Date('2026-10-03T10:00:00Z'))
    const tab = await mk(4, 'SAVED', 50000, new Date('2026-10-04T10:00:00Z'))
    await prisma.payment.create({ data: { saleId: tab.id, method: 'CASH', amountCents: 20000, verification: 'CASH', receivedById: fx.users.cashier.id } })

    const c = await Client.login('cashier')
    const r = await c.get(`/api/customers/${cu.id}`)
    expect(r.status).toBe(200)
    expect(r.body.customer).toMatchObject({ spentCents: 508000, visitCount: 2, openTabCents: 30000, openSales: 1 })
    expect(new Date(r.body.customer.lastVisitAt).toISOString()).toBe('2026-10-04T10:00:00.000Z')
    const list = await c.get('/api/customers?q=peter')
    expect(list.body.customers[0]).toMatchObject({ spentCents: 508000, openTabCents: 30000 })
  })

  it('customers of another business stay hidden', async () => {
    const other = await prisma.business.create({ data: { name: 'Other' } })
    const cu = await prisma.customer.create({ data: { businessId: other.id, name: 'Hidden', phone: '254712345481' } })
    const c = await Client.login('cashier')
    expect((await c.get(`/api/customers/${cu.id}`)).status).toBe(404)
    expect((await c.get('/api/customers?q=Hidden')).body.customers).toHaveLength(0)
    // phones are unique per business, not globally
    expect((await c.post('/api/customers', { name: 'Mine', phone: '0712345481' })).status).toBe(201)
    const m = await Client.login('manager')
    expect((await m.patch(`/api/customers/${cu.id}`, { name: 'x' })).status).toBe(404)
  })
})
