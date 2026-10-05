// Manager approvals: cancelling an unpaid sale, refunding a paid one and
// giving a discount. A request only checks the sale; the decision re checks
// everything under the sale lock because the sale may have moved on since.

import type { Approval, Db, Sale, Tx } from '../db.js'
import type { Actor } from '../middleware/auth.js'
import { audit } from '../lib/audit.js'
import { conflict, unprocessable } from '../lib/errors.js'
import { lockSale, openShift, recomputeTotals } from './sale-core.js'

type SaleState = Pick<Sale, 'number' | 'status' | 'subtotalCents' | 'totalCents'> & { paymentCount: number }
type Request = { kind: Approval['kind']; amountCents?: number | null; refundMethod?: Approval['refundMethod'] }

const unpaid = (s: SaleState) => s.status === 'SAVED' || s.status === 'OPEN'

// Throws a 422 explaining why this kind of approval does not fit the sale now.
export function checkSaleFor(req: Request, s: SaleState) {
  const label = `Sale #${s.number}`
  if (req.kind === 'CANCEL') {
    if (s.status === 'PAID') throw unprocessable(`${label} is paid. Ask for a refund instead.`, 'sale_paid')
    if (!unpaid(s)) throw unprocessable(`${label} is ${s.status.toLowerCase()} and cannot be cancelled.`, 'sale_not_cancellable')
    if (s.paymentCount > 0) {
      throw unprocessable(`${label} has already been part paid. It cannot be cancelled, finish the payment and ask for a refund instead.`, 'sale_part_paid')
    }
  } else if (req.kind === 'REFUND') {
    if (s.status !== 'PAID') throw unprocessable(`${label} is ${s.status.toLowerCase()}. Only paid sales can be refunded.`, 'sale_not_paid')
    if (req.amountCents != null && req.amountCents !== s.totalCents) {
      throw unprocessable(`Only full refunds are supported. The refund must be ${s.totalCents / 100}.`, 'partial_refund')
    }
  } else {
    if (!unpaid(s)) throw unprocessable(`${label} is ${s.status.toLowerCase()}. Discounts are only for unpaid sales.`, 'sale_not_discountable')
    if (s.paymentCount > 0) throw unprocessable(`${label} has payments already. Discounts must be agreed before payment.`, 'sale_part_paid')
    if ((req.amountCents ?? 0) > s.subtotalCents) {
      throw unprocessable(`The discount cannot be more than the sale subtotal of ${s.subtotalCents / 100}.`, 'discount_too_large')
    }
  }
}

export async function saleState(db: Db, saleId: string): Promise<SaleState & Sale> {
  const s = await db.sale.findUniqueOrThrow({ where: { id: saleId }, include: { _count: { select: { payments: true } } } })
  return { ...s, paymentCount: s._count.payments }
}

async function lockApproval(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM "Approval" WHERE id = ${id} FOR UPDATE`
  const a = await tx.approval.findUniqueOrThrow({ where: { id } })
  if (a.status !== 'PENDING') throw unprocessable(`This request was already ${a.status.toLowerCase()}.`, 'already_decided')
  return a
}

export async function rejectApproval(tx: Tx, actor: Actor, id: string, saleId: string, note?: string) {
  await lockSale(tx, saleId)
  const a = await lockApproval(tx, id)
  const sale = await tx.sale.findUniqueOrThrow({ where: { id: saleId } })
  const updated = await tx.approval.update({
    where: { id },
    data: { status: 'REJECTED', decidedById: actor.id, decidedAt: new Date() }
  })
  await audit(tx, actor, 'approval.reject', 'approval', id, { kind: a.kind, saleId, note }, sale.branchId)
  return { approval: updated, productIds: [] as string[], branchId: sale.branchId }
}

export async function approveApproval(tx: Tx, actor: Actor, id: string, saleId: string, note?: string) {
  await lockSale(tx, saleId)
  const a = await lockApproval(tx, id)
  const sale = await saleState(tx, saleId)
  checkSaleFor(a, sale)
  const now = new Date()
  let productIds: string[] = []

  if (a.kind === 'CANCEL') {
    await tx.sale.update({ where: { id: saleId }, data: { status: 'CANCELLED', cancelledAt: now, version: { increment: 1 } } })
    await audit(tx, actor, 'sale.cancel', 'sale', saleId, { approvalId: id, totalCents: sale.totalCents }, sale.branchId)
  } else if (a.kind === 'DISCOUNT') {
    // the DB checks total = subtotal - discount on every write, so set both
    const discount = a.amountCents!
    await tx.sale.update({ where: { id: saleId }, data: { discountCents: discount, totalCents: sale.subtotalCents - discount } })
    await recomputeTotals(tx, saleId)
    await audit(tx, actor, 'sale.discount', 'sale', saleId, { approvalId: id, discountCents: a.amountCents, before: sale.discountCents }, sale.branchId)
  } else {
    const method = a.refundMethod!
    let shiftId: string | null = null
    if (method === 'CASH') {
      // the money has to come out of a till somebody will count
      const shift = (await openShift(tx, a.requestedById, sale.branchId)) ?? (await openShift(tx, actor.id, sale.branchId))
      if (!shift) {
        throw unprocessable('A cash refund must come out of an open till. Open a shift first, then approve again.', 'no_open_shift')
      }
      // hold the shift so it cannot be closed while the refund goes in
      await tx.$queryRaw`SELECT id FROM "Shift" WHERE id = ${shift.id} FOR UPDATE`
      const fresh = await tx.shift.findUniqueOrThrow({ where: { id: shift.id } })
      if (fresh.closedAt) throw conflict('That shift was just closed. Try again.', 'shift_closed')
      shiftId = shift.id
    }
    const refund = await tx.refund.create({
      data: { saleId, approvalId: id, amountCents: sale.totalCents, method, shiftId, paidOutById: actor.id }
    })
    await tx.sale.update({ where: { id: saleId }, data: { status: 'REFUNDED', refundedAt: now, version: { increment: 1 } } })
    const lines = await tx.saleLine.findMany({ where: { saleId } })
    for (const l of lines) {
      await tx.stock.upsert({
        where: { branchId_productId: { branchId: sale.branchId, productId: l.productId } },
        create: { branchId: sale.branchId, productId: l.productId, qty: l.qty },
        update: { qty: { increment: l.qty } }
      })
      await tx.stockMovement.create({
        data: { branchId: sale.branchId, productId: l.productId, delta: l.qty, reason: 'REFUND', saleId, userId: actor.id, note: `Refund of sale #${sale.number}` }
      })
    }
    productIds = lines.map(l => l.productId)
    await audit(tx, actor, 'sale.refund', 'sale', saleId, { approvalId: id, refundId: refund.id, amountCents: refund.amountCents, method, shiftId }, sale.branchId)
  }

  const updated = await tx.approval.update({
    where: { id },
    data: { status: 'APPROVED', decidedById: actor.id, decidedAt: now }
  })
  await audit(tx, actor, 'approval.approve', 'approval', id, { kind: a.kind, saleId, note }, sale.branchId)
  return { approval: updated, productIds, branchId: sale.branchId }
}
