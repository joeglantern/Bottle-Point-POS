import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { app, Client, ORIGIN, resetDb, seedFixture, type Fixture } from './helpers.js'

let fx: Fixture

beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
})

async function register(username = 'cashier') {
  const c = await Client.login(username, undefined, fx.branches.west.id)
  const r = await c.post('/api/offline/devices', { name: 'Front counter' })
  expect(r.status).toBe(201)
  return { client: c, token: r.body.token as string, code: r.body.device.code as string, id: r.body.device.id as string }
}

async function sync(token: string, ops: unknown[]) {
  const res = await app.request('/api/offline/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-device-token': token },
    body: JSON.stringify({ ops })
  })
  const body = await res.json()
  return { status: res.status, body, results: (body.results ?? []) as any[] }
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

function shiftOp(userId: string, float = 500000) {
  return { opId: randomUUID(), type: 'shift_open', clientId: randomUUID(), branchId: fx.branches.west.id, userId, openingFloatCents: float, at: minutesAgo(30) }
}

let seq = 0
function saleOp(code: string, opts: { userId?: string; lines?: { productId: string; name: string; unitCents: number; qty: number }[]; payments?: any[]; clientId?: string; at?: string } = {}) {
  const lines = opts.lines ?? [{ productId: fx.products.beer.id, name: 'Tusker Lager', unitCents: 28000, qty: 2 }]
  return {
    opId: randomUUID(),
    type: 'sale',
    clientId: opts.clientId ?? randomUUID(),
    offlineRef: `${code}-${String(++seq).padStart(4, '0')}`,
    branchId: fx.branches.west.id,
    createdById: opts.userId ?? fx.users.cashier.id,
    createdAt: opts.at ?? minutesAgo(10),
    lines,
    payments: opts.payments ?? []
  }
}

const cash = (amountCents: number, shift: { shiftId?: string; shiftClientId?: string }, extra: Record<string, unknown> = {}) => ({
  clientId: randomUUID(),
  method: 'CASH',
  amountCents,
  tenderedCents: amountCents,
  receivedById: fx.users.cashier.id,
  at: minutesAgo(9),
  ...shift,
  ...extra
})
const mpesa = (amountCents: number, mpesaRef: string) => ({ clientId: randomUUID(), method: 'MPESA', amountCents, mpesaRef, receivedById: fx.users.cashier.id, at: minutesAgo(9) })

const qtyOf = async (productId: string) => (await prisma.stock.findUniqueOrThrow({ where: { branchId_productId: { branchId: fx.branches.west.id, productId } } })).qty
const issues = () => prisma.offlineIssue.findMany({ orderBy: { createdAt: 'asc' } })

describe('registering a till', () => {
  it('gives each till its own code and a key that only works until revoked', async () => {
    const a = await register()
    const b = await register('manager')
    expect([a.code, b.code]).toEqual(['T1', 'T2'])
    const stored = await prisma.device.findUniqueOrThrow({ where: { id: a.id } })
    expect(stored.tokenHash).not.toContain(a.token)

    const manager = await Client.login('manager')
    expect((await manager.get('/api/offline/devices')).body.devices).toHaveLength(2)
    expect((await (await Client.login('cashier')).get('/api/offline/devices')).status).toBe(403)

    expect((await sync(a.token, [shiftOp(fx.users.cashier.id)])).status).toBe(200)
    expect((await manager.post(`/api/offline/devices/${a.id}/revoke`)).status).toBe(200)
    expect((await sync(a.token, [shiftOp(fx.users.cashier.id)])).status).toBe(401)
  })

  it('refuses a missing or made up key', async () => {
    expect((await sync('', [shiftOp(fx.users.cashier.id)])).status).toBe(401)
    expect((await sync('x'.repeat(43), [shiftOp(fx.users.cashier.id)])).status).toBe(401)
  })
})

describe('syncing offline sales', () => {
  it('records a cash sale made offline exactly once, at the time it happened', async () => {
    const t = await register()
    const shift = shiftOp(fx.users.cashier.id)
    const sale = saleOp(t.code, { payments: [cash(56000, { shiftClientId: shift.clientId })] })
    const before = await qtyOf(fx.products.beer.id)

    const first = await sync(t.token, [shift, sale])
    expect(first.results.map(r => r.status)).toEqual(['ok', 'ok'])
    const s = first.results[1].sale
    expect(s).toMatchObject({ status: 'PAID', offlineRef: sale.offlineRef })
    expect(s.number).toBeGreaterThan(1000)

    const row = await prisma.sale.findUniqueOrThrow({ where: { id: s.id }, include: { payments: true } })
    expect(row.createdAt.toISOString()).toBe(sale.createdAt)
    expect(row.paidAt!.toISOString()).toBe(sale.payments[0].at)
    expect(row.payments[0]!.shiftId).toBe(first.results[0].shift.id)
    expect(await qtyOf(fx.products.beer.id)).toBe(before - 2)

    // the reply was lost, so the till sends everything again
    const again = await sync(t.token, [shift, sale])
    expect(again.results).toEqual(first.results)
    expect(await prisma.sale.count()).toBe(1)
    expect(await prisma.payment.count()).toBe(1)
    expect(await prisma.shift.count()).toBe(1)
    expect(await qtyOf(fx.products.beer.id)).toBe(before - 2)
    expect(await issues()).toEqual([])
  })

  it('keeps a tab saved offline as an unpaid sale, and a typed M-Pesa code waits for a manager check', async () => {
    const t = await register()
    const tab = await sync(t.token, [saleOp(t.code)])
    expect(tab.results[0].sale.status).toBe('SAVED')
    const paid = await sync(t.token, [saleOp(t.code, { payments: [mpesa(56000, 'SJK4H7QW2P')] })])
    const p = await prisma.payment.findFirstOrThrow({ where: { sale: { id: paid.results[0].sale.id } } })
    expect(p.verification).toBe('MANUAL_UNVERIFIED')
  })

  it('records cash that arrives after its shift was counted, and tells the manager', async () => {
    const t = await register()
    const shift = await prisma.shift.create({ data: { branchId: fx.branches.west.id, userId: fx.users.cashier.id, openingFloatCents: 0 } })
    await prisma.shift.update({ where: { id: shift.id }, data: { closedAt: new Date(), expectedCashCents: 0, countedCashCents: 0, varianceCents: 0 } })
    const r = await sync(t.token, [saleOp(t.code, { payments: [cash(56000, { shiftId: shift.id })] })])
    expect(r.results[0]).toMatchObject({ status: 'ok', sale: { status: 'PAID' } })
    const pay = await prisma.payment.findFirstOrThrow()
    expect(pay.shiftId).toBe(shift.id)
    const [i] = await issues()
    expect(i!.kind).toBe('cash_after_close')
    expect(i!.message).toMatch(/KSh 560/)
  })

  it('does not take an M-Pesa code twice: the second sale stays unpaid and is flagged', async () => {
    const t = await register()
    await sync(t.token, [saleOp(t.code, { payments: [mpesa(56000, 'SJK4H7QW2P')] })])
    const r = await sync(t.token, [saleOp(t.code, { payments: [mpesa(56000, 'SJK4H7QW2P')] })])
    expect(r.results[0].sale.status).toBe('SAVED')
    expect((await issues()).map(i => i.kind)).toEqual(['mpesa_code_used'])
  })

  it('pays a tab that existed before the internet dropped', async () => {
    const t = await register()
    const c = t.client
    const tab = (await c.post('/api/sales', { lines: [{ productId: fx.products.gin.id, qty: 1 }] })).body.sale
    const shift = await prisma.shift.create({ data: { branchId: fx.branches.west.id, userId: fx.users.cashier.id, openingFloatCents: 0 } })
    const op = { opId: randomUUID(), type: 'pay', saleId: tab.id, seenTotalCents: 145000, payments: [cash(145000, { shiftId: shift.id })] }
    const r = await sync(t.token, [op])
    expect(r.results[0].sale.status).toBe('PAID')
    expect(await issues()).toEqual([])
  })

  it('flags a tab paid offline that another till had already been paid, without recording the money twice', async () => {
    const t = await register()
    const c = t.client
    const tab = (await c.post('/api/sales', { lines: [{ productId: fx.products.gin.id, qty: 1 }] })).body.sale
    const shift = await prisma.shift.create({ data: { branchId: fx.branches.west.id, userId: fx.users.cashier.id, openingFloatCents: 0 } })
    expect((await c.post(`/api/sales/${tab.id}/pay`, { payments: [{ method: 'CASH', amountCents: 145000 }] })).status).toBe(200)
    const op = { opId: randomUUID(), type: 'pay', saleId: tab.id, seenTotalCents: 145000, payments: [cash(145000, { shiftId: shift.id })] }
    const r = await sync(t.token, [op])
    expect(r.results[0].status).toBe('ok')
    expect(await prisma.payment.count()).toBe(1)
    const [i] = await issues()
    expect(i!.kind).toBe('already_paid')
    expect(i!.message).toMatch(/paid twice/)
  })

  it('flags a tab that changed on another till while this one was offline', async () => {
    const t = await register()
    const tab = (await t.client.post('/api/sales', { lines: [{ productId: fx.products.gin.id, qty: 2 }] })).body.sale
    const r = await sync(t.token, [{ opId: randomUUID(), type: 'pay', saleId: tab.id, seenTotalCents: 145000, payments: [mpesa(145000, 'SJK4H7QW2Q')] }])
    expect(r.results[0].sale.status).toBe('SAVED')
    expect((await issues()).map(i => i.kind)).toEqual(['tab_changed'])
  })

  it('merges a shift opened offline into one already open, and says so', async () => {
    const t = await register()
    const open = await prisma.shift.create({ data: { branchId: fx.branches.west.id, userId: fx.users.cashier.id, openingFloatCents: 100000 } })
    const shift = shiftOp(fx.users.cashier.id)
    const r = await sync(t.token, [shift, saleOp(t.code, { payments: [cash(56000, { shiftClientId: shift.clientId })] })])
    expect(r.results[0].shift.id).toBe(open.id)
    expect((await prisma.payment.findFirstOrThrow()).shiftId).toBe(open.id)
    expect((await issues()).map(i => i.kind)).toEqual(['shift_merged'])
  })

  it('uses the server time when the till clock is ahead, and flags it', async () => {
    const t = await register()
    const future = new Date(Date.now() + 3 * 3600_000).toISOString()
    const r = await sync(t.token, [saleOp(t.code, { at: future })])
    const row = await prisma.sale.findUniqueOrThrow({ where: { id: r.results[0].sale.id } })
    expect(row.createdAt.getTime()).toBeLessThanOrEqual(Date.now())
    expect((await issues()).map(i => i.kind)).toEqual(['clock_ahead'])
  })

  it('flags a price below the catalog', async () => {
    const t = await register()
    await sync(t.token, [saleOp(t.code, { lines: [{ productId: fx.products.whisky.id, name: 'Johnnie Walker Black', unitCents: 100000, qty: 1 }] })])
    const [i] = await issues()
    expect(i!.kind).toBe('price_below_catalog')
  })

  it('refuses only what cannot be true, and keeps going with the rest', async () => {
    const t = await register()
    const other = await prisma.business.create({ data: { name: 'Other' } })
    const foreign = await prisma.product.create({ data: { businessId: other.id, name: 'Foreign', priceCents: 1000, category: 'X' } })
    const bad = [
      saleOp(t.code, { lines: [{ productId: foreign.id, name: 'Foreign', unitCents: 1000, qty: 1 }] }),
      { ...saleOp(t.code), offlineRef: 'T99-0001' },
      { opId: randomUUID(), type: 'nonsense' }
    ]
    const good = saleOp(t.code)
    const r = await sync(t.token, [...bad, good])
    expect(r.results.map(x => x.status)).toEqual(['rejected', 'rejected', 'rejected', 'ok'])
    expect(await prisma.sale.count()).toBe(1)
  })
})

describe('who may appear on a till', () => {
  it('flags a sale by someone who never signed in on that till, until they have', async () => {
    const t = await register()
    const op = saleOp(t.code, { userId: fx.users.cashier2.id })
    await sync(t.token, [op])
    expect((await issues()).map(i => i.kind)).toEqual(['not_seen_on_till'])

    // cashier2 signs in on this till with internet: from then on it is normal
    const c2 = await Client.login('cashier2')
    const seen = await c2.req('POST', '/api/offline/devices/seen', {})
    expect(seen.status).toBe(404) // no till key sent
    const res = await app.request('/api/offline/devices/seen', { method: 'POST', headers: { origin: ORIGIN, cookie: c2.cookie, 'x-device-token': t.token, 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(200)
    await sync(t.token, [saleOp(t.code, { userId: fx.users.cashier2.id })])
    expect(await prisma.offlineIssue.count()).toBe(1)
  })

  it('never counts cash in the shift of someone else', async () => {
    const t = await register()
    const theirs = await prisma.shift.create({ data: { branchId: fx.branches.west.id, userId: fx.users.cashier2.id, openingFloatCents: 0 } })
    const r = await sync(t.token, [saleOp(t.code, { payments: [cash(56000, { shiftId: theirs.id })] })])
    expect(r.results[0].sale.status).toBe('PAID')
    expect((await prisma.payment.findFirstOrThrow()).shiftId).toBeNull()
    expect((await issues()).map(i => i.kind)).toContain('shift_other_person')
  })

  it('another business cannot vouch for a till', async () => {
    const t = await register()
    const other = await prisma.business.create({ data: { name: 'Other' } })
    const b = await prisma.branch.create({ data: { businessId: other.id, name: 'Main' } })
    const { createStaff } = await import('../src/lib/users.js')
    await createStaff(prisma, { businessId: other.id, name: 'Stranger', username: 'stranger', pin: '1234', role: 'OWNER', branchIds: [b.id] })
    const s = await Client.login('stranger')
    const res = await app.request('/api/offline/devices/seen', { method: 'POST', headers: { origin: ORIGIN, cookie: s.cookie, 'x-device-token': t.token, 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(404)
  })
})

describe('the same request sent twice online', () => {
  it('creates one sale and records one payment', async () => {
    const c = await Client.login('cashier')
    await prisma.shift.create({ data: { branchId: fx.branches.west.id, userId: fx.users.cashier.id, openingFloatCents: 0 } })
    const clientId = randomUUID()
    const a = await c.post('/api/sales', { clientId, lines: [{ productId: fx.products.beer.id, qty: 1 }] })
    const b = await c.post('/api/sales', { clientId, lines: [{ productId: fx.products.beer.id, qty: 1 }] })
    expect(a.status).toBe(201)
    expect(b.status).toBe(200)
    expect(b.body.sale.id).toBe(a.body.sale.id)
    expect(await prisma.sale.count()).toBe(1)

    const pay = { payments: [{ method: 'CASH', amountCents: 28000, tenderedCents: 30000, clientId: randomUUID() }] }
    const p1 = await c.post(`/api/sales/${a.body.sale.id}/pay`, pay)
    const p2 = await c.post(`/api/sales/${a.body.sale.id}/pay`, pay)
    expect(p1.status).toBe(200)
    expect(p2.status).toBe(200)
    expect(p2.body.changeCents).toBe(2000)
    expect(await prisma.payment.count()).toBe(1)
  })

  it('finishes offline a sale whose online reply was lost, with the lines the till ended with', async () => {
    const t = await register()
    const clientId = randomUUID()
    await t.client.post('/api/sales', { clientId, lines: [{ productId: fx.products.beer.id, qty: 1 }] })
    const shift = shiftOp(fx.users.cashier.id)
    const op = saleOp(t.code, {
      clientId,
      lines: [{ productId: fx.products.beer.id, name: 'Tusker Lager', unitCents: 28000, qty: 3 }],
      payments: [cash(84000, { shiftClientId: shift.clientId })]
    })
    const r = await sync(t.token, [shift, op])
    expect(r.results[1].sale.status).toBe('PAID')
    const sale = await prisma.sale.findUniqueOrThrow({ where: { clientId }, include: { lines: true } })
    expect(sale.lines[0]!.qty).toBe(3)
    expect(sale.offlineRef).toBe(op.offlineRef)
    expect(await prisma.sale.count()).toBe(1)
  })
})

describe('what managers see', () => {
  it('lists open items and lets a manager mark one dealt with', async () => {
    const t = await register()
    await sync(t.token, [saleOp(t.code, { at: new Date(Date.now() + 3600_000).toISOString() })])
    const manager = await Client.login('manager')
    const list = await manager.get('/api/offline/issues')
    expect(list.body.open).toBe(1)
    const issue = list.body.issues[0]
    expect(issue).toMatchObject({ kind: 'clock_ahead', deviceCode: 'T1' })
    expect(issue.sale.offlineRef).toMatch(/^T1-/)
    expect((await (await Client.login('cashier')).get('/api/offline/issues')).status).toBe(403)
    expect((await (await Client.login('kilimanager')).get('/api/offline/issues')).body.open).toBe(0)

    expect((await manager.post(`/api/offline/issues/${issue.id}/resolve`, { note: 'Fixed the till clock' })).status).toBe(200)
    expect((await manager.get('/api/offline/issues')).body.open).toBe(0)
    expect((await manager.post(`/api/offline/issues/${issue.id}/resolve`, { note: 'again' })).status).toBe(422)
  })

  it('tells a till which people may still sign in on it offline', async () => {
    const c = await Client.login('cashier')
    await prisma.user.update({ where: { id: fx.users.cashier2.id }, data: { active: false } })
    const r = await c.get(`/api/offline/bootstrap?users=${fx.users.cashier.id},${fx.users.cashier2.id},someone-else`)
    expect(r.body.activeStaff).toEqual([fx.users.cashier.id])
    expect(r.body.business.name).toBe('Test Wines')
  })

  it('finds an offline sale by the number on its printed receipt', async () => {
    const t = await register()
    const op = saleOp(t.code)
    await sync(t.token, [op])
    const r = await t.client.get(`/api/sales?q=${op.offlineRef.toLowerCase()}`)
    expect(r.body.sales.map((s: any) => s.offlineRef)).toEqual([op.offlineRef])
  })
})
