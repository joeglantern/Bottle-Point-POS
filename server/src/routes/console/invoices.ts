import { Hono } from 'hono'
import { z } from 'zod'
import { prisma, type Db, type Invoice, type Prisma } from '../../db.js'
import { env } from '../../env.js'
import { platformAudit } from '../../lib/audit.js'
import { badRequest, notFound, unprocessable } from '../../lib/errors.js'
import { body, cents, id, positiveCents, query } from '../../lib/validate.js'
import { allowPlatform, type ConsoleEnv } from '../../middleware/platform.js'
import {
  AUTO_SUSPEND_PREFIX,
  createInvoice,
  DAY_MS,
  hasOverdueInvoice,
  lockSubscription,
  paging,
  requireBusiness
} from '../../rules/platform.js'

// Invoices raised to client businesses and the payments recorded against
// them. Everyone on the console may read. Only BILLING (and SUPER_ADMIN) may
// raise, void or take payment.
export const invoiceRoutes = new Hono<ConsoleEnv>()

// The largest total an invoice may carry (the columns are 32 bit integers).
const MAX_TOTAL_CENTS = 2_000_000_000
// CSV exports are capped so one request cannot pull the whole table.
const EXPORT_MAX_ROWS = 10_000

// Query strings arrive as "" when a filter is cleared in the UI.
const blank = <T extends z.ZodType>(schema: T) => z.preprocess(v => (v === '' ? undefined : v), schema.optional())

// A date filter: "2026-10-06" means that Nairobi day, anything else must be a full ISO instant.
const DAY = /^\d{4}-\d{2}-\d{2}$/
const when = z
  .string()
  .trim()
  .max(40)
  .refine(s => !Number.isNaN(Date.parse(DAY.test(s) ? `${s}T00:00:00+03:00` : s)), 'Use a date like 2026-10-06')

const filterShape = {
  status: blank(z.enum(['OPEN', 'PAID', 'VOID', 'OVERDUE'])),
  businessId: blank(id),
  q: blank(z.string().trim().max(100)),
  from: blank(when),
  to: blank(when)
}
const listQuery = z.object({ ...filterShape, ...paging })
const exportQuery = z.object(filterShape)
type Filter = z.infer<typeof exportQuery>

function whereFor(f: Filter, now: Date): Prisma.InvoiceWhereInput {
  const and: Prisma.InvoiceWhereInput[] = []
  // overdue is not a stored status: it is an open invoice past its due date
  if (f.status === 'OVERDUE') and.push({ status: 'OPEN', dueAt: { lt: now } })
  else if (f.status) and.push({ status: f.status })
  if (f.businessId) and.push({ businessId: f.businessId })
  if (f.q) {
    and.push({
      OR: [{ number: { contains: f.q, mode: 'insensitive' } }, { business: { name: { contains: f.q, mode: 'insensitive' } } }]
    })
  }
  if (f.from) and.push({ issuedAt: { gte: new Date(DAY.test(f.from) ? `${f.from}T00:00:00+03:00` : f.from) } })
  if (f.to) {
    // a plain day includes the whole of that day
    const to = DAY.test(f.to) ? new Date(new Date(`${f.to}T00:00:00+03:00`).getTime() + DAY_MS) : new Date(f.to)
    and.push({ issuedAt: { lt: to } })
  }
  return { AND: and }
}

type Row = Invoice & { business: { id: string; name: string } }

const summary = (inv: Row, now: Date) => ({
  id: inv.id,
  number: inv.number,
  business: { id: inv.business.id, name: inv.business.name },
  subscriptionId: inv.subscriptionId,
  status: inv.status,
  overdue: inv.status === 'OPEN' && inv.dueAt < now,
  periodStart: inv.periodStart,
  periodEnd: inv.periodEnd,
  subtotalCents: inv.subtotalCents,
  taxCents: inv.taxCents,
  totalCents: inv.totalCents,
  paidCents: inv.paidCents,
  balanceCents: inv.status === 'OPEN' ? inv.totalCents - inv.paidCents : 0,
  issuedAt: inv.issuedAt,
  dueAt: inv.dueAt,
  paidAt: inv.paidAt,
  voidedAt: inv.voidedAt
})

const businessPick = { select: { id: true, name: true } } as const

// Everything the invoice page shows: the client block, lines and payments.
async function detail(db: Db, invoiceId: string, now = new Date()) {
  const inv = await db.invoice.findUnique({
    where: { id: invoiceId },
    include: { business: true, payments: { orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }] } }
  })
  if (!inv) throw notFound('Invoice')
  const recorderIds = [...new Set(inv.payments.map(p => p.recordedById))]
  const recorders = recorderIds.length
    ? await db.user.findMany({ where: { id: { in: recorderIds } }, select: { id: true, name: true } })
    : []
  const names = new Map(recorders.map(u => [u.id, u.name]))
  const b = inv.business
  return {
    ...summary(inv, now),
    lines: inv.lines,
    notes: inv.notes,
    client: { id: b.id, name: b.name, legalName: b.legalName, address: b.address, kraPin: b.kraPin, email: b.email, phone: b.phone },
    payments: inv.payments.map(p => ({
      id: p.id,
      amountCents: p.amountCents,
      method: p.method,
      reference: p.reference,
      receivedAt: p.receivedAt,
      createdAt: p.createdAt,
      recordedBy: names.has(p.recordedById) ? { id: p.recordedById, name: names.get(p.recordedById)! } : null
    }))
  }
}

// Lock the invoice row and read it fresh. Call after lockSubscription so
// every writer takes the two locks in the same order as the billing run.
async function lockInvoice(tx: Db, invoiceId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${invoiceId} FOR UPDATE`
  const inv = await tx.invoice.findUnique({ where: { id: invoiceId }, include: { business: businessPick } })
  if (!inv) throw notFound('Invoice')
  return inv
}

// The invoice that kept a client past due (or suspended by the billing run)
// has just been settled. If nothing else is overdue the client is in good
// standing again. A suspension made by a person is never lifted here.
async function restoreIfSettled(tx: Db, businessId: string, businessName: string, number: string, now: Date) {
  const sub = await tx.subscription.findUnique({ where: { businessId } })
  if (!sub) return null
  const autoSuspended = sub.status === 'SUSPENDED' && (sub.suspendedReason ?? '').startsWith(AUTO_SUSPEND_PREFIX)
  if (sub.status !== 'PAST_DUE' && !autoSuspended) return sub.status
  if (await hasOverdueInvoice(tx, businessId, now)) return sub.status
  await tx.subscription.update({ where: { id: sub.id }, data: { status: 'ACTIVE', suspendedReason: null, suspendedAt: null } })
  await platformAudit(tx, null, 'billing.reactivated', 'Subscription', sub.id, { businessName, from: sub.status, number }, businessId)
  return 'ACTIVE' as const
}

invoiceRoutes.get('/invoices', async c => {
  const f = query(c, listQuery)
  const now = new Date()
  const where = whereFor(f, now)
  const sums = { _sum: { totalCents: true, paidCents: true } } as const
  const [rows, total, live, open] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: { business: businessPick },
      orderBy: [{ issuedAt: 'desc' }, { number: 'desc' }],
      take: f.limit,
      skip: f.offset
    }),
    prisma.invoice.count({ where }),
    // void invoices were never owed, so they do not count as billed
    prisma.invoice.aggregate({ where: { AND: [where, { status: { in: ['OPEN', 'PAID'] } }] }, ...sums }),
    prisma.invoice.aggregate({ where: { AND: [where, { status: 'OPEN' }] }, ...sums })
  ])
  return c.json({
    invoices: rows.map(r => summary(r, now)),
    total,
    totals: {
      billedCents: live._sum.totalCents ?? 0,
      collectedCents: live._sum.paidCents ?? 0,
      outstandingCents: (open._sum.totalCents ?? 0) - (open._sum.paidCents ?? 0)
    }
  })
})

// One CSV cell. Text that a spreadsheet would run as a formula gets a leading
// single quote, and quotes, commas and line breaks are wrapped and doubled.
export function csvCell(value: unknown): string {
  if (value == null) return ''
  let s = String(value)
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const money = (c: number) => (c / 100).toFixed(2)
const stamp = (d: Date | null) => (d ? d.toISOString() : '')

// Must stay above /invoices/:id or "export.csv" would be read as an id.
invoiceRoutes.get('/invoices/export.csv', async c => {
  const f = query(c, exportQuery)
  const now = new Date()
  const rows = await prisma.invoice.findMany({
    where: whereFor(f, now),
    include: { business: businessPick },
    orderBy: [{ issuedAt: 'desc' }, { number: 'desc' }],
    take: EXPORT_MAX_ROWS
  })
  const head = ['Number', 'Client', 'Status', 'Issued', 'Due', 'Paid on', 'Subtotal', 'VAT', 'Total', 'Paid', 'Balance', 'Notes']
  const out = [head.join(',')]
  for (const r of rows) {
    const s = summary(r, now)
    out.push(
      [
        csvCell(r.number),
        csvCell(r.business.name),
        s.overdue ? 'OVERDUE' : r.status,
        stamp(r.issuedAt),
        stamp(r.dueAt),
        stamp(r.paidAt),
        money(r.subtotalCents),
        money(r.taxCents),
        money(r.totalCents),
        money(r.paidCents),
        money(s.balanceCents),
        csvCell(r.notes)
      ].join(',')
    )
  }
  const day = new Date(now.getTime() + 3 * 3_600_000).toISOString().slice(0, 10)
  return c.body(out.join('\r\n') + '\r\n', 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="invoices-${day}.csv"`,
    'cache-control': 'no-store'
  })
})

invoiceRoutes.get('/invoices/:id', async c => c.json({ invoice: await detail(prisma, c.req.param('id')) }))

const manualBody = z.object({
  lines: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(200),
        quantity: z.number().int().min(1).max(1000),
        unitCents: cents
      })
    )
    .min(1)
    .max(50),
  dueInDays: z.number().int().min(0).max(90).default(7),
  notes: z.string().trim().max(1000).optional()
})

// A one off invoice outside the subscription cycle (setup fee, hardware, training).
invoiceRoutes.post('/tenants/:id/invoices', allowPlatform('BILLING'), async c => {
  const platform = c.get('platform')
  const input = await body(c, manualBody)
  const lines = input.lines.map(l => ({ ...l, amountCents: l.quantity * l.unitCents }))
  const subtotalCents = lines.reduce((a, l) => a + l.amountCents, 0)
  const taxCents = Math.round((subtotalCents * env.PLATFORM_VAT_BPS) / 10000)
  const totalCents = subtotalCents + taxCents
  if (totalCents <= 0) throw badRequest('An invoice needs an amount above zero.')
  if (totalCents > MAX_TOTAL_CENTS) throw badRequest('That invoice is too large. Split it into smaller ones.')
  const invoiceId = await prisma.$transaction(async tx => {
    const business = await requireBusiness(tx, c.req.param('id'))
    const now = new Date()
    const invoice = await createInvoice(tx, {
      businessId: business.id,
      periodStart: now,
      periodEnd: now,
      priced: { lines, subtotalCents, taxCents, totalCents },
      issuedAt: now,
      dueAt: new Date(now.getTime() + input.dueInDays * DAY_MS),
      notes: input.notes || null
    })
    await platformAudit(
      tx,
      platform,
      'console.invoice.created',
      'Invoice',
      invoice.id,
      { businessName: business.name, number: invoice.number, subtotalCents, taxCents, totalCents, dueAt: invoice.dueAt },
      business.id
    )
    return invoice.id
  })
  return c.json({ invoice: await detail(prisma, invoiceId) }, 201)
})

const paymentBody = z.object({
  amountCents: positiveCents,
  method: z.enum(['MPESA', 'BANK', 'CARD', 'CASH', 'OTHER']),
  reference: z.string().trim().max(100).optional(),
  receivedAt: z
    .string()
    .max(40)
    .refine(s => !Number.isNaN(Date.parse(s)), 'Use an ISO date and time')
    .optional()
})

invoiceRoutes.post('/invoices/:id/payments', allowPlatform('BILLING'), async c => {
  const platform = c.get('platform')
  const input = await body(c, paymentBody)
  const now = new Date()
  const receivedAt = input.receivedAt ? new Date(input.receivedAt) : now
  // a little slack for clocks that run ahead
  if (receivedAt.getTime() > now.getTime() + 5 * 60_000) throw badRequest('The payment date cannot be in the future.')
  const invoiceId = c.req.param('id')
  const result = await prisma.$transaction(async tx => {
    const found = await tx.invoice.findUnique({ where: { id: invoiceId }, select: { businessId: true } })
    if (!found) throw notFound('Invoice')
    await lockSubscription(tx, found.businessId)
    const inv = await lockInvoice(tx, invoiceId)
    if (inv.status === 'VOID') throw unprocessable('This invoice was voided and cannot take a payment.', 'invoice_void')
    if (inv.status === 'PAID') throw unprocessable('This invoice is already paid in full.', 'invoice_paid')
    if (inv.status !== 'OPEN') throw unprocessable('This invoice is not open for payment.', 'invoice_not_open')
    const balance = inv.totalCents - inv.paidCents
    if (input.amountCents > balance) {
      throw unprocessable(`That is more than the balance of KSh ${(balance / 100).toFixed(2)} on this invoice.`, 'overpayment')
    }
    const payment = await tx.invoicePayment.create({
      data: {
        invoiceId: inv.id,
        amountCents: input.amountCents,
        method: input.method,
        reference: input.reference || null,
        receivedAt,
        recordedById: platform.id
      }
    })
    const paidCents = inv.paidCents + input.amountCents
    const fullyPaid = paidCents === inv.totalCents
    await tx.invoice.update({
      where: { id: inv.id },
      data: { paidCents, ...(fullyPaid ? { status: 'PAID' as const, paidAt: receivedAt } : {}) }
    })
    await platformAudit(
      tx,
      platform,
      'console.invoice.payment_recorded',
      'Invoice',
      inv.id,
      {
        businessName: inv.business.name,
        number: inv.number,
        amountCents: input.amountCents,
        method: input.method,
        reference: input.reference || null,
        paidCents,
        balanceCents: inv.totalCents - paidCents,
        fullyPaid
      },
      inv.businessId
    )
    const sub = await tx.subscription.findUnique({ where: { businessId: inv.businessId }, select: { status: true } })
    const subscriptionStatus = fullyPaid
      ? await restoreIfSettled(tx, inv.businessId, inv.business.name, inv.number, now)
      : sub?.status ?? null
    return { paymentId: payment.id, subscriptionStatus }
  })
  const invoice = await detail(prisma, invoiceId)
  return c.json(
    {
      invoice,
      payment: invoice.payments.find(p => p.id === result.paymentId) ?? null,
      subscriptionStatus: result.subscriptionStatus
    },
    201
  )
})

const voidBody = z.object({ reason: z.string().trim().min(1).max(500) })

invoiceRoutes.post('/invoices/:id/void', allowPlatform('BILLING'), async c => {
  const platform = c.get('platform')
  const { reason } = await body(c, voidBody)
  const invoiceId = c.req.param('id')
  const subscriptionStatus = await prisma.$transaction(async tx => {
    const found = await tx.invoice.findUnique({ where: { id: invoiceId }, select: { businessId: true } })
    if (!found) throw notFound('Invoice')
    await lockSubscription(tx, found.businessId)
    const inv = await lockInvoice(tx, invoiceId)
    if (inv.status !== 'OPEN') throw unprocessable('Only an open invoice can be voided.', 'invoice_not_open')
    const payments = await tx.invoicePayment.count({ where: { invoiceId: inv.id } })
    if (inv.paidCents > 0 || payments > 0) {
      throw unprocessable('This invoice has payments recorded against it and cannot be voided.', 'invoice_has_payments')
    }
    const now = new Date()
    await tx.invoice.update({
      where: { id: inv.id },
      // the reason stays on the invoice so anyone opening it can see why
      data: { status: 'VOID', voidedAt: now, notes: [inv.notes, `Voided: ${reason}`].filter(Boolean).join('\n') }
    })
    await platformAudit(
      tx,
      platform,
      'console.invoice.voided',
      'Invoice',
      inv.id,
      { businessName: inv.business.name, number: inv.number, totalCents: inv.totalCents, reason },
      inv.businessId
    )
    // nothing is owed on a void invoice, so it can no longer hold the client past due
    return restoreIfSettled(tx, inv.businessId, inv.business.name, inv.number, now)
  })
  return c.json({ invoice: await detail(prisma, invoiceId), subscriptionStatus })
})
