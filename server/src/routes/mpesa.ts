import { createHash, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import { prisma, type Prisma } from '../db.js'
import { env } from '../env.js'
import { assertRole, branchFor, requireRole, type Actor, type AppEnv } from '../middleware/auth.js'
import { AppError, conflict, notFound, unprocessable } from '../lib/errors.js'
import { body, id, phone, query } from '../lib/validate.js'
import { audit } from '../lib/audit.js'
import { darajaFor, rememberCheckout } from '../lib/daraja.js'
import { emitToBranch, Events } from '../realtime.js'
import { emitSale, lockSale, openShift } from '../rules/sale-core.js'
import {
  handleStkCallback,
  queryMpesaRequest,
  scheduleMockCallback,
  simulateOutcome,
  toRequestDTO
} from '../rules/mpesa.js'

export const mpesaRoutes = new Hono<AppEnv>()
export const mpesaCallbackRoutes = new Hono()

// Loads a request the actor may see, or 404.
async function requestForActor(actor: Actor, requestId: string) {
  const req = await prisma.mpesaRequest.findUnique({ where: { id: requestId } })
  if (!req || !actor.branchIds.includes(req.branchId)) throw notFound('M-Pesa request')
  return req
}

function emitRequest(req: Parameters<typeof toRequestDTO>[0]) {
  const dto = toRequestDTO(req)
  emitToBranch(req.branchId, Events.mpesaUpdated, { request: dto })
  return dto
}

// ---------- STK push ----------

const stkSchema = z.object({
  saleId: id,
  phone,
  amountCents: z.number().int().max(1_000_000_000).optional()
})

mpesaRoutes.post('/stk', async c => {
  const actor = c.get('actor')
  const input = await body(c, stkSchema)

  const found = await prisma.sale.findUnique({ where: { id: input.saleId }, select: { branchId: true } })
  if (!found || !actor.branchIds.includes(found.branchId)) throw notFound('Sale')

  const created = await prisma.$transaction(async tx => {
    await lockSale(tx, input.saleId)
    const sale = await tx.sale.findUniqueOrThrow({
      where: { id: input.saleId },
      include: { payments: { select: { amountCents: true } }, lines: { select: { id: true } } }
    })
    if (sale.status !== 'SAVED' && sale.status !== 'OPEN') {
      throw unprocessable(`Sale #${sale.number} is ${sale.status.toLowerCase()} and cannot take payments.`, 'sale_not_payable')
    }
    if (!sale.lines.length || sale.totalCents <= 0) throw unprocessable('Add items before taking payment.', 'sale_empty')

    const due = sale.totalCents - sale.payments.reduce((a, p) => a + p.amountCents, 0)
    const amount = input.amountCents ?? due
    if (amount <= 0) throw unprocessable('Amount must be more than zero.', 'bad_amount')
    if (amount > due) throw unprocessable(`Only KSh ${due / 100} is still due on this sale.`, 'overpayment')
    if (amount % 100 !== 0) {
      throw unprocessable('M-Pesa takes whole shillings only. Enter an amount without cents.', 'whole_shillings')
    }

    const pending = await tx.mpesaRequest.findFirst({ where: { saleId: sale.id, status: 'PENDING' } })
    if (pending) {
      throw conflict('A payment request is already waiting on a phone for this sale. Wait for it or cancel it first.', 'stk_pending')
    }

    const shift = await openShift(tx, actor.id, sale.branchId)
    const req = await tx.mpesaRequest.create({
      data: {
        saleId: sale.id,
        branchId: sale.branchId,
        phone: input.phone,
        amountCents: amount,
        requestedById: actor.id,
        shiftId: shift?.id ?? null
      }
    })
    await audit(tx, actor, 'mpesa.stk_requested', 'MpesaRequest', req.id, {
      saleId: sale.id,
      saleNumber: sale.number,
      amountCents: amount,
      phone: input.phone
    }, sale.branchId)
    return { req, saleNumber: sale.number }
  })

  // The network call happens outside the transaction so the sale is not
  // locked while we wait for Safaricom.
  let req = created.req
  try {
    // the shop's own Paybill or Till when it has one, else the server wide one
    const daraja = await darajaFor(actor.businessId)
    const sent = await daraja.stkPush({
      phone: req.phone,
      amountCents: req.amountCents,
      accountReference: `BP${created.saleNumber}`,
      description: `Sale ${created.saleNumber}`
    })
    req = await prisma.mpesaRequest.update({
      where: { id: req.id },
      data: { merchantRequestId: sent.merchantRequestId, checkoutRequestId: sent.checkoutRequestId }
    })
    rememberCheckout(sent.checkoutRequestId, daraja)
    scheduleMockCallback(sent.checkoutRequestId)
  } catch (err) {
    const message = err instanceof AppError ? err.message : 'Could not reach M-Pesa.'
    const failed = await prisma.$transaction(async tx => {
      const r = await tx.mpesaRequest.update({ where: { id: req.id }, data: { status: 'FAILED', resultDesc: message } })
      await audit(tx, actor, 'mpesa.stk_failed', 'MpesaRequest', r.id, { saleId: r.saleId, reason: message }, r.branchId)
      return r
    })
    emitRequest(failed)
    await emitSale(failed.saleId)
    if (err instanceof AppError) throw err
    throw new AppError(502, 'mpesa_unavailable', message)
  }

  const request = emitRequest(req)
  await emitSale(req.saleId)
  return c.json({ request })
})

// ---------- requests ----------

const listSchema = z.object({
  saleId: id.optional(),
  status: z.enum(['PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT']).optional(),
  branchId: id.optional()
})

mpesaRoutes.get('/requests', async c => {
  const q = query(c, listSchema)
  const branchId = branchFor(c, q.branchId)
  const where: Prisma.MpesaRequestWhereInput = { branchId }
  if (q.saleId) where.saleId = q.saleId
  if (q.status) where.status = q.status
  const rows = await prisma.mpesaRequest.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 })
  return c.json({ requests: rows.map(toRequestDTO) })
})

mpesaRoutes.get('/requests/:id', async c => {
  const req = await requestForActor(c.get('actor'), c.req.param('id'))
  return c.json({ request: toRequestDTO(req) })
})

mpesaRoutes.post('/requests/:id/query', async c => {
  const req = await requestForActor(c.get('actor'), c.req.param('id'))
  if (req.status !== 'PENDING') return c.json({ request: toRequestDTO(req) })
  const r = await queryMpesaRequest(req.id)
  return c.json({ request: r.request })
})

mpesaRoutes.post('/requests/:id/cancel', async c => {
  const actor = c.get('actor')
  const found = await requestForActor(actor, c.req.param('id'))
  const req = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "MpesaRequest" WHERE id = ${found.id} FOR UPDATE`
    const cur = await tx.mpesaRequest.findUniqueOrThrow({ where: { id: found.id } })
    if (cur.status !== 'PENDING') {
      throw conflict(`This request is already ${cur.status.toLowerCase()}.`, 'not_pending')
    }
    // resultCode stays null: we gave up, Safaricom did not answer. A late
    // success is still recorded.
    const r = await tx.mpesaRequest.update({
      where: { id: cur.id },
      data: { status: 'CANCELLED', resultDesc: 'Cancelled at the till' }
    })
    await audit(tx, actor, 'mpesa.till_cancelled', 'MpesaRequest', r.id, { saleId: r.saleId }, r.branchId)
    return r
  })
  const request = emitRequest(req)
  await emitSale(req.saleId)
  return c.json({ request })
})

const simulateSchema = z.object({ outcome: z.enum(['success', 'failed', 'cancelled']) })

mpesaRoutes.post('/requests/:id/simulate', async c => {
  const actor = c.get('actor')
  // the demo button exists only where this shop's M-Pesa is a simulation
  const mode = await darajaFor(actor.businessId).then(d => d.mode, () => null)
  if (mode !== 'mock') throw notFound()
  assertRole(actor, 'MANAGER')
  const req = await requestForActor(actor, c.req.param('id'))
  const input = await body(c, simulateSchema)
  const r = await simulateOutcome(req.id, input.outcome)
  return c.json({ request: r.request })
})

// ---------- manager check of typed codes ----------

mpesaRoutes.get('/unverified', requireRole('MANAGER'), async c => {
  const branchId = branchFor(c)
  const payments = await prisma.payment.findMany({
    where: { verification: 'MANUAL_UNVERIFIED', sale: { branchId } },
    include: { sale: { select: { number: true, branchId: true, totalCents: true, status: true } } },
    orderBy: { createdAt: 'asc' },
    take: 500
  })
  const userIds = [...new Set(payments.map(p => p.receivedById))]
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
  const names = new Map(users.map(u => [u.id, u.name]))
  return c.json({
    payments: payments.map(p => ({
      id: p.id,
      saleId: p.saleId,
      saleNumber: p.sale.number,
      saleStatus: p.sale.status,
      branchId: p.sale.branchId,
      amountCents: p.amountCents,
      mpesaRef: p.mpesaRef,
      phone: p.phone,
      receivedById: p.receivedById,
      receivedByName: names.get(p.receivedById) ?? null,
      shiftId: p.shiftId,
      createdAt: p.createdAt
    }))
  })
})

const verifySchema = z.object({
  ok: z.boolean(),
  note: z.string().trim().max(300).optional()
})

mpesaRoutes.post('/payments/:id/verify', requireRole('MANAGER'), async c => {
  const actor = c.get('actor')
  const input = await body(c, verifySchema)
  const payment = await prisma.payment.findUnique({
    where: { id: c.req.param('id') },
    include: { sale: { select: { branchId: true, number: true } } }
  })
  if (!payment || !actor.branchIds.includes(payment.sale.branchId)) throw notFound('Payment')
  if (payment.method !== 'MPESA') throw unprocessable('Only M-Pesa payments can be verified.', 'not_mpesa')

  const updated = await prisma.$transaction(async tx => {
    const verification = input.ok ? 'MANUAL_VERIFIED' : 'MANUAL_REJECTED'
    // conditional update, so two managers cannot both decide
    const res = await tx.payment.updateMany({
      where: { id: payment.id, verification: 'MANUAL_UNVERIFIED' },
      data: { verification, verifiedById: actor.id, verifiedAt: new Date() }
    })
    if (res.count !== 1) throw conflict('This payment has already been checked.', 'already_verified')
    await audit(tx, actor, input.ok ? 'mpesa.manual_verified' : 'mpesa.manual_rejected', 'Payment', payment.id, {
      saleId: payment.saleId,
      saleNumber: payment.sale.number,
      mpesaRef: payment.mpesaRef,
      amountCents: payment.amountCents,
      note: input.note ?? null
    }, payment.sale.branchId)
    return tx.payment.findUniqueOrThrow({ where: { id: payment.id } })
  })
  await emitSale(updated.saleId)
  return c.json({
    payment: {
      id: updated.id,
      saleId: updated.saleId,
      method: updated.method,
      amountCents: updated.amountCents,
      mpesaRef: updated.mpesaRef,
      phone: updated.phone,
      verification: updated.verification,
      verifiedById: updated.verifiedById,
      verifiedAt: updated.verifiedAt,
      receivedById: updated.receivedById,
      createdAt: updated.createdAt
    }
  })
})

// ---------- Safaricom callback (no session) ----------

const digest = (s: string) => createHash('sha256').update(s).digest()

function tokenMatches(given: string) {
  // hashing first gives equal lengths, which timingSafeEqual needs
  return timingSafeEqual(digest(given), digest(env.MPESA_CALLBACK_TOKEN))
}

const ACCEPTED = { ResultCode: 0, ResultDesc: 'Accepted' }

mpesaCallbackRoutes.post('/:token', async c => {
  if (!tokenMatches(c.req.param('token'))) {
    return c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404)
  }
  // From here on Safaricom always hears "Accepted", or it retries forever.
  // Processing is safe to repeat, so a lost answer costs nothing.
  try {
    let payload: unknown
    try {
      payload = await c.req.json()
    } catch {
      console.warn('mpesa callback: body is not JSON')
      return c.json(ACCEPTED)
    }
    await handleStkCallback(payload)
  } catch (err) {
    console.error('mpesa callback failed', err)
  }
  return c.json(ACCEPTED)
})
