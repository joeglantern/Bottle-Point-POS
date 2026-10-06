// What happens when Safaricom tells us how an STK push ended. The callback,
// the STK query, the mock and the sweeper all go through settleMpesaRequest(),
// so the rules live in one place and repeating an answer is always safe.

import { z } from 'zod'
import { prisma, Prisma, type MpesaRequest, type MpesaStatus, type Tx } from '../db.js'
import { env } from '../env.js'
import { audit } from '../lib/audit.js'
import { AppError } from '../lib/errors.js'
import { darajaForCheckout, fakeReceipt, findMockEntry, mockResult } from '../lib/daraja.js'
import { emitToBranch, Events } from '../realtime.js'
import { applyPayment, emitSale, emitStock } from './sale-core.js'

export const mpesaSettings = {
  // mock mode: delay before the fake callback, 0 or less turns it off
  mockDelayMs: env.MPESA_MOCK_DELAY_MS,
  // the sweeper asks Safaricom about requests older than this
  queryAfterMs: 60_000,
  // and gives up on them after this
  timeoutAfterMs: 3 * 60_000
}

export function toRequestDTO(r: MpesaRequest) {
  return {
    id: r.id,
    saleId: r.saleId,
    branchId: r.branchId,
    phone: r.phone,
    amountCents: r.amountCents,
    merchantRequestId: r.merchantRequestId,
    checkoutRequestId: r.checkoutRequestId,
    status: r.status,
    resultCode: r.resultCode,
    resultDesc: r.resultDesc,
    receipt: r.receipt,
    requestedById: r.requestedById,
    shiftId: r.shiftId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  }
}
export type MpesaRequestDTO = ReturnType<typeof toRequestDTO>

// A final (or not yet final) answer about one STK push, whatever its source.
// resultCode is null when we decided locally (till cancel, sweeper timeout).
export type StkOutcome =
  | { kind: 'pending' }
  | {
      kind: 'success'
      resultCode: number
      resultDesc: string
      receipt?: string | null
      amountCents?: number | null
      phone?: string | null
    }
  | { kind: 'failed' | 'cancelled' | 'timeout'; resultCode: number | null; resultDesc: string }

export function outcomeFromResult(
  resultCode: number,
  resultDesc: string,
  meta: { receipt?: string | null; amountCents?: number | null; phone?: string | null } = {}
): StkOutcome {
  if (resultCode === 0) return { kind: 'success', resultCode, resultDesc, ...meta }
  if (resultCode === 1032) return { kind: 'cancelled', resultCode, resultDesc: 'The customer cancelled the M-Pesa prompt.' }
  if (resultCode === 1037) return { kind: 'timeout', resultCode, resultDesc: 'The phone could not be reached. Check it is on and try again.' }
  if (resultCode === 2001) return { kind: 'failed', resultCode, resultDesc: 'The customer entered a wrong M-Pesa PIN.' }
  return { kind: 'failed', resultCode, resultDesc: resultDesc || 'M-Pesa did not complete the payment.' }
}

// ---------- Safaricom callback body ----------

const itemValue = z.union([z.string().max(200), z.number()]).optional()
export const stkCallbackSchema = z.object({
  Body: z.object({
    stkCallback: z.object({
      MerchantRequestID: z.string().max(100),
      CheckoutRequestID: z.string().min(1).max(100),
      ResultCode: z.union([z.number().int(), z.string().regex(/^\d+$/).transform(Number)]),
      ResultDesc: z.string().max(500),
      CallbackMetadata: z
        .object({ Item: z.array(z.object({ Name: z.string().max(100), Value: itemValue })).max(50) })
        .optional()
    })
  })
})
export type StkCallbackBody = z.input<typeof stkCallbackSchema>

function metaValue(items: { Name: string; Value?: string | number }[], name: string) {
  return items.find(i => i.Name === name)?.Value
}

function amountToCents(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

// Parses a callback body and settles the matching request. Never throws on
// bad input: Safaricom only needs to hear "Accepted".
export async function handleStkCallback(payload: unknown) {
  const parsed = stkCallbackSchema.safeParse(payload)
  if (!parsed.success) {
    console.warn('mpesa callback: body not understood', z.flattenError(parsed.error).fieldErrors)
    return { handled: false as const, reason: 'bad_body' }
  }
  const cb = parsed.data.Body.stkCallback
  const req = await prisma.mpesaRequest.findUnique({ where: { checkoutRequestId: cb.CheckoutRequestID } })
  if (!req) {
    console.warn('mpesa callback: unknown CheckoutRequestID', cb.CheckoutRequestID)
    return { handled: false as const, reason: 'unknown_request' }
  }
  const items = cb.CallbackMetadata?.Item ?? []
  const receipt = metaValue(items, 'MpesaReceiptNumber')
  const phone = metaValue(items, 'PhoneNumber')
  const outcome = outcomeFromResult(cb.ResultCode, cb.ResultDesc, {
    receipt: receipt != null ? String(receipt).trim().toUpperCase() : null,
    amountCents: amountToCents(metaValue(items, 'Amount')),
    phone: phone != null ? String(phone) : null
  })
  const res = await settleMpesaRequest(req.id, outcome, payload)
  return { handled: true as const, ...res }
}

// ---------- settling ----------

async function lockRequest(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM "MpesaRequest" WHERE id = ${id} FOR UPDATE`
  return tx.mpesaRequest.findUniqueOrThrow({ where: { id }, include: { sale: { select: { number: true } } } })
}

// A request we closed ourselves (till cancel, sweeper timeout) may still get a
// late success from Safaricom. The money is real, so it must be recorded.
function canSettle(req: MpesaRequest, outcome: StkOutcome) {
  if (req.status === 'PENDING') return true
  return outcome.kind === 'success' && req.resultCode == null && (req.status === 'CANCELLED' || req.status === 'TIMEOUT')
}

const shillings = (cents: number) => `KSh ${(cents / 100).toLocaleString('en-KE')}`

// Errors from applyPayment that mean "this money cannot go on this sale".
function isRefusal(err: unknown) {
  if (err instanceof AppError) return err.status === 409 || err.status === 422
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}

export type SettleResult = {
  request: MpesaRequestDTO
  changed: boolean
  paid: boolean
  unlinked: boolean
}

export async function settleMpesaRequest(requestId: string, outcome: StkOutcome, raw?: unknown): Promise<SettleResult> {
  const rawJson = raw === undefined ? undefined : (raw as Prisma.InputJsonValue)
  let stock: { branchId: string; productIds: string[] } | null = null
  let paid = false
  let unlinked = false

  const settle = async (): Promise<{ req: MpesaRequest; changed: boolean }> => {
    try {
      return await prisma.$transaction(async tx => {
        const req = await lockRequest(tx, requestId)
        if (outcome.kind === 'pending' || !canSettle(req, outcome)) return { req, changed: false }
        const ctx = { requestId: req.id, saleId: req.saleId, saleNumber: req.sale.number }

        if (outcome.kind !== 'success') {
          const status: MpesaStatus = outcome.kind === 'failed' ? 'FAILED' : outcome.kind === 'cancelled' ? 'CANCELLED' : 'TIMEOUT'
          const updated = await tx.mpesaRequest.update({
            where: { id: req.id },
            data: { status, resultCode: outcome.resultCode, resultDesc: outcome.resultDesc, rawCallback: rawJson }
          })
          await audit(tx, null, `mpesa.${outcome.kind}`, 'MpesaRequest', req.id, { ...ctx, resultCode: outcome.resultCode, resultDesc: outcome.resultDesc }, req.branchId)
          return { req: updated, changed: true }
        }

        if (!outcome.receipt) {
          // The STK query says paid but never includes the receipt. Wait for
          // the callback, and keep the sweeper from timing it out.
          if (req.status !== 'PENDING' || req.resultCode === 0) return { req, changed: false }
          const updated = await tx.mpesaRequest.update({
            where: { id: req.id },
            data: { resultCode: 0, resultDesc: 'Safaricom confirmed the payment. Waiting for the receipt.' }
          })
          return { req: updated, changed: true }
        }

        if (outcome.amountCents != null && outcome.amountCents !== req.amountCents) {
          const desc =
            `Safaricom reported ${shillings(outcome.amountCents)} (receipt ${outcome.receipt}) but ${shillings(req.amountCents)} was requested. ` +
            'No payment was recorded. A manager must check this.'
          const updated = await tx.mpesaRequest.update({
            where: { id: req.id },
            data: { status: 'FAILED', resultCode: outcome.resultCode, resultDesc: desc, rawCallback: rawJson }
          })
          await audit(tx, null, 'mpesa.amount_mismatch', 'MpesaRequest', req.id, {
            ...ctx,
            requestedCents: req.amountCents,
            reportedCents: outcome.amountCents,
            receipt: outcome.receipt
          }, req.branchId)
          return { req: updated, changed: true }
        }

        const wasClosed = req.status !== 'PENDING'
        const updated = await tx.mpesaRequest.update({
          where: { id: req.id },
          data: {
            status: 'SUCCESS',
            resultCode: outcome.resultCode,
            resultDesc: wasClosed ? 'Paid after it was closed at the till. The money was added to the sale.' : 'Paid.',
            receipt: outcome.receipt,
            rawCallback: rawJson
          }
        })
        const pay = await applyPayment(tx, {
          saleId: req.saleId,
          method: 'MPESA',
          amountCents: req.amountCents,
          mpesaRef: outcome.receipt,
          phone: outcome.phone ?? req.phone,
          verification: 'STK_CONFIRMED',
          mpesaRequestId: req.id,
          receivedById: req.requestedById,
          shiftId: req.shiftId
        })
        await audit(tx, null, 'mpesa.paid', 'MpesaRequest', req.id, {
          ...ctx,
          paymentId: pay.payment.id,
          amountCents: req.amountCents,
          receipt: outcome.receipt,
          late: wasClosed,
          salePaid: pay.paid
        }, req.branchId)
        paid = pay.paid
        if (pay.paid) stock = { branchId: pay.branchId, productIds: pay.productIds }
        return { req: updated, changed: true }
      })
    } catch (err) {
      if (outcome.kind !== 'success' || !outcome.receipt || !isRefusal(err)) throw err
      return keepUnlinked(requestId, outcome as Extract<StkOutcome, { kind: 'success' }>, rawJson, err)
    }
  }

  const keepUnlinked = async (
    id: string,
    o: Extract<StkOutcome, { kind: 'success' }>,
    rawData: Prisma.InputJsonValue | undefined,
    err: unknown
  ) =>
    prisma.$transaction(async tx => {
      const req = await lockRequest(tx, id)
      if (!canSettle(req, o)) return { req, changed: false }
      const receipt = o.receipt!
      const ctx = { requestId: req.id, saleId: req.saleId, saleNumber: req.sale.number, receipt, amountCents: req.amountCents }

      // The cashier already typed this very code for this sale. Safaricom has
      // now confirmed it, so the typed payment becomes a confirmed one.
      const existing = await tx.payment.findUnique({ where: { mpesaRef: receipt } })
      if (
        existing &&
        existing.saleId === req.saleId &&
        existing.amountCents === req.amountCents &&
        existing.mpesaRequestId == null &&
        existing.verification === 'MANUAL_UNVERIFIED'
      ) {
        await tx.payment.update({
          where: { id: existing.id },
          data: { verification: 'STK_CONFIRMED', mpesaRequestId: req.id, verifiedAt: new Date() }
        })
        const updated = await tx.mpesaRequest.update({
          where: { id: req.id },
          data: {
            status: 'SUCCESS',
            resultCode: o.resultCode,
            receipt,
            resultDesc: 'Paid. The code had already been typed at the till and is now confirmed by Safaricom.',
            rawCallback: rawData
          }
        })
        await audit(tx, null, 'mpesa.manual_confirmed', 'Payment', existing.id, ctx, req.branchId)
        return { req: updated, changed: true }
      }

      const receiptTaken = await tx.mpesaRequest.findFirst({ where: { receipt, id: { not: req.id } }, select: { id: true } })
      const why = err instanceof AppError ? err.message : 'This M-Pesa code is already linked to another sale.'
      const updated = await tx.mpesaRequest.update({
        where: { id: req.id },
        data: {
          status: 'SUCCESS',
          resultCode: o.resultCode,
          receipt: receiptTaken ? null : receipt,
          resultDesc:
            `Money received (receipt ${receipt}, ${shillings(req.amountCents)}) but it could not be added to sale #${req.sale.number}. ` +
            `${why} A manager must sort this out.`,
          rawCallback: rawData
        }
      })
      await audit(tx, null, 'mpesa.unlinked_payment', 'MpesaRequest', req.id, {
        ...ctx,
        reason: why,
        code: err instanceof AppError ? err.code : 'mpesa_code_used'
      }, req.branchId)
      unlinked = true
      return { req: updated, changed: true }
    })

  const { req, changed } = await settle()
  const dto = toRequestDTO(req)
  if (changed) {
    emitToBranch(req.branchId, Events.mpesaUpdated, { request: dto })
    await emitSale(req.saleId)
    const s = stock as { branchId: string; productIds: string[] } | null
    if (s) await emitStock(s.branchId, s.productIds)
  }
  return { request: dto, changed, paid, unlinked }
}

// ---------- asking Safaricom ----------

// STK query for one request, settled through the same rules as a callback.
export async function queryMpesaRequest(requestId: string) {
  const req = await prisma.mpesaRequest.findUniqueOrThrow({ where: { id: requestId } })
  if (req.status !== 'PENDING' || !req.checkoutRequestId) return { request: toRequestDTO(req), changed: false, paid: false, unlinked: false }
  // asked with the settings of the business that sent it
  const daraja = await darajaForCheckout(req.checkoutRequestId, req.branchId)
  const r = await daraja.stkQuery(req.checkoutRequestId)
  if (r.state === 'pending') return { request: toRequestDTO(req), changed: false, paid: false, unlinked: false }
  const meta = { receipt: r.receipt ?? null, amountCents: r.amountCents ?? null, phone: r.phone ?? null }
  return settleMpesaRequest(req.id, outcomeFromResult(r.resultCode, r.resultDesc, meta), { stkQuery: r })
}

// ---------- mock Safaricom ----------

// Builds the body the real Safaricom would post.
export function buildStkCallback(input: {
  merchantRequestId: string
  checkoutRequestId: string
  resultCode: number
  resultDesc: string
  receipt?: string
  amountCents?: number
  phone?: string
  at?: Date
}): StkCallbackBody {
  const cb: StkCallbackBody['Body']['stkCallback'] = {
    MerchantRequestID: input.merchantRequestId,
    CheckoutRequestID: input.checkoutRequestId,
    ResultCode: input.resultCode,
    ResultDesc: input.resultDesc
  }
  if (input.resultCode === 0 && input.receipt) {
    const at = input.at ?? new Date()
    const ts = new Date(at.getTime() + 3 * 3600_000).toISOString().replace(/\D/g, '').slice(0, 14)
    cb.CallbackMetadata = {
      Item: [
        { Name: 'Amount', Value: (input.amountCents ?? 0) / 100 },
        { Name: 'MpesaReceiptNumber', Value: input.receipt },
        { Name: 'Balance' },
        { Name: 'TransactionDate', Value: Number(ts) },
        { Name: 'PhoneNumber', Value: Number(input.phone ?? 0) }
      ]
    }
  }
  return { Body: { stkCallback: cb } }
}

// Plays the answer the mock planned for this checkout (from the phone ending).
export async function runMockCallback(checkoutRequestId: string) {
  const entry = findMockEntry(checkoutRequestId)
  if (!entry || entry.plan.outcome === 'never') return null
  const r = mockResult(entry)
  return handleStkCallback(
    buildStkCallback({ merchantRequestId: entry.merchantRequestId, checkoutRequestId, ...r })
  )
}

export function scheduleMockCallback(checkoutRequestId: string) {
  // only checkouts a mock client sent have a planned answer
  if (!findMockEntry(checkoutRequestId) || mpesaSettings.mockDelayMs <= 0) return
  const t = setTimeout(() => {
    runMockCallback(checkoutRequestId).catch(err => console.error('mpesa mock callback failed', err))
  }, mpesaSettings.mockDelayMs)
  t.unref?.()
}

// Demo button: force an outcome for a pending mock request.
export async function simulateOutcome(requestId: string, outcome: 'success' | 'failed' | 'cancelled') {
  const req = await prisma.mpesaRequest.findUniqueOrThrow({ where: { id: requestId } })
  const entry = req.checkoutRequestId ? findMockEntry(req.checkoutRequestId) : undefined
  const receipt = entry?.plan.outcome === 'success' ? entry.plan.receipt : fakeReceipt()
  const r =
    outcome === 'success'
      ? { resultCode: 0, resultDesc: 'The service request is processed successfully.', receipt, amountCents: req.amountCents, phone: req.phone }
      : outcome === 'cancelled'
        ? { resultCode: 1032, resultDesc: 'Request cancelled by user.' }
        : { resultCode: 1, resultDesc: 'The balance is insufficient for the transaction.' }
  const payload = buildStkCallback({
    merchantRequestId: req.merchantRequestId ?? 'mock',
    checkoutRequestId: req.checkoutRequestId ?? req.id,
    ...r
  })
  const parsed = stkCallbackSchema.parse(payload).Body.stkCallback
  const items = parsed.CallbackMetadata?.Item ?? []
  return settleMpesaRequest(
    req.id,
    outcomeFromResult(parsed.ResultCode, parsed.ResultDesc, {
      receipt: (metaValue(items, 'MpesaReceiptNumber') as string | undefined) ?? null,
      amountCents: amountToCents(metaValue(items, 'Amount')),
      phone: req.phone
    }),
    payload
  )
}

// ---------- sweeper ----------

// Asks Safaricom about requests that have waited a minute, and gives up on
// those with no answer after three minutes. Safe to run on several servers.
export async function sweepMpesa(now = new Date()) {
  const queryBefore = new Date(now.getTime() - mpesaSettings.queryAfterMs)
  const timeoutBefore = new Date(now.getTime() - mpesaSettings.timeoutAfterMs)
  const stale = await prisma.mpesaRequest.findMany({
    where: { status: 'PENDING', createdAt: { lt: queryBefore } },
    orderBy: { createdAt: 'asc' },
    take: 100
  })
  let settled = 0
  let timedOut = 0
  for (const req of stale) {
    let still = true
    // Confirmed by an earlier query: only the receipt is missing, keep waiting.
    if (req.resultCode === 0) continue
    try {
      const r = await queryMpesaRequest(req.id)
      if (r.changed && r.request.status !== 'PENDING') {
        still = false
        settled++
      } else if (r.request.resultCode === 0) {
        still = false
      }
    } catch (err) {
      console.warn('mpesa sweep: query failed for', req.id, (err as Error).message)
    }
    if (still && req.createdAt < timeoutBefore) {
      const r = await settleMpesaRequest(req.id, {
        kind: 'timeout',
        resultCode: null,
        resultDesc: 'No answer from M-Pesa in time. If the customer was charged, the payment will still be added when Safaricom confirms it.'
      })
      if (r.changed) timedOut++
    }
  }
  return { checked: stale.length, settled, timedOut }
}

export function startMpesaSweeper(everyMs = 30_000) {
  let running = false
  const t = setInterval(() => {
    if (running) return
    running = true
    sweepMpesa()
      .catch(err => console.error('mpesa sweep failed', err))
      .finally(() => {
        running = false
      })
  }, everyMs)
  t.unref?.()
  return () => clearInterval(t)
}
