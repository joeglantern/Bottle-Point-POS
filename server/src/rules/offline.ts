// Sales made on a till without internet, arriving when the connection is back.
//
// The rules, in order of importance:
//   1. Nothing is ever recorded twice. Every item carries an id made on the
//      till (opId), and every sale, payment and shift its own clientId. An item
//      already handled gets the answer it got the first time.
//   2. A sale is never refused because of what happened while the till was
//      offline. The money has changed hands, so it is recorded, and anything
//      unusual (cash after the shift was counted, an M-Pesa code already used,
//      a tab paid on two tills) becomes an OfflineIssue for a manager.
//   3. Only items that cannot be true are refused: a product, person or branch
//      of another business, a malformed item. The till keeps those and shows
//      them, so they are never silently lost either.
//
// Each item is one transaction: it lands completely or not at all.

import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { prisma, Prisma, type Device, type Tx } from '../db.js'
import { AppError } from '../lib/errors.js'
import { audit } from '../lib/audit.js'
import { cents, id, mpesaCode, phone, positiveCents } from '../lib/validate.js'
import { applyPayment, emitSale, emitStock, lockSale, recomputeTotals } from './sale-core.js'
import { isEditable, MAX_QTY } from './sales.js'
import { emitToBranch, Events } from '../realtime.js'

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
export const newDeviceToken = () => randomBytes(32).toString('base64url')

const uuid = z.uuid()
const when = z.iso.datetime()

const paymentIn = z
  .object({
    clientId: uuid,
    method: z.enum(['CASH', 'MPESA']),
    amountCents: positiveCents,
    tenderedCents: positiveCents.nullish(),
    mpesaRef: mpesaCode.nullish(),
    phone: phone.nullish(),
    receivedById: id,
    at: when,
    // the shift the cash went into: a server id, or one opened offline
    shiftId: id.nullish(),
    shiftClientId: uuid.nullish()
  })
  // an M-Pesa payment without its code is allowed: the shop may not require one
type PaymentIn = z.infer<typeof paymentIn>

const lineIn = z.object({
  productId: id,
  name: z.string().trim().min(1).max(160),
  unitCents: z.number().int().min(0).max(1_000_000_000),
  qty: z.number().int().min(1).max(MAX_QTY)
})

const shiftOp = z.object({
  opId: uuid,
  type: z.literal('shift_open'),
  clientId: uuid,
  branchId: id,
  userId: id,
  openingFloatCents: cents,
  at: when
})

// A sale made on this till while offline: its whole state, lines and payments.
const saleOp = z.object({
  opId: uuid,
  type: z.literal('sale'),
  clientId: uuid,
  offlineRef: z.string().regex(/^T\d{1,4}-\d{1,8}$/),
  branchId: id,
  createdById: id,
  createdAt: when,
  label: z.string().trim().max(60).nullish(),
  customerId: id.nullish(),
  lines: z.array(lineIn).min(1).max(200),
  payments: z.array(paymentIn).max(4)
})

// Payment taken offline for a tab that already existed on the server.
const payOp = z.object({
  opId: uuid,
  type: z.literal('pay'),
  saleId: id,
  seenTotalCents: z.number().int().min(0),
  payments: z.array(paymentIn).min(1).max(4)
})

export const opSchema = z.discriminatedUnion('type', [shiftOp, saleOp, payOp])
export type Op = z.infer<typeof opSchema>
export const MAX_OPS = 25

export type OpResult = {
  opId: string | null
  status: 'ok' | 'rejected' | 'retry'
  message?: string
  sale?: { id: string; number: number; status: string; offlineRef: string | null }
  shift?: { id: string }
}

// A permanent refusal: sending it again would never work.
class Rejected extends Error {}

type Issue = { kind: string; message: string; saleId?: string | null; data?: Record<string, unknown> }
type Effects = { saleId?: string; branchId?: string; paid?: boolean; productIds?: string[]; issues: number }

const ksh = (c: number) => `KSh ${(c / 100).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`
const FUTURE_SLACK_MS = 5 * 60_000
const OLD_MS = 30 * 24 * 60 * 60_000

// The till's clock decides when a sale happened, unless it is clearly wrong.
function timeOf(at: string, now: Date, issues: Issue[], what: string) {
  const t = new Date(at)
  if (t.getTime() > now.getTime() + FUTURE_SLACK_MS) {
    issues.push({ kind: 'clock_ahead', message: `The till's clock was ahead: ${what} was dated ${t.toISOString()}. It was recorded at the time it synced instead. Check the date and time on that till.` })
    return now
  }
  if (now.getTime() - t.getTime() > OLD_MS) {
    issues.push({ kind: 'old_sale', message: `${what} was made more than 30 days before it synced (${t.toISOString()}). Check that it is real.` })
  }
  return t
}

// Someone named on an offline item must work for this business. A person
// switched off or moved meanwhile is still recorded, and flagged.
async function staffOf(tx: Tx, device: Device, userId: string, branchId: string, issues: Issue[]) {
  const [user, branch] = await Promise.all([
    tx.user.findUnique({ where: { id: userId }, include: { branches: { where: { branchId } } } }),
    tx.branch.findUnique({ where: { id: branchId }, select: { businessId: true } })
  ])
  if (!branch || branch.businessId !== device.businessId) throw new Rejected('That branch is not part of this business.')
  if (!user || user.businessId !== device.businessId) throw new Rejected('That staff member is not part of this business.')
  if (!user.active) issues.push({ kind: 'staff_inactive', message: `${user.name}'s account was switched off when this offline sale synced.` })
  else if (user.role !== 'OWNER' && !user.branches.length) issues.push({ kind: 'staff_branch', message: `${user.name} no longer has access to this branch.` })
  // offline, only people who signed in on this till with internet can sign in
  const seen = await tx.deviceUser.findUnique({ where: { deviceId_userId: { deviceId: device.id, userId } } })
  if (!seen) {
    issues.push({ kind: 'not_seen_on_till', message: `This offline sale names ${user.name}, who had not signed in on till ${device.code} with internet before. Check it was really them.` })
  }
  return user
}

async function resolveShift(tx: Tx, p: PaymentIn) {
  if (p.shiftId) return tx.shift.findUnique({ where: { id: p.shiftId } })
  if (!p.shiftClientId) return null
  const own = await tx.shift.findUnique({ where: { clientId: p.shiftClientId } })
  if (own) return own
  // a shift opened offline that was merged into one already open
  const merged = await tx.offlineOp.findUnique({ where: { refClientId: p.shiftClientId } })
  return merged?.refId ? tx.shift.findUnique({ where: { id: merged.refId } }) : null
}

// Applies offline payments to a sale, one by one. Anything that cannot be
// applied is described for a manager instead of failing the whole item.
async function applyOfflinePayments(tx: Tx, device: Device, saleId: string, payments: PaymentIn[], issues: Issue[], now: Date) {
  let paid = false
  for (const p of payments) {
    if (await tx.payment.findUnique({ where: { clientId: p.clientId }, select: { id: true } })) continue
    const sale = await tx.sale.findUniqueOrThrow({ where: { id: saleId }, include: { payments: true, lines: true } })
    const user = await staffOf(tx, device, p.receivedById, sale.branchId, issues)
    const at = timeOf(p.at, now, issues, `A payment on sale #${sale.number}`)
    const what = `${p.method === 'CASH' ? 'cash' : `M-Pesa code ${p.mpesaRef}`} of ${ksh(p.amountCents)}`
    const data = { payment: p, deviceCode: device.code }

    if (!isEditable(sale.status)) {
      issues.push({
        kind: 'already_paid',
        message: `Till ${device.code} took ${what} for sale #${sale.number} while offline, but the sale was already ${sale.status.toLowerCase()}. The customer may have paid twice: check and refund if so.`,
        data
      })
      continue
    }
    const due = sale.totalCents - sale.payments.reduce((a, x) => a + x.amountCents, 0)
    if (p.amountCents > due) {
      issues.push({
        kind: 'overpaid',
        message: `Till ${device.code} took ${what} for sale #${sale.number} while offline, but only ${ksh(due)} was still due. Check the sale and refund the difference.`,
        data
      })
      continue
    }
    if (p.method === 'MPESA' && p.mpesaRef) {
      const used = await tx.payment.findUnique({ where: { mpesaRef: p.mpesaRef }, include: { sale: { select: { number: true } } } })
      if (used) {
        issues.push({
          kind: 'mpesa_code_used',
          message: `M-Pesa code ${p.mpesaRef} (${ksh(p.amountCents)}) was typed for sale #${sale.number} on till ${device.code} while offline, but it is already linked to sale #${used.sale.number}. Sale #${sale.number} stays unpaid until you check the M-Pesa statement.`,
          data
        })
        continue
      }
    }

    const shift = await resolveShift(tx, p)
    // cash only ever counts in the shift of the person who took it
    const ownShift = shift && shift.branchId === sale.branchId && shift.userId === user.id
    if (shift && !ownShift && p.method === 'CASH') {
      issues.push({ kind: 'shift_other_person', message: `${ksh(p.amountCents)} cash for sale #${sale.number} taken by ${user.name} on till ${device.code} named a shift that is not theirs. It was not added to any shift's count.`, data })
    }
    const shiftId = ownShift ? shift.id : null
    if (p.method === 'CASH') {
      if (!shiftId) {
        issues.push({ kind: 'cash_no_shift', message: `${ksh(p.amountCents)} cash for sale #${sale.number} was taken on till ${device.code} by ${user.name} while offline, with no shift to count it in. Add it to the drawer count.`, data })
      } else if (shift!.closedAt) {
        issues.push({
          kind: 'cash_after_close',
          message: `${ksh(p.amountCents)} cash for sale #${sale.number} was taken on till ${device.code} while offline and arrived after ${user.name}'s shift was counted and closed. It is not in that count, so the drawer should have been over by this amount.`,
          data
        })
      }
    }

    const tendered = p.method === 'CASH' && p.tenderedCents != null && p.tenderedCents >= p.amountCents ? p.tenderedCents : null
    const r = await applyPayment(tx, {
      saleId,
      method: p.method,
      amountCents: p.amountCents,
      tenderedCents: tendered,
      mpesaRef: p.method === 'MPESA' ? p.mpesaRef : null,
      phone: p.phone ?? null,
      verification: p.method === 'CASH' ? 'CASH' : 'MANUAL_UNVERIFIED',
      receivedById: user.id,
      shiftId,
      clientId: p.clientId,
      at,
      allowClosedShift: true
    })
    paid = r.paid
  }
  return paid
}

// A shop that tracks stock cannot sell what is not there, except offline: the
// till could not check. The sale stands; the shelf needs a count.
async function flagNegativeStock(tx: Tx, device: Device, branchId: string, productIds: string[], issues: Issue[], what: string) {
  const biz = await tx.business.findUnique({ where: { id: device.businessId }, select: { trackStock: true } })
  if (!biz?.trackStock) return
  const below = await tx.stock.findMany({ where: { branchId, productId: { in: productIds }, qty: { lt: 0 } }, include: { product: { select: { name: true } } } })
  if (!below.length) return
  issues.push({
    kind: 'sold_without_stock',
    message: `${what} sold more than the records showed in stock: ${below.map(x => `${x.product.name} is now ${x.qty}`).join(', ')}. Count the shelf (Inventory, Count).`
  })
}

async function saveIssues(tx: Tx, device: Device, branchId: string, saleId: string | null, all: Issue[]) {
  // the same note once, even when it applies to several payments
  const issues = all.filter((i, n) => all.findIndex(j => j.kind === i.kind && j.message === i.message) === n)
  if (!issues.length) return
  await tx.offlineIssue.createMany({
    data: issues.map(i => ({
      businessId: device.businessId,
      branchId,
      deviceId: device.id,
      saleId: i.saleId ?? saleId,
      kind: i.kind,
      message: i.message,
      data: (i.data ?? undefined) as never
    }))
  })
}

const sameLines = (a: { productId: string; qty: number }[], b: { productId: string; qty: number }[]) =>
  JSON.stringify([...a].map(l => [l.productId, l.qty]).sort()) === JSON.stringify([...b].map(l => [l.productId, l.qty]).sort())

// The same product twice on one offline sale becomes one line.
function mergeOfflineLines(lines: z.infer<typeof lineIn>[]) {
  const out = new Map<string, z.infer<typeof lineIn>>()
  for (const l of lines) {
    const had = out.get(l.productId)
    if (had) had.qty = Math.min(MAX_QTY, had.qty + l.qty)
    else out.set(l.productId, { ...l })
  }
  return [...out.values()]
}

const actorFor = (device: Device, userId: string) => ({ id: userId, businessId: device.businessId }) as never

async function runShift(tx: Tx, device: Device, op: z.infer<typeof shiftOp>, now: Date) {
  const issues: Issue[] = []
  await staffOf(tx, device, op.userId, op.branchId, issues)
  let shift = await tx.shift.findUnique({ where: { clientId: op.clientId } })
  let merged = false
  if (!shift) {
    const open = await tx.shift.findFirst({ where: { userId: op.userId, branchId: op.branchId, closedAt: null } })
    if (open) {
      shift = open
      merged = true
      issues.push({
        kind: 'shift_merged',
        message: `A shift was opened on till ${device.code} while offline with a float of ${ksh(op.openingFloatCents)}, but this person already had a shift open since ${open.openedAt.toISOString()}. Its sales were added to the open shift. Check the float in the drawer.`
      })
    } else {
      shift = await tx.shift.create({
        data: { branchId: op.branchId, userId: op.userId, openingFloatCents: op.openingFloatCents, openedAt: timeOf(op.at, now, issues, 'A shift'), clientId: op.clientId }
      })
      await audit(tx, actorFor(device, op.userId), 'shift.open', 'shift', shift.id, { openingFloatCents: op.openingFloatCents, offline: true, device: device.code }, op.branchId)
    }
  }
  await saveIssues(tx, device, op.branchId, null, issues)
  const result: OpResult = { opId: op.opId, status: 'ok', shift: { id: shift.id } }
  await tx.offlineOp.create({ data: { opId: op.opId, deviceId: device.id, kind: op.type, refClientId: merged ? op.clientId : null, refId: shift.id, result: result as never } })
  return { result, effects: { branchId: op.branchId, issues: issues.length } satisfies Effects }
}

async function runSale(tx: Tx, device: Device, op: z.infer<typeof saleOp>, now: Date) {
  if (!op.offlineRef.startsWith(device.code + '-')) throw new Rejected('That receipt number belongs to another till.')
  const issues: Issue[] = []
  const creator = await staffOf(tx, device, op.createdById, op.branchId, issues)
  const lines = mergeOfflineLines(op.lines)
  const products = await tx.product.findMany({ where: { id: { in: lines.map(l => l.productId) }, businessId: device.businessId }, select: { id: true, priceCents: true } })
  if (products.length !== lines.length) throw new Rejected('One of the products is not part of this business.')
  const createdAt = timeOf(op.createdAt, now, issues, `Offline sale ${op.offlineRef}`)
  const subtotal = lines.reduce((a, l) => a + l.unitCents * l.qty, 0)
  // a customer picked from the till's list; one that is not this shop's is dropped
  const customer = op.customerId ? await tx.customer.findFirst({ where: { id: op.customerId, businessId: device.businessId }, select: { id: true } }) : null

  let sale = await tx.sale.findUnique({ where: { clientId: op.clientId }, include: { lines: true, payments: true } })
  if (sale) {
    // made online first (the reply was lost), then finished offline
    if (sale.branchId !== op.branchId) throw new Rejected('This sale belongs to another branch.')
    await lockSale(tx, sale.id)
    sale = await tx.sale.findUniqueOrThrow({ where: { id: sale.id }, include: { lines: true, payments: true } })
    if (isEditable(sale.status) && !sale.payments.length && !sameLines(sale.lines, lines)) {
      await tx.saleLine.deleteMany({ where: { saleId: sale.id } })
      await tx.saleLine.createMany({ data: lines.map(l => ({ saleId: sale!.id, productId: l.productId, name: l.name, unitCents: l.unitCents, qty: l.qty })) })
      await recomputeTotals(tx, sale.id)
      await audit(tx, actorFor(device, creator.id), 'sale.lines', 'sale', sale.id, { offline: true, device: device.code, after: lines.map(l => ({ productId: l.productId, qty: l.qty })) }, sale.branchId)
    }
    if (!sale.offlineRef) {
      await tx.sale.update({ where: { id: sale.id }, data: { deviceId: device.id, offlineRef: op.offlineRef, syncedAt: now } })
    }
  } else {
    const branch = await tx.branch.update({ where: { id: op.branchId }, data: { nextSaleNo: { increment: 1 } } })
    const number = branch.nextSaleNo - 1
    const created = await tx.sale.create({
      data: {
        number,
        branchId: op.branchId,
        createdById: creator.id,
        label: op.label || null,
        customerId: customer?.id ?? null,
        status: 'SAVED',
        subtotalCents: subtotal,
        totalCents: subtotal,
        clientId: op.clientId,
        deviceId: device.id,
        offlineRef: op.offlineRef,
        syncedAt: now,
        createdAt,
        lines: { create: lines.map(l => ({ productId: l.productId, name: l.name, unitCents: l.unitCents, qty: l.qty })) }
      }
    })
    await audit(tx, actorFor(device, creator.id), 'sale.create', 'sale', created.id, { number, totalCents: subtotal, lines: lines.length, offline: true, device: device.code, offlineRef: op.offlineRef }, op.branchId)
    sale = await tx.sale.findUniqueOrThrow({ where: { id: created.id }, include: { lines: true, payments: true } })
  }

  // a price lower than the catalog's is worth a look; higher is a price rise
  const price = new Map(products.map(p => [p.id, p.priceCents]))
  const cheaper = lines.filter(l => l.unitCents < (price.get(l.productId) ?? 0))
  if (cheaper.length) {
    issues.push({
      kind: 'price_below_catalog',
      message: `Offline sale ${op.offlineRef} (#${sale.number}) sold ${cheaper.map(l => `${l.name} at ${ksh(l.unitCents)} (catalog ${ksh(price.get(l.productId)!)})`).join(', ')}. Usually a price changed while the till was offline.`
    })
  }

  const paid = await applyOfflinePayments(tx, device, sale.id, op.payments, issues, now)
  if (paid) await flagNegativeStock(tx, device, sale.branchId, lines.map(l => l.productId), issues, `offline sale ${op.offlineRef} (#${sale.number})`)
  await saveIssues(tx, device, sale.branchId, sale.id, issues)
  const final = await tx.sale.findUniqueOrThrow({ where: { id: sale.id } })
  const result: OpResult = { opId: op.opId, status: 'ok', sale: { id: final.id, number: final.number, status: final.status, offlineRef: final.offlineRef } }
  await tx.offlineOp.create({ data: { opId: op.opId, deviceId: device.id, kind: op.type, result: result as never } })
  return { result, effects: { saleId: final.id, branchId: final.branchId, paid, productIds: lines.map(l => l.productId), issues: issues.length } satisfies Effects }
}

async function runPay(tx: Tx, device: Device, op: z.infer<typeof payOp>, now: Date) {
  const issues: Issue[] = []
  const found = await tx.sale.findUnique({ where: { id: op.saleId }, include: { branch: { select: { businessId: true } }, lines: true } })
  if (!found || found.branch.businessId !== device.businessId) throw new Rejected('That sale is not part of this business.')
  await lockSale(tx, found.id)
  const sale = await tx.sale.findUniqueOrThrow({ where: { id: found.id } })
  if (isEditable(sale.status) && sale.totalCents !== op.seenTotalCents) {
    issues.push({
      kind: 'tab_changed',
      message: `Sale #${sale.number} was changed on another till while till ${device.code} was offline. The offline till charged for ${ksh(op.seenTotalCents)}, the sale is now ${ksh(sale.totalCents)}. Check what the customer paid.`
    })
  }
  const paid = await applyOfflinePayments(tx, device, sale.id, op.payments, issues, now)
  if (paid) await flagNegativeStock(tx, device, sale.branchId, found.lines.map(l => l.productId), issues, `sale #${sale.number}, paid offline`)
  await saveIssues(tx, device, sale.branchId, sale.id, issues)
  const final = await tx.sale.findUniqueOrThrow({ where: { id: sale.id } })
  const result: OpResult = { opId: op.opId, status: 'ok', sale: { id: final.id, number: final.number, status: final.status, offlineRef: final.offlineRef } }
  await tx.offlineOp.create({ data: { opId: op.opId, deviceId: device.id, kind: op.type, result: result as never } })
  return { result, effects: { saleId: final.id, branchId: final.branchId, paid, productIds: found.lines.map(l => l.productId), issues: issues.length } satisfies Effects }
}

function opIdOf(raw: unknown) {
  const v = raw && typeof raw === 'object' ? (raw as { opId?: unknown }).opId : null
  return typeof v === 'string' ? v.slice(0, 64) : null
}

export async function syncOne(device: Device, raw: unknown): Promise<OpResult> {
  const opId = opIdOf(raw)
  const parsed = opSchema.safeParse(raw)
  if (!parsed.success) {
    return { opId, status: 'rejected', message: 'This item is not in a form the server understands: ' + parsed.error.issues.map(i => `${i.path.join('.')} ${i.message}`).slice(0, 3).join('; ') }
  }
  const op = parsed.data
  const earlier = async () => {
    const done = await prisma.offlineOp.findUnique({ where: { opId: op.opId } })
    if (!done) return null
    if (done.deviceId !== device.id) return { opId: op.opId, status: 'rejected', message: 'This item id was already used by another till.' } satisfies OpResult
    return done.result as OpResult
  }
  const first = await earlier()
  if (first) return first

  try {
    const now = new Date()
    const { result, effects } = await prisma.$transaction(
      (tx): Promise<{ result: OpResult; effects: Effects }> => (op.type === "shift_open" ? runShift(tx, device, op, now) : op.type === "sale" ? runSale(tx, device, op, now) : runPay(tx, device, op, now)),
      { timeout: 20_000 }
    )
    if (effects.saleId) await emitSale(effects.saleId)
    if (effects.paid && effects.branchId && effects.productIds) await emitStock(effects.branchId, effects.productIds)
    if (effects.issues && effects.branchId) emitToBranch(effects.branchId, Events.offlineIssue, { count: effects.issues })
    return result
  } catch (err) {
    if (err instanceof Rejected) return { opId: op.opId, status: 'rejected', message: err.message }
    // two tabs of the same till sent it at once: the other one recorded it
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const done = await earlier()
      if (done) return done
    }
    if (err instanceof AppError && err.status < 500) return { opId: op.opId, status: 'rejected', message: err.message }
    console.error('offline sync', op.type, op.opId, err)
    return { opId: op.opId, status: 'retry', message: 'The server could not save this yet. The till will try again.' }
  }
}

export async function syncOps(device: Device, raws: unknown[]) {
  const results: OpResult[] = []
  // in order: a shift opened offline lands before the sales that use it
  for (const raw of raws) results.push(await syncOne(device, raw))
  return results
}
