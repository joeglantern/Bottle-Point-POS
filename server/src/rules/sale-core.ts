// The heart of the money rules. Every payment, whether typed at the till or
// confirmed by Safaricom, goes through applyPayment() inside a transaction
// that holds a row lock on the sale. Nothing else may write Payment rows or
// flip a sale to PAID.

import { prisma, type Db, type PayMethod, type PaymentVerification, type Tx } from '../db.js'
import { conflict, notFound, unprocessable } from '../lib/errors.js'
import { emitToBranch, Events } from '../realtime.js'

export const saleInclude = {
  lines: { orderBy: { name: 'asc' as const } },
  payments: { orderBy: { createdAt: 'asc' as const } },
  mpesaRequests: { orderBy: { createdAt: 'desc' as const } },
  customer: { select: { id: true, name: true, phone: true } }
}

export async function loadSale(db: Db, id: string) {
  const sale = await db.sale.findUnique({ where: { id }, include: saleInclude })
  if (!sale) throw notFound('Sale')
  return sale
}

type LoadedSale = Awaited<ReturnType<typeof loadSale>>

// The one shape the web app receives for a sale, over HTTP and sockets.
export function toSaleDTO(s: LoadedSale) {
  const paidCents = s.payments.reduce((a, p) => a + p.amountCents, 0)
  return {
    id: s.id,
    number: s.number,
    branchId: s.branchId,
    status: s.status,
    label: s.label,
    customer: s.customer,
    createdById: s.createdById,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    version: s.version,
    subtotalCents: s.subtotalCents,
    discountCents: s.discountCents,
    totalCents: s.totalCents,
    paidCents,
    dueCents: Math.max(0, s.totalCents - paidCents),
    paidById: s.paidById,
    paidAt: s.paidAt,
    cancelledAt: s.cancelledAt,
    refundedAt: s.refundedAt,
    lines: s.lines.map(l => ({
      id: l.id,
      productId: l.productId,
      name: l.name,
      unitCents: l.unitCents,
      qty: l.qty,
      lineCents: l.unitCents * l.qty
    })),
    payments: s.payments.map(p => ({
      id: p.id,
      method: p.method,
      amountCents: p.amountCents,
      tenderedCents: p.tenderedCents,
      changeCents: p.tenderedCents != null ? p.tenderedCents - p.amountCents : null,
      mpesaRef: p.mpesaRef,
      phone: p.phone,
      verification: p.verification,
      receivedById: p.receivedById,
      createdAt: p.createdAt
    })),
    mpesaRequests: s.mpesaRequests.map(r => ({
      id: r.id,
      phone: r.phone,
      amountCents: r.amountCents,
      status: r.status,
      resultDesc: r.resultDesc,
      receipt: r.receipt,
      createdAt: r.createdAt
    }))
  }
}
export type SaleDTO = ReturnType<typeof toSaleDTO>

// Locks the sale row until the transaction ends. Any other transaction that
// tries to pay, edit or cancel the same sale waits here.
export async function lockSale(tx: Tx, saleId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Sale" WHERE id = ${saleId} FOR UPDATE`
  if (!rows.length) throw notFound('Sale')
}

// Recompute subtotal and total from the lines. Call after any line change.
export async function recomputeTotals(tx: Tx, saleId: string) {
  const lines = await tx.saleLine.findMany({ where: { saleId } })
  const subtotal = lines.reduce((a, l) => a + l.unitCents * l.qty, 0)
  const sale = await tx.sale.findUniqueOrThrow({ where: { id: saleId } })
  const discount = Math.min(sale.discountCents, subtotal)
  await tx.sale.update({
    where: { id: saleId },
    data: { subtotalCents: subtotal, discountCents: discount, totalCents: subtotal - discount, version: { increment: 1 } }
  })
}

export type PaymentInput = {
  saleId: string
  method: PayMethod
  amountCents: number
  tenderedCents?: number | null
  mpesaRef?: string | null
  phone?: string | null
  verification: PaymentVerification
  mpesaRequestId?: string | null
  receivedById: string
  shiftId?: string | null
}

// Adds one payment to a sale. If the payments now cover the total, the sale
// becomes PAID, stock is taken off and the sale is locked for good.
// Must be called inside prisma.$transaction. Caller emits events after commit
// (use emitSale()).
export async function applyPayment(tx: Tx, input: PaymentInput) {
  await lockSale(tx, input.saleId)
  const sale = await tx.sale.findUniqueOrThrow({ where: { id: input.saleId }, include: { payments: true, lines: true } })

  if (sale.status !== 'SAVED' && sale.status !== 'OPEN') {
    throw unprocessable(`Sale #${sale.number} is ${sale.status.toLowerCase()} and cannot take payments.`, 'sale_not_payable')
  }
  if (!sale.lines.length || sale.totalCents <= 0) throw unprocessable('Add items before taking payment.', 'sale_empty')

  const already = sale.payments.reduce((a, p) => a + p.amountCents, 0)
  const due = sale.totalCents - already
  if (input.amountCents <= 0) throw unprocessable('Payment amount must be more than zero.', 'bad_amount')
  if (input.amountCents > due) {
    throw unprocessable(`Only ${due / 100} is still due on this sale.`, 'overpayment')
  }
  if (input.method === 'CASH' && input.tenderedCents != null && input.tenderedCents < input.amountCents) {
    throw unprocessable('Cash received is less than the amount being paid.', 'short_cash')
  }

  // Money taken into a shift must not land after that shift was counted and
  // closed. FOR SHARE waits for a close in progress, then we re check.
  // M-Pesa never sits in the drawer, so a late confirmation is still recorded,
  // just without a shift.
  let shiftId = input.shiftId ?? null
  if (shiftId) {
    const rows = await tx.$queryRaw<{ closedAt: Date | null }[]>`SELECT "closedAt" FROM "Shift" WHERE id = ${shiftId} FOR SHARE`
    if (!rows.length || rows[0]!.closedAt) {
      if (input.method === 'CASH') throw unprocessable('Your shift was closed. Open a new shift to take cash.', 'shift_closed')
      shiftId = null
    }
  }

  if (input.mpesaRef) {
    const used = await tx.payment.findUnique({ where: { mpesaRef: input.mpesaRef } })
    if (used) throw conflict('This M-Pesa code is already linked to another sale.', 'mpesa_code_used')
  }

  const payment = await tx.payment.create({
    data: {
      saleId: sale.id,
      method: input.method,
      amountCents: input.amountCents,
      tenderedCents: input.method === 'CASH' ? (input.tenderedCents ?? input.amountCents) : null,
      mpesaRef: input.mpesaRef ?? null,
      phone: input.phone ?? null,
      verification: input.verification,
      mpesaRequestId: input.mpesaRequestId ?? null,
      receivedById: input.receivedById,
      shiftId
    }
  })

  const nowPaid = already + input.amountCents === sale.totalCents
  if (nowPaid) {
    await tx.sale.update({
      where: { id: sale.id },
      data: { status: 'PAID', paidAt: new Date(), paidById: input.receivedById, version: { increment: 1 } }
    })
    // Stock leaves the shelf when the sale is paid.
    for (const l of sale.lines) {
      await tx.stock.upsert({
        where: { branchId_productId: { branchId: sale.branchId, productId: l.productId } },
        create: { branchId: sale.branchId, productId: l.productId, qty: -l.qty },
        update: { qty: { decrement: l.qty } }
      })
      await tx.stockMovement.create({
        data: { branchId: sale.branchId, productId: l.productId, delta: -l.qty, reason: 'SALE', saleId: sale.id, userId: input.receivedById }
      })
    }
  } else {
    // a part payment still counts as activity on the sale
    await tx.sale.update({ where: { id: sale.id }, data: { status: 'SAVED', version: { increment: 1 } } })
  }

  return { payment, paid: nowPaid, branchId: sale.branchId, productIds: sale.lines.map(l => l.productId) }
}

// Broadcast the latest state of a sale to its branch. Call after commit.
export async function emitSale(saleId: string) {
  const sale = await loadSale(prisma, saleId)
  const dto = toSaleDTO(sale)
  emitToBranch(sale.branchId, Events.saleUpdated, { sale: dto })
  return dto
}

// After stock changed, tell the branch the new quantities.
export async function emitStock(branchId: string, productIds: string[]) {
  if (!productIds.length) return
  const rows = await prisma.stock.findMany({ where: { branchId, productId: { in: productIds } } })
  for (const r of rows) emitToBranch(branchId, Events.stockUpdated, { branchId, productId: r.productId, qty: r.qty, reorderAt: r.reorderAt })
}

// The open shift of a user in a branch, if any.
export function openShift(db: Db, userId: string, branchId: string) {
  return db.shift.findFirst({ where: { userId, branchId, closedAt: null } })
}
