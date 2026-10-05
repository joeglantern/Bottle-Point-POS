import { Hono } from 'hono'
import { z } from 'zod'
import { prisma, type Approval, type Prisma } from '../db.js'
import { audit } from '../lib/audit.js'
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js'
import { body, id as idField, parse, positiveCents, query } from '../lib/validate.js'
import { assertBranch, atLeast, requireRole, type Actor, type AppEnv } from '../middleware/auth.js'
import { emitToBranch, Events } from '../realtime.js'
import { emitSale, emitStock, lockSale } from '../rules/sale-core.js'
import { approveApproval, checkSaleFor, rejectApproval, saleState } from '../rules/approvals.js'

export const approvalRoutes = new Hono<AppEnv>()

const createBody = z.object({
  saleId: idField,
  kind: z.enum(['CANCEL', 'REFUND', 'DISCOUNT']),
  reason: z.string().trim().min(3, 'Give a reason of at least 3 characters').max(300),
  amountCents: positiveCents.optional(),
  refundMethod: z.enum(['CASH', 'MPESA']).optional()
})
const listQuery = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  saleId: idField.optional(),
  branchId: idField.optional()
})
const decideBody = z.object({ note: z.string().trim().max(300).optional() })

const include = { sale: { select: { number: true, totalCents: true, status: true, branchId: true } } } as const
type Loaded = Prisma.ApprovalGetPayload<{ include: typeof include }>

async function toDTOs(rows: Loaded[]) {
  const ids = [...new Set(rows.flatMap(r => [r.requestedById, r.decidedById]).filter((x): x is string => !!x))]
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []
  const names = new Map(users.map(u => [u.id, u.name]))
  return rows.map(a => ({
    id: a.id,
    saleId: a.saleId,
    saleNumber: a.sale.number,
    saleTotalCents: a.sale.totalCents,
    saleStatus: a.sale.status,
    branchId: a.sale.branchId,
    kind: a.kind,
    status: a.status,
    reason: a.reason,
    amountCents: a.amountCents,
    refundMethod: a.refundMethod,
    requestedById: a.requestedById,
    requestedByName: names.get(a.requestedById) ?? null,
    decidedById: a.decidedById,
    decidedByName: a.decidedById ? (names.get(a.decidedById) ?? null) : null,
    decidedAt: a.decidedAt,
    createdAt: a.createdAt
  }))
}
const toDTO = async (id: string) => (await toDTOs([await prisma.approval.findUniqueOrThrow({ where: { id }, include })]))[0]!

approvalRoutes.post('/', async c => {
  const actor = c.get('actor')
  const input = await body(c, createBody)
  if (input.kind === 'REFUND' && !input.refundMethod) throw badRequest('Say how the money goes back: CASH or MPESA.')
  if (input.kind === 'DISCOUNT' && input.amountCents == null) throw badRequest('Enter the discount amount.')
  if (input.kind !== 'REFUND' && input.refundMethod) throw badRequest('refundMethod is only for refunds.')
  if (input.kind === 'CANCEL' && input.amountCents != null) throw badRequest('A cancellation has no amount.')

  const sale = await prisma.sale.findUnique({ where: { id: input.saleId }, select: { branchId: true } })
  if (!sale || !actor.branchIds.includes(sale.branchId)) throw notFound('Sale')

  const approval = await prisma.$transaction(async tx => {
    // the sale lock makes "one pending request per sale and kind" race free
    await lockSale(tx, input.saleId)
    const pending = await tx.approval.findFirst({ where: { saleId: input.saleId, kind: input.kind, status: 'PENDING' } })
    if (pending) throw conflict(`There is already a ${input.kind.toLowerCase()} request waiting for a manager on this sale.`, 'approval_pending')
    const s = await saleState(tx, input.saleId)
    checkSaleFor(input, s)
    const a = await tx.approval.create({
      data: {
        saleId: input.saleId,
        kind: input.kind,
        reason: input.reason,
        amountCents: input.kind === 'REFUND' ? s.totalCents : (input.amountCents ?? null),
        refundMethod: input.kind === 'REFUND' ? input.refundMethod! : null,
        requestedById: actor.id
      }
    })
    await audit(tx, actor, 'approval.request', 'approval', a.id, { saleId: a.saleId, kind: a.kind, amountCents: a.amountCents, reason: a.reason }, s.branchId)
    return a
  })

  const dto = await toDTO(approval.id)
  emitToBranch(dto.branchId, Events.approvalUpdated, { approval: dto })
  return c.json({ approval: dto }, 201)
})

approvalRoutes.get('/', async c => {
  const actor = c.get('actor')
  const q = query(c, listQuery)
  if (q.branchId) assertBranch(actor, q.branchId)
  const where: Prisma.ApprovalWhereInput = {
    sale: { branchId: q.branchId ? q.branchId : { in: actor.branchIds } },
    ...(q.status ? { status: q.status } : {}),
    ...(q.saleId ? { saleId: q.saleId } : {}),
    ...(atLeast(actor, 'MANAGER') ? {} : { requestedById: actor.id })
  }
  const rows = await prisma.approval.findMany({ where, include, orderBy: { createdAt: 'desc' }, take: 200 })
  return c.json({ approvals: await toDTOs(rows) })
})

async function loadForDecision(actor: Actor, id: string): Promise<Approval> {
  const a = await prisma.approval.findUnique({ where: { id }, include: { sale: { select: { branchId: true } } } })
  if (!a || !actor.branchIds.includes(a.sale.branchId)) throw notFound('Request')
  if (a.requestedById === actor.id && actor.role !== 'OWNER') {
    throw forbidden('You cannot decide your own request. Ask another manager or the owner.')
  }
  return a
}

for (const action of ['approve', 'reject'] as const) {
  approvalRoutes.post(`/:id/${action}`, requireRole('MANAGER'), async c => {
    const actor = c.get('actor')
    // the note is optional, so an empty body is fine too
    const input = parse(decideBody, await c.req.json().catch(() => ({})))
    const a = await loadForDecision(actor, c.req.param('id'))
    const result = await prisma.$transaction(tx =>
      action === 'approve' ? approveApproval(tx, actor, a.id, a.saleId, input.note) : rejectApproval(tx, actor, a.id, a.saleId, input.note)
    )
    const dto = await toDTO(a.id)
    emitToBranch(result.branchId, Events.approvalUpdated, { approval: dto })
    const sale = action === 'approve' ? await emitSale(a.saleId) : undefined
    if (result.productIds.length) await emitStock(result.branchId, result.productIds)
    return c.json({ approval: dto, sale })
  })
}
