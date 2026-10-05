import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, resetDb, seedFixture, type Fixture } from './helpers.js'
import { connectSocket, nextEvent, noEvent, startServer } from './realtime-helpers.js'
import { prisma } from '../src/db.js'

let srv: Awaited<ReturnType<typeof startServer>>
let fx: Fixture

beforeAll(async () => {
  await resetDb()
  fx = await seedFixture()
  srv = await startServer()
})
afterAll(async () => {
  await srv.stop()
})

describe('sales realtime', () => {
  it('Westlands colleagues hear about a sale and its stock, Kilimani does not', async () => {
    const seller = await Client.login('cashier')
    const west = await connectSocket(srv.url, (await Client.login('cashier2')).cookie)
    const kili = await connectSocket(srv.url, (await Client.login('kilicashier')).cookie)

    const created = nextEvent(west, 'sale:updated')
    const kiliQuiet = noEvent(kili, 'sale:updated')
    const r = await seller.post('/api/sales', { lines: [{ productId: fx.products.beer.id, qty: 3 }] })
    expect(r.status).toBe(201)
    const ev = await created
    expect(ev.sale.id).toBe(r.body.sale.id)
    expect(ev.sale.status).toBe('SAVED')
    await kiliQuiet

    await prisma.shift.create({ data: { userId: fx.users.cashier.id, branchId: fx.branches.west.id, openingFloatCents: 0 } })
    const paidEv = nextEvent(west, 'sale:updated')
    const stockEv = nextEvent(west, 'stock:updated')
    const kiliQuiet2 = noEvent(kili, 'sale:updated')
    const kiliNoStock = noEvent(kili, 'stock:updated')
    const p = await seller.post(`/api/sales/${r.body.sale.id}/pay`, { payments: [{ method: 'CASH', amountCents: 84000, tenderedCents: 100000 }] })
    expect(p.status).toBe(200)
    expect((await paidEv).sale.status).toBe('PAID')
    const st = await stockEv
    expect(st).toMatchObject({ branchId: fx.branches.west.id, productId: fx.products.beer.id, qty: 47 })
    await kiliQuiet2
    await kiliNoStock
    west.close()
    kili.close()
  })
})
