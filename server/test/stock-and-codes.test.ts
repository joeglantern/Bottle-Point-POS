import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { Client, resetDb, seedFixture, type Fixture } from './helpers.js'

let fx: Fixture

beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
  await prisma.shift.create({ data: { branchId: fx.branches.west.id, userId: fx.users.cashier.id, openingFloatCents: 0 } })
  await prisma.shift.create({ data: { branchId: fx.branches.west.id, userId: fx.users.cashier2.id, openingFloatCents: 0 } })
})

const setStock = (qty: number) =>
  prisma.stock.update({ where: { branchId_productId: { branchId: fx.branches.west.id, productId: fx.products.whisky.id } }, data: { qty } })
const setBusiness = (data: { trackStock?: boolean; requireMpesaCode?: boolean }) => prisma.business.update({ where: { id: fx.business.id }, data })
const whisky = (qty = 1) => ({ lines: [{ productId: fx.products.whisky.id, qty }] })

describe('shops that track stock cannot sell what is not there', () => {
  it('refuses an out of stock product, and more than is left', async () => {
    const c = await Client.login('cashier')
    await setStock(0)
    const none = await c.post('/api/sales', whisky())
    expect(none.status).toBe(422)
    expect(none.body.error).toMatchObject({ code: 'out_of_stock', message: 'Johnnie Walker Black is out of stock.' })
    await setStock(2)
    const many = await c.post('/api/sales', whisky(3))
    expect(many.body.error.message).toBe('Only 2 Johnnie Walker Black left.')
    expect((await c.post('/api/sales', whisky(2))).status).toBe(201)
  })

  it('two tabs for the last bottle: the first to pay gets it', async () => {
    await setStock(1)
    const a = await Client.login('cashier')
    const b = await Client.login('cashier2')
    const tabA = (await a.post('/api/sales', whisky())).body.sale
    const tabB = (await b.post('/api/sales', whisky())).body.sale
    const [pa, pb] = await Promise.all([
      a.post(`/api/sales/${tabA.id}/pay`, { payments: [{ method: 'CASH', amountCents: 480000 }] }),
      b.post(`/api/sales/${tabB.id}/pay`, { payments: [{ method: 'CASH', amountCents: 480000 }] })
    ])
    expect([pa.status, pb.status].sort()).toEqual([200, 422])
    expect([pa, pb].find(r => r.status === 422)!.body.error.code).toBe('out_of_stock')
    const left = await prisma.stock.findUniqueOrThrow({ where: { branchId_productId: { branchId: fx.branches.west.id, productId: fx.products.whisky.id } } })
    expect(left.qty).toBe(0)
    expect(await prisma.payment.count()).toBe(1)
  })

  it('a shop that does not track stock sells freely', async () => {
    await setBusiness({ trackStock: false })
    await setStock(0)
    const c = await Client.login('cashier')
    const sale = (await c.post('/api/sales', whisky(2))).body.sale
    expect((await c.post(`/api/sales/${sale.id}/pay`, { payments: [{ method: 'CASH', amountCents: 960000 }] })).status).toBe(200)
  })
})

describe('M-Pesa without its code', () => {
  it('is refused while the shop requires the code', async () => {
    const c = await Client.login('cashier')
    const sale = (await c.post('/api/sales', whisky())).body.sale
    const r = await c.post(`/api/sales/${sale.id}/pay`, { payments: [{ method: 'MPESA', amountCents: 480000 }] })
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('mpesa_code_required')
  })

  it('is recorded by amount when the shop does not require it, and waits for a manager check', async () => {
    await setBusiness({ requireMpesaCode: false })
    const c = await Client.login('cashier')
    expect((await c.get('/api/session/me')).body.user.requireMpesaCode).toBe(false)
    const sale = (await c.post('/api/sales', whisky())).body.sale
    const r = await c.post(`/api/sales/${sale.id}/pay`, { payments: [{ method: 'MPESA', amountCents: 480000 }] })
    expect(r.status).toBe(200)
    expect(r.body.sale.status).toBe('PAID')
    expect(r.body.sale.payments[0]).toMatchObject({ method: 'MPESA', mpesaRef: null, verification: 'MANUAL_UNVERIFIED' })
    // a code typed anyway is still checked for reuse
    const two = (await c.post('/api/sales', whisky())).body.sale
    await c.post(`/api/sales/${two.id}/pay`, { payments: [{ method: 'MPESA', amountCents: 480000, mpesaRef: 'SJK4H7QW2P' }] })
    const three = (await c.post('/api/sales', whisky())).body.sale
    expect((await c.post(`/api/sales/${three.id}/pay`, { payments: [{ method: 'MPESA', amountCents: 480000, mpesaRef: 'SJK4H7QW2P' }] })).status).toBe(409)
    const manager = await Client.login('manager')
    const list = (await manager.get('/api/mpesa/unverified')).body.payments
    expect(list.map((p: any) => p.mpesaRef).sort()).toEqual(['SJK4H7QW2P', null].sort())
  })
})
