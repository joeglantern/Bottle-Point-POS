import { Hono } from 'hono'
import { z } from 'zod'
import { prisma, Prisma } from '../db.js'
import { branchFor, type AppEnv } from '../middleware/auth.js'
import { AppError, notFound, unprocessable } from '../lib/errors.js'
import { body, id, mpesaCode, phone, positiveCents, query } from '../lib/validate.js'
import { audit } from '../lib/audit.js'
import {
  applyPayment,
  emitSale,
  emitStock,
  loadSale,
  lockSale,
  openShift,
  recomputeTotals,
  saleInclude,
  toSaleDTO
} from '../rules/sale-core.js'
import { assertCustomer, isEditable, lineInput, mergeLines, priceLines, saleForActor } from '../rules/sales.js'

export const salesRoutes = new Hono<AppEnv>()

const DAY_MS = 24 * 60 * 60 * 1000

const label = z
  .string()
  .trim()
  .max(60)
  .transform(s => (s === '' ? null : s))

const listQuery = z.object({
  status: z.enum(['OPEN', 'SAVED', 'PAID', 'CANCELLED', 'REFUNDED']).optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .refine(d => !Number.isNaN(Date.parse(`${d}T00:00:00+03:00`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), 'Not a real date')
    .optional(),
  q: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
})

// made by the till; sending the same one again returns the first result
const clientId = z.uuid()

const isUniqueOn = (err: unknown, field: string) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && JSON.stringify(err.meta ?? {}).includes(field)

const createBody = z.object({
  clientId: clientId.optional(),
  lines: z.array(lineInput).min(1, 'Add at least one item').max(200),
  label: label.nullish(),
  customerId: id.nullish()
})

const linesBody = z.object({
  lines: z.array(lineInput).max(200),
  version: z.number().int().min(0)
})

const patchBody = z
  .object({ label: label.nullable().optional(), customerId: id.nullable().optional() })
  .refine(b => b.label !== undefined || b.customerId !== undefined, 'Nothing to change')

const cashItem = z.object({ method: z.literal('CASH'), amountCents: positiveCents, tenderedCents: positiveCents.optional(), clientId: clientId.optional() })
const mpesaItem = z.object({ method: z.literal('MPESA'), amountCents: positiveCents, mpesaRef: mpesaCode, phone: phone.optional(), clientId: clientId.optional() })
const payBody = z.object({ payments: z.array(z.discriminatedUnion('method', [cashItem, mpesaItem])).min(1).max(4) })

const notEditable = (s: { number: number; status: string }) =>
  unprocessable(`Sale #${s.number} is ${s.status.toLowerCase()} and cannot be changed.`, 'sale_not_editable')

// List sales of one branch, newest first. status=SAVED is the shared unpaid list.
salesRoutes.get('/', async c => {
  const q = query(c, listQuery)
  const branchId = branchFor(c)
  const where: Prisma.SaleWhereInput = { branchId }
  if (q.status) where.status = q.status
  if (q.date) {
    const start = new Date(`${q.date}T00:00:00+03:00`)
    where.createdAt = { gte: start, lt: new Date(start.getTime() + DAY_MS) }
  }
  if (q.q) {
    const or: Prisma.SaleWhereInput[] = [{ label: { contains: q.q, mode: 'insensitive' } }, { offlineRef: q.q.toUpperCase() }]
    const m = /^#?(\d{1,9})$/.exec(q.q)
    if (m) or.push({ number: Number(m[1]) })
    where.OR = or
  }
  const rows = await prisma.sale.findMany({ where, include: saleInclude, orderBy: [{ createdAt: 'desc' }, { number: 'desc' }], take: q.limit })
  return c.json({ sales: rows.map(toSaleDTO) })
})

// Record a sale. It is SAVED from the first moment, paid or not.
salesRoutes.post('/', async c => {
  const actor = c.get('actor')
  const b = await body(c, createBody)
  const branchId = branchFor(c)
  const merged = mergeLines(b.lines)

  // the same sale sent again (a reply lost on a weak connection): return it
  const already = async () => {
    if (!b.clientId) return null
    const s = await prisma.sale.findUnique({ where: { clientId: b.clientId }, select: { id: true, branchId: true } })
    if (!s) return null
    if (!actor.branchIds.includes(s.branchId)) throw notFound('Sale')
    return s.id
  }
  const existing = await already()
  if (existing) return c.json({ sale: toSaleDTO(await loadSale(prisma, existing)) })

  const saleId = await prisma.$transaction(async tx => {
    const lines = await priceLines(tx, actor.businessId, merged)
    if (b.customerId) await assertCustomer(tx, actor.businessId, b.customerId)
    // UPDATE takes a row lock on the branch, so two tills never get the same number
    const branch = await tx.branch.update({ where: { id: branchId }, data: { nextSaleNo: { increment: 1 } } })
    const number = branch.nextSaleNo - 1
    const subtotal = lines.reduce((a, l) => a + l.unitCents * l.qty, 0)
    const sale = await tx.sale.create({
      data: {
        number,
        branchId,
        createdById: actor.id,
        label: b.label ?? null,
        customerId: b.customerId ?? null,
        status: 'SAVED',
        subtotalCents: subtotal,
        totalCents: subtotal,
        clientId: b.clientId ?? null,
        lines: { create: lines }
      }
    })
    await audit(tx, actor, 'sale.create', 'sale', sale.id, { number, totalCents: subtotal, lines: lines.length }, branchId)
    return sale.id
  }).catch(async err => {
    // two copies of the same request at the same moment: the first one won
    if (isUniqueOn(err, 'clientId')) {
      const id = await already()
      if (id) return id
    }
    throw err
  })

  const sale = await emitSale(saleId)
  return c.json({ sale }, 201)
})

salesRoutes.get('/:id', async c => {
  const sale = await saleForActor(prisma, c.get('actor'), c.req.param('id'))
  return c.json({ sale: toSaleDTO(sale) })
})

// Replace every line of an unpaid sale. The client sends the version it saw.
salesRoutes.put('/:id/lines', async c => {
  const actor = c.get('actor')
  const saleId = c.req.param('id')
  await saleForActor(prisma, actor, saleId)
  const b = await body(c, linesBody)
  const merged = mergeLines(b.lines)

  await prisma.$transaction(async tx => {
    await lockSale(tx, saleId)
    const sale = await loadSale(tx, saleId)
    if (!isEditable(sale.status)) throw notEditable(sale)
    if (sale.version !== b.version) {
      throw new AppError(409, 'stale_sale', 'This sale was changed on another till. Review it and try again.', { sale: toSaleDTO(sale) })
    }
    const paid = sale.payments.reduce((a, p) => a + p.amountCents, 0)
    const keep = new Map(sale.lines.map(l => [l.productId, { name: l.name, unitCents: l.unitCents }]))
    const lines = await priceLines(tx, actor.businessId, merged, keep)
    const subtotal = lines.reduce((a, l) => a + l.unitCents * l.qty, 0)
    const total = subtotal - Math.min(sale.discountCents, subtotal)
    if (paid > 0 && total <= paid) {
      // equal would leave a fully covered sale that is not PAID, so refuse that too
      throw unprocessable(`${paid / 100} has already been paid on this sale. The new total must stay above that.`, 'below_paid')
    }
    await tx.saleLine.deleteMany({ where: { saleId } })
    if (lines.length) await tx.saleLine.createMany({ data: lines.map(l => ({ ...l, saleId })) })
    await recomputeTotals(tx, saleId)
    await audit(
      tx,
      actor,
      'sale.lines',
      'sale',
      saleId,
      { before: sale.lines.map(l => ({ productId: l.productId, qty: l.qty })), after: lines.map(l => ({ productId: l.productId, qty: l.qty })), totalCents: total },
      sale.branchId
    )
  })

  const sale = await emitSale(saleId)
  return c.json({ sale })
})

salesRoutes.patch('/:id', async c => {
  const actor = c.get('actor')
  const saleId = c.req.param('id')
  await saleForActor(prisma, actor, saleId)
  const b = await body(c, patchBody)

  await prisma.$transaction(async tx => {
    await lockSale(tx, saleId)
    const sale = await tx.sale.findUniqueOrThrow({ where: { id: saleId } })
    if (!isEditable(sale.status)) throw notEditable(sale)
    if (b.customerId) await assertCustomer(tx, actor.businessId, b.customerId)
    const data: Prisma.SaleUncheckedUpdateInput = {}
    if (b.label !== undefined) data.label = b.label
    if (b.customerId !== undefined) data.customerId = b.customerId
    await tx.sale.update({ where: { id: saleId }, data })
    await audit(tx, actor, 'sale.update', 'sale', saleId, { label: b.label, customerId: b.customerId }, sale.branchId)
  })

  const sale = await emitSale(saleId)
  return c.json({ sale })
})

// Confirm receipt of payment, one or several (split) payments, all or nothing.
salesRoutes.post('/:id/pay', async c => {
  const actor = c.get('actor')
  const saleId = c.req.param('id')
  await saleForActor(prisma, actor, saleId)
  const b = await body(c, payBody)

  const codes = b.payments.flatMap(p => (p.method === 'MPESA' ? [p.mpesaRef] : []))
  if (new Set(codes).size !== codes.length) throw unprocessable('The same M-Pesa code was entered twice.', 'mpesa_code_repeated')

  // the same payment sent again: answer as the first time, record nothing
  const ids = b.payments.flatMap(p => (p.clientId ? [p.clientId] : []))
  if (new Set(ids).size !== ids.length) throw unprocessable('Each payment needs its own id.', 'payment_id_repeated')
  const replay = async () => {
    if (!ids.length) return null
    const found = await prisma.payment.findMany({ where: { clientId: { in: ids } }, select: { saleId: true } })
    if (!found.length) return null
    if (found.length !== ids.length || found.some(f => f.saleId !== saleId)) {
      throw unprocessable('These payments do not match this sale.', 'payment_id_mismatch')
    }
    const changeCents = b.payments.reduce((a, p) => a + (p.method === 'CASH' && p.tenderedCents != null ? p.tenderedCents - p.amountCents : 0), 0)
    return c.json({ sale: toSaleDTO(await loadSale(prisma, saleId)), changeCents })
  }
  const earlier = await replay()
  if (earlier) return earlier

  const result = await prisma.$transaction(async tx => {
    await lockSale(tx, saleId)
    const sale = await loadSale(tx, saleId)
    if (!isEditable(sale.status)) {
      throw unprocessable(`Sale #${sale.number} is ${sale.status.toLowerCase()} and cannot take payments.`, 'sale_not_payable')
    }
    const due = sale.totalCents - sale.payments.reduce((a, p) => a + p.amountCents, 0)
    const sum = b.payments.reduce((a, p) => a + p.amountCents, 0)
    if (sale.lines.length && sum > due) throw unprocessable(`Only ${due / 100} is still due on this sale.`, 'overpayment')

    const shift = await openShift(tx, actor.id, sale.branchId)
    if (!shift && b.payments.some(p => p.method === 'CASH')) {
      throw unprocessable('Open a shift before taking cash.', 'no_open_shift')
    }

    let paid = false
    let productIds: string[] = []
    for (const p of b.payments) {
      const r = await applyPayment(
        tx,
        p.method === 'CASH'
          ? { saleId, method: 'CASH', amountCents: p.amountCents, tenderedCents: p.tenderedCents ?? null, verification: 'CASH', receivedById: actor.id, shiftId: shift!.id, clientId: p.clientId ?? null }
          : {
              saleId,
              method: 'MPESA',
              amountCents: p.amountCents,
              mpesaRef: p.mpesaRef,
              phone: p.phone ?? null,
              verification: 'MANUAL_UNVERIFIED',
              receivedById: actor.id,
              shiftId: shift?.id ?? null,
              clientId: p.clientId ?? null
            }
      )
      paid = r.paid
      productIds = r.productIds
    }
    await audit(
      tx,
      actor,
      'sale.pay',
      'sale',
      saleId,
      { payments: b.payments.map(p => ({ method: p.method, amountCents: p.amountCents, mpesaRef: p.method === 'MPESA' ? p.mpesaRef : undefined })), paid },
      sale.branchId
    )
    return { paid, productIds, branchId: sale.branchId }
  }).catch(async err => {
    if (isUniqueOn(err, 'clientId')) {
      const r = await replay()
      if (r) return r
    }
    throw err
  })
  if (result instanceof Response) return result

  const changeCents = b.payments.reduce((a, p) => a + (p.method === 'CASH' && p.tenderedCents != null ? p.tenderedCents - p.amountCents : 0), 0)
  const sale = await emitSale(saleId)
  if (result.paid) await emitStock(result.branchId, result.productIds)
  return c.json({ sale, changeCents })
})

// VAT contained in a VAT inclusive total: total - total / (1 + rate), rounded
// half up to the cent. Whole numbers only (remainder, not a float division),
// so the figure is exact for any amount.
export function vatIncludedCents(totalCents: number, vatRateBps: number) {
  if (vatRateBps <= 0 || totalCents <= 0) return 0
  const scaled = totalCents * 10000
  const divisor = 10000 + vatRateBps
  const rest = scaled % divisor
  const netCents = (scaled - rest) / divisor + (rest * 2 >= divisor ? 1 : 0)
  return totalCents - netCents
}

// Everything a printed receipt needs.
salesRoutes.get('/:id/receipt', async c => {
  const actor = c.get('actor')
  const loaded = await saleForActor(prisma, actor, c.req.param('id'))
  if (loaded.status !== 'PAID' && loaded.status !== 'REFUNDED') {
    throw unprocessable('A receipt is only available once the sale is paid.', 'sale_not_paid')
  }
  const sale = toSaleDTO(loaded)
  const branch = await prisma.branch.findUniqueOrThrow({ where: { id: loaded.branchId }, include: { business: true } })
  const userIds = [...new Set([loaded.createdById, loaded.paidById, ...loaded.payments.map(p => p.receivedById)].filter((x): x is string => !!x))]
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
  const who = (uid: string | null) => (uid ? (users.find(u => u.id === uid) ?? null) : null)

  const biz = branch.business
  const receipt = {
    businessName: biz.name,
    // the shop's own details, as set by the owner in Admin
    business: {
      name: biz.name,
      legalName: biz.legalName,
      address: biz.address,
      phone: biz.phone,
      email: biz.email,
      kraPin: biz.kraPin,
      receiptFooter: biz.receiptFooter,
      vatRateBps: biz.vatRateBps
    },
    branchName: branch.name,
    saleId: sale.id,
    number: sale.number,
    // printed on a receipt made without internet, before the sale had a number
    offlineRef: sale.offlineRef,
    status: sale.status,
    label: sale.label,
    customer: sale.customer,
    createdAt: sale.createdAt,
    paidAt: sale.paidAt,
    refundedAt: sale.refundedAt,
    createdBy: who(loaded.createdById),
    paidBy: who(loaded.paidById),
    lines: sale.lines.map(l => ({ productId: l.productId, name: l.name, qty: l.qty, unitCents: l.unitCents, lineCents: l.lineCents })),
    subtotalCents: sale.subtotalCents,
    discountCents: sale.discountCents,
    totalCents: sale.totalCents,
    // prices include VAT: this is the part of the total that is VAT
    vatCents: vatIncludedCents(sale.totalCents, biz.vatRateBps),
    paidCents: sale.paidCents,
    payments: sale.payments.map(p => ({
      method: p.method,
      amountCents: p.amountCents,
      tenderedCents: p.tenderedCents,
      changeCents: p.changeCents,
      mpesaRef: p.mpesaRef,
      phone: p.phone,
      verification: p.verification,
      receivedBy: who(p.receivedById),
      createdAt: p.createdAt
    })),
    changeCents: sale.payments.reduce((a, p) => a + (p.changeCents ?? 0), 0)
  }
  return c.json({ receipt })
})

