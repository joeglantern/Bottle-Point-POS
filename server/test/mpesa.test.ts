import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { app, Client, resetDb, seedFixture, type Fixture } from './helpers.js'
import { connectSocket, nextEvent, noEvent, startServer } from './realtime-helpers.js'
import { prisma } from '../src/db.js'
import { env } from '../src/env.js'
import { applyPayment } from '../src/rules/sale-core.js'
import {
  DarajaClient,
  darajaTimestamp,
  getDaraja,
  setDaraja,
  stkPassword,
  type DarajaConfig
} from '../src/lib/daraja.js'
import { buildStkCallback, mpesaSettings, runMockCallback, sweepMpesa } from '../src/rules/mpesa.js'

let fx: Fixture

beforeAll(() => {
  // tests decide when Safaricom answers
  mpesaSettings.mockDelayMs = 0
})

beforeEach(async () => {
  setDaraja(null)
  await resetDb()
  fx = await seedFixture()
})

afterEach(() => setDaraja(null))

type LineIn = { product: { id: string; name: string; priceCents: number }; qty: number; unitCents?: number }

// Sales are inserted directly so these tests do not depend on the sales API.
async function makeSale(opts: { branchId?: string; createdById?: string; lines?: LineIn[]; status?: 'OPEN' | 'SAVED' | 'CANCELLED' } = {}) {
  const branchId = opts.branchId ?? fx.branches.west.id
  const lines = opts.lines ?? [{ product: fx.products.whisky, qty: 2 }]
  const b = await prisma.branch.update({ where: { id: branchId }, data: { nextSaleNo: { increment: 1 } } })
  const subtotal = lines.reduce((a, l) => a + (l.unitCents ?? l.product.priceCents) * l.qty, 0)
  return prisma.sale.create({
    data: {
      number: b.nextSaleNo - 1,
      branchId,
      createdById: opts.createdById ?? fx.users.cashier.id,
      status: opts.status ?? 'SAVED',
      subtotalCents: subtotal,
      totalCents: subtotal,
      lines: {
        create: lines.map(l => ({ productId: l.product.id, name: l.product.name, unitCents: l.unitCents ?? l.product.priceCents, qty: l.qty }))
      }
    }
  })
}

const PHONE = '0712345678'
const PHONE_NORM = '254712345678'

async function callback(payload: unknown, token = env.MPESA_CALLBACK_TOKEN) {
  const res = await app.request(`/api/mpesa/callback/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  })
  return { status: res.status, body: await res.json() }
}

async function successFor(requestId: string, receipt = 'SJK4H7QW2P', amountCents?: number) {
  const r = await prisma.mpesaRequest.findUniqueOrThrow({ where: { id: requestId } })
  return buildStkCallback({
    merchantRequestId: r.merchantRequestId!,
    checkoutRequestId: r.checkoutRequestId!,
    resultCode: 0,
    resultDesc: 'The service request is processed successfully.',
    receipt,
    amountCents: amountCents ?? r.amountCents,
    phone: r.phone
  })
}

async function resultFor(requestId: string, resultCode: number, resultDesc = 'x') {
  const r = await prisma.mpesaRequest.findUniqueOrThrow({ where: { id: requestId } })
  return buildStkCallback({ merchantRequestId: r.merchantRequestId!, checkoutRequestId: r.checkoutRequestId!, resultCode, resultDesc })
}

async function stockQty(productId: string, branchId = fx.branches.west.id) {
  const s = await prisma.stock.findUniqueOrThrow({ where: { branchId_productId: { branchId, productId } } })
  return s.qty
}

async function auditActions(entityId: string) {
  const rows = await prisma.auditLog.findMany({ where: { entityId }, orderBy: { id: 'asc' } })
  return rows.map(r => r.action)
}

describe('STK push', () => {
  it('success path: sale becomes PAID with a confirmed payment and stock goes down', async () => {
    const shift = await prisma.shift.create({ data: { branchId: fx.branches.west.id, userId: fx.users.cashier.id, openingFloatCents: 0 } })
    const sale = await makeSale()
    const c = await Client.login('cashier')
    const res = await c.post('/api/mpesa/stk', { saleId: sale.id, phone: PHONE })
    expect(res.status).toBe(200)
    const r = res.body.request
    expect(r.status).toBe('PENDING')
    expect(r.phone).toBe(PHONE_NORM)
    expect(r.amountCents).toBe(960000)
    expect(r.shiftId).toBe(shift.id)
    expect(r.checkoutRequestId).toBeTruthy()
    expect(r.merchantRequestId).toBeTruthy()

    const cb = await callback(await successFor(r.id))
    expect(cb).toEqual({ status: 200, body: { ResultCode: 0, ResultDesc: 'Accepted' } })

    const after = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id }, include: { payments: true } })
    expect(after.status).toBe('PAID')
    expect(after.paidById).toBe(fx.users.cashier.id)
    expect(after.payments).toHaveLength(1)
    const p = after.payments[0]!
    expect(p).toMatchObject({
      method: 'MPESA',
      verification: 'STK_CONFIRMED',
      mpesaRef: 'SJK4H7QW2P',
      amountCents: 960000,
      mpesaRequestId: r.id,
      receivedById: fx.users.cashier.id,
      shiftId: shift.id,
      phone: PHONE_NORM
    })
    expect(await stockQty(fx.products.whisky.id)).toBe(48)
    const req = await prisma.mpesaRequest.findUniqueOrThrow({ where: { id: r.id } })
    expect(req.status).toBe('SUCCESS')
    expect(req.receipt).toBe('SJK4H7QW2P')
    expect(req.rawCallback).toBeTruthy()
    expect(await auditActions(r.id)).toEqual(['mpesa.stk_requested', 'mpesa.paid'])

    const one = await c.get(`/api/mpesa/requests/${r.id}`)
    expect(one.body.request.status).toBe('SUCCESS')
  })

  it('mock Safaricom answers by phone ending', async () => {
    const c = await Client.login('cashier')
    const cases: [string, string | null][] = [
      ['0712345678', 'SUCCESS'],
      ['0712345000', 'FAILED'],
      ['0712345111', 'CANCELLED'],
      ['0712345222', null]
    ]
    for (const [phone, want] of cases) {
      const sale = await makeSale()
      const res = await c.post('/api/mpesa/stk', { saleId: sale.id, phone })
      expect(res.status).toBe(200)
      const out = await runMockCallback(res.body.request.checkoutRequestId)
      const req = await prisma.mpesaRequest.findUniqueOrThrow({ where: { id: res.body.request.id } })
      if (want === null) {
        expect(out).toBeNull()
        expect(req.status).toBe('PENDING')
      } else {
        expect(req.status).toBe(want)
      }
      if (want === 'SUCCESS') {
        expect(req.receipt).toMatch(/^[A-Z0-9]{10}$/)
        expect((await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PAID')
      }
    }
  })

  it('mock mode calls back by itself after the delay', async () => {
    mpesaSettings.mockDelayMs = 50
    try {
      const sale = await makeSale()
      const c = await Client.login('cashier')
      const res = await c.post('/api/mpesa/stk', { saleId: sale.id, phone: PHONE })
      expect(res.body.request.status).toBe('PENDING')
      let status = 'PENDING'
      for (let i = 0; i < 50 && status === 'PENDING'; i++) {
        await new Promise(r => setTimeout(r, 50))
        status = (await prisma.mpesaRequest.findUniqueOrThrow({ where: { id: res.body.request.id } })).status
      }
      expect(status).toBe('SUCCESS')
    } finally {
      mpesaSettings.mockDelayMs = 0
    }
  })

  it('partial STK then cash completes the sale', async () => {
    const sale = await makeSale()
    const c = await Client.login('cashier')
    const res = await c.post('/api/mpesa/stk', { saleId: sale.id, phone: PHONE, amountCents: 480000 })
    expect(res.status).toBe(200)
    expect(res.body.request.amountCents).toBe(480000)
    await callback(await successFor(res.body.request.id))
    let s = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id }, include: { payments: true } })
    expect(s.status).toBe('SAVED')
    expect(s.payments).toHaveLength(1)
    expect(await stockQty(fx.products.whisky.id)).toBe(50)

    // a second STK may only ask for what is left
    const over = await c.post('/api/mpesa/stk', { saleId: sale.id, phone: PHONE, amountCents: 480100 })
    expect(over.status).toBe(422)
    expect(over.body.error.code).toBe('overpayment')

    await prisma.$transaction(tx =>
      applyPayment(tx, { saleId: sale.id, method: 'CASH', amountCents: 480000, tenderedCents: 500000, verification: 'CASH', receivedById: fx.users.cashier.id })
    )
    s = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id }, include: { payments: true } })
    expect(s.status).toBe('PAID')
    expect(s.payments.map(p => p.method).sort()).toEqual(['CASH', 'MPESA'])
    expect(await stockQty(fx.products.whisky.id)).toBe(48)
  })

  it('validates input', async () => {
    const sale = await makeSale()
    const c = await Client.login('cashier')
    const post = (b: unknown) => c.post('/api/mpesa/stk', b)

    expect((await post({ phone: PHONE })).status).toBe(400)
    expect((await post({ saleId: sale.id })).status).toBe(400)
    expect((await post({ saleId: sale.id, phone: '0812' })).status).toBe(400)
    expect((await post({ saleId: sale.id, phone: PHONE, amountCents: 100.5 })).status).toBe(400)
    expect((await post({ saleId: sale.id, phone: PHONE, amountCents: '100' })).status).toBe(400)

    const zero = await post({ saleId: sale.id, phone: PHONE, amountCents: 0 })
    expect([zero.status, zero.body.error.code]).toEqual([422, 'bad_amount'])
    const neg = await post({ saleId: sale.id, phone: PHONE, amountCents: -100 })
    expect([neg.status, neg.body.error.code]).toEqual([422, 'bad_amount'])
    const over = await post({ saleId: sale.id, phone: PHONE, amountCents: 960100 })
    expect([over.status, over.body.error.code]).toEqual([422, 'overpayment'])
    const cents = await post({ saleId: sale.id, phone: PHONE, amountCents: 12345 })
    expect([cents.status, cents.body.error.code]).toEqual([422, 'whole_shillings'])

    // the default amount (what is due) must be whole shillings too
    const odd = await makeSale({ lines: [{ product: fx.products.beer, qty: 1, unitCents: 28050 }] })
    const oddRes = await post({ saleId: odd.id, phone: PHONE })
    expect([oddRes.status, oddRes.body.error.code]).toEqual([422, 'whole_shillings'])

    const cancelled = await makeSale({ status: 'CANCELLED' })
    const cr = await post({ saleId: cancelled.id, phone: PHONE })
    expect([cr.status, cr.body.error.code]).toEqual([422, 'sale_not_payable'])

    const b = await prisma.branch.update({ where: { id: fx.branches.west.id }, data: { nextSaleNo: { increment: 1 } } })
    const empty = await prisma.sale.create({ data: { number: b.nextSaleNo - 1, branchId: b.id, createdById: fx.users.cashier.id, status: 'OPEN' } })
    const er = await post({ saleId: empty.id, phone: PHONE })
    expect([er.status, er.body.error.code]).toEqual([422, 'sale_empty'])

    expect((await post({ saleId: 'nope', phone: PHONE })).status).toBe(404)
    expect(await prisma.mpesaRequest.count()).toBe(0)

    // phone formats are normalised
    const plus = await post({ saleId: sale.id, phone: '+254 712-345-678' })
    expect(plus.body.request.phone).toBe(PHONE_NORM)
  })

  it('cannot touch a sale in another branch', async () => {
    const sale = await makeSale()
    const kili = await Client.login('kilicashier')
    const res = await kili.post('/api/mpesa/stk', { saleId: sale.id, phone: PHONE })
    expect(res.status).toBe(404)

    const c = await Client.login('cashier')
    const ok = await c.post('/api/mpesa/stk', { saleId: sale.id, phone: PHONE })
    const id = ok.body.request.id
    expect((await kili.get(`/api/mpesa/requests/${id}`)).status).toBe(404)
    expect((await kili.post(`/api/mpesa/requests/${id}/cancel`)).status).toBe(404)
    expect((await kili.post(`/api/mpesa/requests/${id}/query`)).status).toBe(404)
    expect((await kili.get('/api/mpesa/requests')).body.requests).toEqual([])
    expect((await kili.get(`/api/mpesa/requests?branchId=${fx.branches.west.id}`)).status).toBe(403)
    expect((await c.get('/api/mpesa/requests')).body.requests).toHaveLength(1)
    expect((await c.get(`/api/mpesa/requests?saleId=${sale.id}&status=PENDING`)).body.requests).toHaveLength(1)
    expect((await c.get(`/api/mpesa/requests?status=SUCCESS`)).body.requests).toHaveLength(0)
    expect((await c.get(`/api/mpesa/requests?status=NOPE`)).status).toBe(400)
  })

  it('only one pending request per sale', async () => {
    const sale = await makeSale()
    const c = await Client.login('cashier')
    const first = await c.post('/api/mpesa/stk', { saleId: sale.id, phone: PHONE })
    expect(first.status).toBe(200)
    const second = await c.post('/api/mpesa/stk', { saleId: sale.id, phone: PHONE })
    expect([second.status, second.body.error.code]).toEqual([409, 'stk_pending'])

    const cancel = await c.post(`/api/mpesa/requests/${first.body.request.id}/cancel`)
    expect(cancel.status).toBe(200)
    expect(cancel.body.request).toMatchObject({ status: 'CANCELLED', resultDesc: 'Cancelled at the till' })
    expect((await c.post(`/api/mpesa/requests/${first.body.request.id}/cancel`)).status).toBe(409)

    const third = await c.post('/api/mpesa/stk', { saleId: sale.id, phone: PHONE })
    expect(third.status).toBe(200)
  })

  it('two taps at once create exactly one request', async () => {
    const sale = await makeSale()
    const a = await Client.login('cashier')
    const b = await Client.login('cashier2')
    const res = await Promise.all([
      a.post('/api/mpesa/stk', { saleId: sale.id, phone: PHONE }),
      b.post('/api/mpesa/stk', { saleId: sale.id, phone: PHONE }),
      a.post('/api/mpesa/stk', { saleId: sale.id, phone: PHONE })
    ])
    expect(res.map(r => r.status).sort()).toEqual([200, 409, 409])
    expect(await prisma.mpesaRequest.count({ where: { saleId: sale.id } })).toBe(1)
  })
})

describe('callback', () => {
  async function pending(phone = PHONE) {
    const sale = await makeSale()
    const c = await Client.login('cashier')
    const res = await c.post('/api/mpesa/stk', { saleId: sale.id, phone })
    return { sale, c, req: res.body.request }
  }

  it('wrong token is 404 and changes nothing', async () => {
    const { sale, req } = await pending()
    const payload = await successFor(req.id)
    for (const token of ['wrong-token-123456789', env.MPESA_CALLBACK_TOKEN + 'x', 'a']) {
      const r = await callback(payload, token)
      expect(r.status).toBe(404)
    }
    const after = await prisma.mpesaRequest.findUniqueOrThrow({ where: { id: req.id } })
    expect(after.status).toBe('PENDING')
    expect(after.rawCallback).toBeNull()
    expect(await prisma.payment.count({ where: { saleId: sale.id } })).toBe(0)
  })

  it('answers Accepted to garbage and unknown requests', async () => {
    expect((await callback({ hello: 1 })).body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' })
    const res = await app.request(`/api/mpesa/callback/${env.MPESA_CALLBACK_TOKEN}`, { method: 'POST', body: 'not json' })
    expect(res.status).toBe(200)
    const unknown = buildStkCallback({ merchantRequestId: 'm', checkoutRequestId: 'ws_CO_unknown', resultCode: 0, resultDesc: 'ok', receipt: 'SAAAAAAAAA', amountCents: 100, phone: PHONE_NORM })
    expect((await callback(unknown)).status).toBe(200)
    expect(await prisma.payment.count()).toBe(0)
  })

  it('duplicate callbacks record one payment', async () => {
    const { sale, req } = await pending()
    const payload = await successFor(req.id)
    const res = await Promise.all([callback(payload), callback(payload), callback(payload)])
    expect(res.every(r => r.status === 200 && r.body.ResultCode === 0)).toBe(true)
    await callback(payload)
    expect(await prisma.payment.count({ where: { saleId: sale.id } })).toBe(1)
    expect(await stockQty(fx.products.whisky.id)).toBe(48)
    expect((await auditActions(req.id)).filter(a => a === 'mpesa.paid')).toHaveLength(1)
  })

  it('a different amount is flagged and no payment is made', async () => {
    const { sale, req } = await pending()
    await callback(await successFor(req.id, 'SJK4H7QW2P', 100))
    const after = await prisma.mpesaRequest.findUniqueOrThrow({ where: { id: req.id } })
    expect(after.status).toBe('FAILED')
    expect(after.resultDesc).toContain('KSh 1')
    expect(after.resultDesc).toContain('was requested')
    expect(await prisma.payment.count({ where: { saleId: sale.id } })).toBe(0)
    expect(await auditActions(req.id)).toContain('mpesa.amount_mismatch')
  })

  it('maps cancelled, timeout, wrong PIN and other failures', async () => {
    const cases: [number, string, string][] = [
      [1032, 'CANCELLED', 'cancelled'],
      [1037, 'TIMEOUT', 'could not be reached'],
      [2001, 'FAILED', 'wrong M-Pesa PIN'],
      [1, 'FAILED', 'The balance is insufficient']
    ]
    for (const [code, status, text] of cases) {
      const { sale, req } = await pending()
      await callback(await resultFor(req.id, code, 'The balance is insufficient for the transaction.'))
      const after = await prisma.mpesaRequest.findUniqueOrThrow({ where: { id: req.id } })
      expect(after.status).toBe(status)
      expect(after.resultCode).toBe(code)
      expect(after.resultDesc).toContain(text)
      expect(await prisma.payment.count({ where: { saleId: sale.id } })).toBe(0)
      // a success after a real Safaricom failure is ignored
      await callback(await successFor(req.id))
      expect((await prisma.mpesaRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe(status)
    }
  })

  it('a late success after the till cancelled is still recorded', async () => {
    const { sale, c, req } = await pending()
    expect((await c.post(`/api/mpesa/requests/${req.id}/cancel`)).status).toBe(200)
    await callback(await successFor(req.id))
    const after = await prisma.mpesaRequest.findUniqueOrThrow({ where: { id: req.id } })
    expect(after.status).toBe('SUCCESS')
    expect(after.resultDesc).toContain('after it was closed')
    const s = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id }, include: { payments: true } })
    expect(s.status).toBe('PAID')
    expect(s.payments[0]!.verification).toBe('STK_CONFIRMED')
  })

  it('a late success for a sale already paid in cash is kept as unlinked', async () => {
    const { sale, c, req } = await pending()
    await c.post(`/api/mpesa/requests/${req.id}/cancel`)
    await prisma.$transaction(tx =>
      applyPayment(tx, { saleId: sale.id, method: 'CASH', amountCents: 960000, verification: 'CASH', receivedById: fx.users.cashier.id })
    )
    await callback(await successFor(req.id))
    const after = await prisma.mpesaRequest.findUniqueOrThrow({ where: { id: req.id } })
    expect(after.status).toBe('SUCCESS')
    expect(after.receipt).toBe('SJK4H7QW2P')
    expect(after.resultDesc).toContain('could not be added')
    expect(await prisma.payment.count({ where: { saleId: sale.id } })).toBe(1)
    expect(await auditActions(req.id)).toContain('mpesa.unlinked_payment')
  })

  it('success for a sale cancelled meanwhile is recorded as unlinked', async () => {
    const { sale, req } = await pending()
    await prisma.sale.update({ where: { id: sale.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } })
    await callback(await successFor(req.id))
    const after = await prisma.mpesaRequest.findUniqueOrThrow({ where: { id: req.id } })
    expect(after.status).toBe('SUCCESS')
    expect(after.receipt).toBe('SJK4H7QW2P')
    expect(after.resultDesc).toContain('cancelled')
    expect(after.resultDesc).toContain('A manager must sort this out')
    expect(await prisma.payment.count()).toBe(0)
    expect(await stockQty(fx.products.whisky.id)).toBe(50)
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: req.id, action: 'mpesa.unlinked_payment' } })
    expect(log.branchId).toBe(fx.branches.west.id)
    // and a repeat changes nothing
    await callback(await successFor(req.id))
    expect((await auditActions(req.id)).filter(a => a === 'mpesa.unlinked_payment')).toHaveLength(1)
  })

  it('a receipt code already used is not counted twice', async () => {
    const other = await makeSale({ lines: [{ product: fx.products.beer, qty: 1 }] })
    await prisma.$transaction(tx =>
      applyPayment(tx, {
        saleId: other.id,
        method: 'MPESA',
        amountCents: 28000,
        mpesaRef: 'SJK4H7QW2P',
        verification: 'MANUAL_UNVERIFIED',
        receivedById: fx.users.cashier.id
      })
    )
    const { sale, req } = await pending()
    await callback(await successFor(req.id, 'SJK4H7QW2P'))
    const after = await prisma.mpesaRequest.findUniqueOrThrow({ where: { id: req.id } })
    expect(after.status).toBe('SUCCESS')
    expect(after.resultDesc).toContain('already linked')
    expect(await prisma.payment.count({ where: { mpesaRef: 'SJK4H7QW2P' } })).toBe(1)
    expect(await prisma.payment.count({ where: { saleId: sale.id } })).toBe(0)
    expect((await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('SAVED')

    // the same receipt on a second request does not break the unique index
    const second = await pending()
    await callback(await successFor(second.req.id, 'SJK4H7QW2P'))
    const s2 = await prisma.mpesaRequest.findUniqueOrThrow({ where: { id: second.req.id } })
    expect(s2.status).toBe('SUCCESS')
    expect(s2.receipt).toBeNull()
    expect(s2.resultDesc).toContain('SJK4H7QW2P')
  })

  it('a code typed at the till for the same sale becomes confirmed', async () => {
    const { sale, req } = await pending()
    // cashier gave up waiting and typed the SMS code
    await prisma.$transaction(tx =>
      applyPayment(tx, {
        saleId: sale.id,
        method: 'MPESA',
        amountCents: 960000,
        mpesaRef: 'SJK4H7QW2P',
        verification: 'MANUAL_UNVERIFIED',
        receivedById: fx.users.cashier.id
      })
    )
    await callback(await successFor(req.id, 'SJK4H7QW2P'))
    const pays = await prisma.payment.findMany({ where: { saleId: sale.id } })
    expect(pays).toHaveLength(1)
    expect(pays[0]!.verification).toBe('STK_CONFIRMED')
    expect(pays[0]!.mpesaRequestId).toBe(req.id)
    expect((await prisma.mpesaRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe('SUCCESS')
  })
})

describe('query, simulate and sweeper', () => {
  it('query returns a pending request unchanged and settles a finished one', async () => {
    const c = await Client.login('cashier')
    const s1 = await makeSale()
    const waiting = (await c.post('/api/mpesa/stk', { saleId: s1.id, phone: '0712345222' })).body.request
    const q1 = await c.post(`/api/mpesa/requests/${waiting.id}/query`)
    expect(q1.status).toBe(200)
    expect(q1.body.request.status).toBe('PENDING')

    const s2 = await makeSale()
    const done = (await c.post('/api/mpesa/stk', { saleId: s2.id, phone: PHONE })).body.request
    const q2 = await c.post(`/api/mpesa/requests/${done.id}/query`)
    expect(q2.body.request.status).toBe('SUCCESS')
    expect((await prisma.sale.findUniqueOrThrow({ where: { id: s2.id } })).status).toBe('PAID')
    // a second query of a finished request does nothing
    expect((await c.post(`/api/mpesa/requests/${done.id}/query`)).body.request.status).toBe('SUCCESS')
    expect(await prisma.payment.count({ where: { saleId: s2.id } })).toBe(1)
  })

  it('simulate is for managers in mock mode only', async () => {
    const sale = await makeSale()
    const c = await Client.login('cashier')
    const req = (await c.post('/api/mpesa/stk', { saleId: sale.id, phone: '0712345222' })).body.request
    expect((await c.post(`/api/mpesa/requests/${req.id}/simulate`, { outcome: 'success' })).status).toBe(403)
    const m = await Client.login('manager')
    expect((await m.post(`/api/mpesa/requests/${req.id}/simulate`, { outcome: 'maybe' })).status).toBe(400)
    const kiliM = await Client.login('kilimanager')
    expect((await kiliM.post(`/api/mpesa/requests/${req.id}/simulate`, { outcome: 'success' })).status).toBe(404)

    setDaraja(new DarajaClient({ ...getDaraja().cfg, mode: 'sandbox' }))
    expect((await m.post(`/api/mpesa/requests/${req.id}/simulate`, { outcome: 'success' })).status).toBe(404)
    setDaraja(null)

    const ok = await m.post(`/api/mpesa/requests/${req.id}/simulate`, { outcome: 'success' })
    expect(ok.status).toBe(200)
    expect(ok.body.request.status).toBe('SUCCESS')
    expect((await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PAID')

    const s2 = await makeSale()
    const r2 = (await c.post('/api/mpesa/stk', { saleId: s2.id, phone: PHONE })).body.request
    expect((await m.post(`/api/mpesa/requests/${r2.id}/simulate`, { outcome: 'cancelled' })).body.request.status).toBe('CANCELLED')
    const s3 = await makeSale()
    const r3 = (await c.post('/api/mpesa/stk', { saleId: s3.id, phone: PHONE })).body.request
    expect((await m.post(`/api/mpesa/requests/${r3.id}/simulate`, { outcome: 'failed' })).body.request.status).toBe('FAILED')
  })

  it('sweeper queries stale requests and times out ones with no answer', async () => {
    const c = await Client.login('cashier')
    const mk = async (phone: string, ageMs: number) => {
      const sale = await makeSale()
      const r = (await c.post('/api/mpesa/stk', { saleId: sale.id, phone })).body.request
      await prisma.mpesaRequest.update({ where: { id: r.id }, data: { createdAt: new Date(Date.now() - ageMs) } })
      return { sale, id: r.id as string }
    }
    const fresh = await mk('0712345222', 10_000)
    const quiet = await mk('0712345222', 90_000)
    const stale = await mk('0712345222', 4 * 60_000)
    const answered = await mk(PHONE, 90_000)

    const res = await sweepMpesa()
    expect(res).toMatchObject({ checked: 3, timedOut: 1, settled: 1 })
    const status = async (id: string) => (await prisma.mpesaRequest.findUniqueOrThrow({ where: { id } })).status
    expect(await status(fresh.id)).toBe('PENDING')
    expect(await status(quiet.id)).toBe('PENDING')
    expect(await status(stale.id)).toBe('TIMEOUT')
    expect(await status(answered.id)).toBe('SUCCESS')
    expect((await prisma.sale.findUniqueOrThrow({ where: { id: answered.sale.id } })).status).toBe('PAID')

    // running it again is harmless
    expect((await sweepMpesa()).timedOut).toBe(0)

    // Safaricom answering after the timeout still records the money
    await callback(await successFor(stale.id, 'SZZZZZZZZ1'))
    expect(await status(stale.id)).toBe('SUCCESS')
    expect((await prisma.sale.findUniqueOrThrow({ where: { id: stale.sale.id } })).status).toBe('PAID')
  })
})

describe('manual code verification', () => {
  async function typedPayment(branch: 'west' | 'kili', ref: string) {
    const b = fx.branches[branch]
    const by = branch === 'west' ? fx.users.cashier.id : fx.users.kiliCashier.id
    const sale = await makeSale({ branchId: b.id, createdById: by })
    const { payment } = await prisma.$transaction(tx =>
      applyPayment(tx, { saleId: sale.id, method: 'MPESA', amountCents: 960000, mpesaRef: ref, phone: PHONE_NORM, verification: 'MANUAL_UNVERIFIED', receivedById: by })
    )
    return { sale, payment }
  }

  it('managers list and decide typed codes in their branches only', async () => {
    const a = await typedPayment('west', 'QWERTY1234')
    const b = await typedPayment('west', 'QWERTY5678')
    const k = await typedPayment('kili', 'KILI123456')

    const cashier = await Client.login('cashier')
    expect((await cashier.get('/api/mpesa/unverified')).status).toBe(403)
    expect((await cashier.post(`/api/mpesa/payments/${a.payment.id}/verify`, { ok: true })).status).toBe(403)

    const m = await Client.login('manager')
    const list = await m.get('/api/mpesa/unverified')
    expect(list.status).toBe(200)
    expect(list.body.payments.map((p: any) => p.mpesaRef).sort()).toEqual(['QWERTY1234', 'QWERTY5678'])
    expect(list.body.payments[0]).toMatchObject({ saleNumber: a.sale.number, amountCents: 960000, receivedByName: 'cashier' })
    expect(list.body.payments[0].createdAt).toBeTruthy()

    expect((await m.post(`/api/mpesa/payments/${k.payment.id}/verify`, { ok: true })).status).toBe(404)
    expect((await m.post(`/api/mpesa/payments/${a.payment.id}/verify`, { ok: 'yes' })).status).toBe(400)

    const ok = await m.post(`/api/mpesa/payments/${a.payment.id}/verify`, { ok: true, note: 'Seen on statement' })
    expect(ok.status).toBe(200)
    expect(ok.body.payment).toMatchObject({ verification: 'MANUAL_VERIFIED', verifiedById: fx.users.manager.id })
    expect(ok.body.payment.verifiedAt).toBeTruthy()
    expect((await m.post(`/api/mpesa/payments/${a.payment.id}/verify`, { ok: false })).status).toBe(409)

    const no = await m.post(`/api/mpesa/payments/${b.payment.id}/verify`, { ok: false, note: 'Not on statement' })
    expect(no.body.payment.verification).toBe('MANUAL_REJECTED')
    // rejecting is a flag only, the sale stays as it was
    expect((await prisma.sale.findUniqueOrThrow({ where: { id: b.sale.id } })).status).toBe('PAID')
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: b.payment.id, action: 'mpesa.manual_rejected' } })
    expect((log.data as any).note).toBe('Not on statement')

    expect((await m.get('/api/mpesa/unverified')).body.payments).toEqual([])

    const km = await Client.login('kilimanager')
    expect((await km.get('/api/mpesa/unverified')).body.payments.map((p: any) => p.mpesaRef)).toEqual(['KILI123456'])

    const owner = await Client.login('owner', undefined, fx.branches.kili.id)
    expect((await owner.get('/api/mpesa/unverified')).body.payments).toHaveLength(1)
    expect((await owner.post(`/api/mpesa/payments/${k.payment.id}/verify`, { ok: true })).status).toBe(200)
  })

  it('two managers cannot both decide', async () => {
    const a = await typedPayment('west', 'RACE123456')
    const m = await Client.login('manager')
    const o = await Client.login('owner', undefined, fx.branches.west.id)
    const res = await Promise.all([
      m.post(`/api/mpesa/payments/${a.payment.id}/verify`, { ok: true }),
      o.post(`/api/mpesa/payments/${a.payment.id}/verify`, { ok: false })
    ])
    expect(res.map(r => r.status).sort()).toEqual([200, 409])
  })
})

describe('Daraja client', () => {
  const cfg: DarajaConfig = {
    mode: 'sandbox',
    consumerKey: 'key123',
    consumerSecret: 'secret456',
    shortcode: '174379',
    passkey: 'pk',
    transactionType: 'CustomerPayBillOnline',
    partyB: '',
    callbackUrl: 'https://pos.example.com/api/mpesa/callback/',
    callbackToken: 'tok_abcdefghijklmnop',
    timeoutMs: 15_000
  }
  // 09:30:15 UTC is 12:30:15 in Nairobi
  const fixed = new Date('2026-10-05T09:30:15Z')

  type Call = { url: string; init: RequestInit }
  function fakeFetch(responses: { status: number; json: unknown }[]) {
    const calls: Call[] = []
    const fn = async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      const r = responses.shift() ?? { status: 500, json: {} }
      return new Response(JSON.stringify(r.json), { status: r.status })
    }
    return { fn, calls }
  }

  it('builds timestamp and password', () => {
    expect(darajaTimestamp(fixed)).toBe('20261005123015')
    // late evening UTC is already the next day in Nairobi
    expect(darajaTimestamp(new Date('2026-12-31T22:05:09Z'))).toBe('20270101010509')
    expect(stkPassword('174379', 'pk', '20261005123015')).toBe(Buffer.from('174379pk20261005123015').toString('base64'))
  })

  it('sends a correct sandbox STK push and caches the token', async () => {
    const f = fakeFetch([
      { status: 200, json: { access_token: 'AT1', expires_in: '3599' } },
      { status: 200, json: { MerchantRequestID: 'MR1', CheckoutRequestID: 'ws_CO_1', ResponseCode: '0', CustomerMessage: 'ok' } },
      { status: 200, json: { MerchantRequestID: 'MR2', CheckoutRequestID: 'ws_CO_2', ResponseCode: '0' } }
    ])
    const d = new DarajaClient(cfg, f.fn, () => fixed)
    const res = await d.stkPush({ phone: PHONE_NORM, amountCents: 960000, accountReference: 'BP1042-LONG-REFERENCE', description: 'Sale 1042 at Westlands' })
    expect(res).toEqual({ merchantRequestId: 'MR1', checkoutRequestId: 'ws_CO_1', customerMessage: 'ok' })

    expect(f.calls[0]!.url).toBe('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials')
    expect((f.calls[0]!.init.headers as any).authorization).toBe('Basic ' + Buffer.from('key123:secret456').toString('base64'))
    expect(f.calls[1]!.url).toBe('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest')
    expect(f.calls[1]!.init.method).toBe('POST')
    expect((f.calls[1]!.init.headers as any).authorization).toBe('Bearer AT1')
    expect(f.calls[1]!.init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(f.calls[1]!.init.body as string)).toEqual({
      BusinessShortCode: '174379',
      Password: Buffer.from('174379pk20261005123015').toString('base64'),
      Timestamp: '20261005123015',
      TransactionType: 'CustomerPayBillOnline',
      Amount: 9600,
      PartyA: PHONE_NORM,
      PartyB: '174379',
      PhoneNumber: PHONE_NORM,
      CallBackURL: 'https://pos.example.com/api/mpesa/callback/tok_abcdefghijklmnop',
      AccountReference: 'BP1042-LONG-',
      TransactionDesc: 'Sale 1042 at '
    })

    await d.stkPush({ phone: PHONE_NORM, amountCents: 100, accountReference: 'BP1', description: 'x' })
    expect(f.calls).toHaveLength(3)
    expect(f.calls[2]!.url).toContain('/stkpush/')
  })

  it('uses the till number for Buy Goods and the production host', async () => {
    const f = fakeFetch([
      { status: 200, json: { access_token: 'AT', expires_in: '3599' } },
      { status: 200, json: { MerchantRequestID: 'M', CheckoutRequestID: 'C', ResponseCode: '0' } }
    ])
    const d = new DarajaClient({ ...cfg, mode: 'production', transactionType: 'CustomerBuyGoodsOnline', partyB: '5123456' }, f.fn, () => fixed)
    await d.stkPush({ phone: PHONE_NORM, amountCents: 500, accountReference: 'BP1', description: 'x' })
    expect(f.calls[1]!.url).toBe('https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest')
    const sent = JSON.parse(f.calls[1]!.init.body as string)
    expect(sent).toMatchObject({ TransactionType: 'CustomerBuyGoodsOnline', PartyB: '5123456', BusinessShortCode: '174379', Amount: 5 })
  })

  it('maps errors to mpesa_unavailable', async () => {
    const f = fakeFetch([
      { status: 200, json: { access_token: 'AT', expires_in: '3599' } },
      { status: 400, json: { errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid PhoneNumber' } }
    ])
    const d = new DarajaClient(cfg, f.fn, () => fixed)
    await expect(d.stkPush({ phone: PHONE_NORM, amountCents: 100, accountReference: 'a', description: 'b' })).rejects.toMatchObject({
      status: 502,
      code: 'mpesa_unavailable',
      message: expect.stringContaining('Invalid PhoneNumber')
    })

    const badKey = new DarajaClient(cfg, fakeFetch([{ status: 400, json: {} }]).fn)
    await expect(badKey.accessToken()).rejects.toMatchObject({ status: 502, code: 'mpesa_unavailable' })

    const noKeys = new DarajaClient({ ...cfg, consumerKey: '' })
    await expect(noKeys.accessToken()).rejects.toMatchObject({ code: 'mpesa_unavailable' })

    const slow = new DarajaClient({ ...cfg, timeoutMs: 30 }, (_url, init) =>
      new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    )
    await expect(slow.accessToken()).rejects.toMatchObject({ code: 'mpesa_unavailable', message: expect.stringContaining('in time') })
  })

  it('reads STK query answers', async () => {
    const f = fakeFetch([
      { status: 200, json: { access_token: 'AT', expires_in: '3599' } },
      { status: 500, json: { errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' } },
      { status: 200, json: { ResponseCode: '0', ResultCode: '1032', ResultDesc: 'Request cancelled by user' } }
    ])
    const d = new DarajaClient(cfg, f.fn, () => fixed)
    expect(await d.stkQuery('ws_CO_1')).toEqual({ state: 'pending' })
    expect(await d.stkQuery('ws_CO_1')).toEqual({ state: 'done', resultCode: 1032, resultDesc: 'Request cancelled by user' })
    expect(f.calls[1]!.url).toBe('https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query')
    expect(JSON.parse(f.calls[1]!.init.body as string)).toEqual({
      BusinessShortCode: '174379',
      Password: Buffer.from('174379pk20261005123015').toString('base64'),
      Timestamp: '20261005123015',
      CheckoutRequestID: 'ws_CO_1'
    })
  })

  it('a Daraja failure marks the request FAILED and returns 502', async () => {
    const f = fakeFetch([
      { status: 200, json: { access_token: 'AT', expires_in: '3599' } },
      { status: 503, json: { errorMessage: 'Service unavailable' } }
    ])
    setDaraja(new DarajaClient(cfg, f.fn))
    const sale = await makeSale()
    const c = await Client.login('cashier')
    const res = await c.post('/api/mpesa/stk', { saleId: sale.id, phone: PHONE })
    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('mpesa_unavailable')
    const req = await prisma.mpesaRequest.findFirstOrThrow({ where: { saleId: sale.id } })
    expect(req.status).toBe('FAILED')
    expect(req.resultDesc).toContain('Service unavailable')
    // a failed push does not block the next try
    setDaraja(null)
    expect((await c.post('/api/mpesa/stk', { saleId: sale.id, phone: PHONE })).status).toBe(200)
  })

  it('a query that cannot reach Daraja is a 502', async () => {
    const sale = await makeSale()
    const c = await Client.login('cashier')
    const r = (await c.post('/api/mpesa/stk', { saleId: sale.id, phone: PHONE })).body.request
    setDaraja(new DarajaClient(cfg, async () => {
      throw new Error('offline')
    }))
    const q = await c.post(`/api/mpesa/requests/${r.id}/query`)
    expect([q.status, q.body.error.code]).toEqual([502, 'mpesa_unavailable'])
  })
})

describe('realtime', () => {
  let srv: Awaited<ReturnType<typeof startServer>>
  beforeAll(async () => {
    srv = await startServer()
  })
  afterAll(async () => {
    await srv.stop()
  })

  it('mpesa:updated reaches the branch room only', async () => {
    const sale = await makeSale()
    const c = await Client.login('cashier')
    const west = await connectSocket(srv.url, (await Client.login('manager')).cookie)
    const kili = await connectSocket(srv.url, (await Client.login('kilicashier')).cookie)

    const got = nextEvent(west, 'mpesa:updated')
    const saleGot = nextEvent(west, 'sale:updated')
    const quiet = noEvent(kili, 'mpesa:updated')
    const res = await c.post('/api/mpesa/stk', { saleId: sale.id, phone: PHONE })
    expect((await got).request).toMatchObject({ id: res.body.request.id, status: 'PENDING' })
    expect((await saleGot).sale.id).toBe(sale.id)
    await quiet

    const paid = nextEvent(west, 'mpesa:updated')
    const stock = nextEvent(west, 'stock:updated')
    const quiet2 = noEvent(kili, 'mpesa:updated')
    await callback(await successFor(res.body.request.id))
    expect((await paid).request.status).toBe('SUCCESS')
    expect((await stock).productId).toBe(fx.products.whisky.id)
    await quiet2
    west.close()
    kili.close()
  })
})
