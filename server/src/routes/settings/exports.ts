import { Hono, type Context } from 'hono'
import { prisma } from '../../db.js'
import { audit } from '../../lib/audit.js'
import { notFound, paymentRequired } from '../../lib/errors.js'
import { query } from '../../lib/validate.js'
import { requireRole, type Actor, type AppEnv } from '../../middleware/auth.js'
import { EXPORT_BATCH, csvResponse, exportQuery, exportRange, money, nairobiStamp, type Cell } from '../../rules/exports.js'
import { todayNairobi } from '../../rules/reports.js'

// Mounted at /api/admin by ../settings.ts. Paths here are relative to /api/admin.
export const exportsRoutes = new Hono<AppEnv>()

exportsRoutes.use('/export/*', requireRole('OWNER'))

export const SALES_HEADER = [
  'Sale number', 'Branch', 'Date', 'Time', 'Status', 'Label', 'Customer', 'Subtotal', 'Discount', 'Total', 'Paid',
  'Paid date', 'Paid time', 'Cashier', 'Paid by', 'Payment methods', 'M-Pesa codes'
]
export const SALE_LINES_HEADER = ['Sale number', 'Branch', 'Date', 'Time', 'Status', 'Product', 'Quantity', 'Unit price', 'Line total']
export const PAYMENTS_HEADER = [
  'Sale number', 'Branch', 'Date', 'Time', 'Method', 'Amount', 'Tendered', 'M-Pesa code', 'Phone', 'Verification', 'Received by'
]
export const STOCK_HEADER = ['Branch', 'Product', 'Size ml', 'Category', 'Barcode', 'Quantity', 'Reorder at', 'Price', 'Stock value', 'Active']
export const PRODUCTS_HEADER = ['Product', 'Size ml', 'Category', 'Barcode', 'Price', 'Active', 'Created']

type Kind = 'sales' | 'sale-lines' | 'payments' | 'stock' | 'products'

// Everything every export checks first: the plan allows it, the query is
// valid and the branch (if any) is one of ours. Then the audit row.
async function begin(c: Context<AppEnv>, kind: Kind, ranged: boolean) {
  const actor = c.get('actor')
  const sub = await prisma.subscription.findUnique({
    where: { businessId: actor.businessId },
    select: { plan: { select: { name: true, features: true } } }
  })
  const features = sub?.plan.features
  if (features && typeof features === 'object' && !Array.isArray(features) && features.exports === false) {
    throw paymentRequired(`The ${sub!.plan.name} plan does not include exports. Contact Bottle Point support to change plan.`, 'plan_feature')
  }
  const q = query(c, exportQuery)
  const range = exportRange(q)
  if (q.branchId) {
    // a branch that was switched off still has history worth exporting
    const branch = await prisma.branch.findFirst({ where: { id: q.branchId, businessId: actor.businessId }, select: { id: true } })
    if (!branch) throw notFound('Branch')
  }
  const branchId = q.branchId ?? null
  await audit(
    prisma,
    actor,
    'export.created',
    'Export',
    null,
    ranged ? { kind, from: range.from, to: range.to, branchId } : { kind, branchId },
    branchId
  )
  return { actor, range, branchId }
}

// Staff names for the "who" columns, including people who have since left.
async function staffNames(actor: Actor) {
  const users = await prisma.user.findMany({ where: { businessId: actor.businessId }, select: { id: true, name: true } })
  return new Map(users.map(u => [u.id, u.name]))
}

const fileName = (kind: Kind, r: { from: string; to: string }) => `${kind}-${r.from}-to-${r.to}.csv`

exportsRoutes.get('/export/sales.csv', async c => {
  const { actor, range, branchId } = await begin(c, 'sales', true)
  const names = await staffNames(actor)
  async function* rows(): AsyncGenerator<Cell[][]> {
    let after: string | undefined
    for (;;) {
      const sales = await prisma.sale.findMany({
        where: {
          branch: { businessId: actor.businessId },
          ...(branchId ? { branchId } : {}),
          createdAt: { gte: range.start, lt: range.end },
          ...(after ? { id: { gt: after } } : {})
        },
        orderBy: { id: 'asc' },
        take: EXPORT_BATCH,
        include: {
          branch: { select: { name: true } },
          customer: { select: { name: true } },
          payments: { select: { method: true, amountCents: true, mpesaRef: true, verification: true }, orderBy: { createdAt: 'asc' } }
        }
      })
      if (!sales.length) return
      yield sales.map(s => {
        const [date, time] = nairobiStamp(s.createdAt)
        const [paidDate, paidTime] = nairobiStamp(s.paidAt)
        // a code the manager rejected is not money received
        const good = s.payments.filter(p => p.verification !== 'MANUAL_REJECTED')
        return [
          s.number, s.branch.name, date, time, s.status, s.label, s.customer?.name,
          money(s.subtotalCents), money(s.discountCents), money(s.totalCents),
          money(good.reduce((a, p) => a + p.amountCents, 0)),
          paidDate, paidTime, names.get(s.createdById), s.paidById ? names.get(s.paidById) : '',
          [...new Set(good.map(p => p.method))].join(' '),
          good.map(p => p.mpesaRef).filter(Boolean).join(' ')
        ]
      })
      if (sales.length < EXPORT_BATCH) return
      after = sales[sales.length - 1]!.id
    }
  }
  return csvResponse(fileName('sales', range), SALES_HEADER, rows())
})

exportsRoutes.get('/export/sale-lines.csv', async c => {
  const { actor, range, branchId } = await begin(c, 'sale-lines', true)
  async function* rows(): AsyncGenerator<Cell[][]> {
    let after: string | undefined
    for (;;) {
      const lines = await prisma.saleLine.findMany({
        where: {
          sale: { branch: { businessId: actor.businessId }, ...(branchId ? { branchId } : {}), createdAt: { gte: range.start, lt: range.end } },
          ...(after ? { id: { gt: after } } : {})
        },
        orderBy: { id: 'asc' },
        take: EXPORT_BATCH,
        include: { sale: { select: { number: true, status: true, createdAt: true, branch: { select: { name: true } } } } }
      })
      if (!lines.length) return
      yield lines.map(l => {
        const [date, time] = nairobiStamp(l.sale.createdAt)
        return [l.sale.number, l.sale.branch.name, date, time, l.sale.status, l.name, l.qty, money(l.unitCents), money(l.unitCents * l.qty)]
      })
      if (lines.length < EXPORT_BATCH) return
      after = lines[lines.length - 1]!.id
    }
  }
  return csvResponse(fileName('sale-lines', range), SALE_LINES_HEADER, rows())
})

exportsRoutes.get('/export/payments.csv', async c => {
  const { actor, range, branchId } = await begin(c, 'payments', true)
  const names = await staffNames(actor)
  async function* rows(): AsyncGenerator<Cell[][]> {
    let after: string | undefined
    for (;;) {
      const payments = await prisma.payment.findMany({
        where: {
          sale: { branch: { businessId: actor.businessId }, ...(branchId ? { branchId } : {}) },
          createdAt: { gte: range.start, lt: range.end },
          ...(after ? { id: { gt: after } } : {})
        },
        orderBy: { id: 'asc' },
        take: EXPORT_BATCH,
        include: { sale: { select: { number: true, branch: { select: { name: true } } } } }
      })
      if (!payments.length) return
      yield payments.map(p => {
        const [date, time] = nairobiStamp(p.createdAt)
        return [
          p.sale.number, p.sale.branch.name, date, time, p.method, money(p.amountCents), money(p.tenderedCents),
          p.mpesaRef, p.phone, p.verification, names.get(p.receivedById)
        ]
      })
      if (payments.length < EXPORT_BATCH) return
      after = payments[payments.length - 1]!.id
    }
  }
  return csvResponse(fileName('payments', range), PAYMENTS_HEADER, rows())
})

// Stock as it stands right now: the date range does not apply.
exportsRoutes.get('/export/stock.csv', async c => {
  const { actor, branchId } = await begin(c, 'stock', false)
  async function* rows(): AsyncGenerator<Cell[][]> {
    let after: string | undefined
    for (;;) {
      // page through products (Stock has no id of its own), a few rows each
      const products = await prisma.product.findMany({
        where: { businessId: actor.businessId, ...(after ? { id: { gt: after } } : {}) },
        orderBy: { id: 'asc' },
        take: EXPORT_BATCH,
        include: {
          stock: {
            where: { branch: { businessId: actor.businessId }, ...(branchId ? { branchId } : {}) },
            include: { branch: { select: { name: true } } },
            orderBy: { branchId: 'asc' }
          }
        }
      })
      if (!products.length) return
      const out = products.flatMap(p =>
        p.stock.map((s): Cell[] => [
          s.branch.name, p.name, p.sizeMl, p.category, p.barcode, s.qty, s.reorderAt,
          money(p.priceCents), money(p.priceCents * s.qty), p.active ? 'Yes' : 'No'
        ])
      )
      if (out.length) yield out
      if (products.length < EXPORT_BATCH) return
      after = products[products.length - 1]!.id
    }
  }
  return csvResponse(`stock-${todayNairobi()}.csv`, STOCK_HEADER, rows())
})

// The whole catalogue: neither the date range nor the branch applies.
exportsRoutes.get('/export/products.csv', async c => {
  const { actor } = await begin(c, 'products', false)
  async function* rows(): AsyncGenerator<Cell[][]> {
    let after: string | undefined
    for (;;) {
      const products = await prisma.product.findMany({
        where: { businessId: actor.businessId, ...(after ? { id: { gt: after } } : {}) },
        orderBy: { id: 'asc' },
        take: EXPORT_BATCH
      })
      if (!products.length) return
      yield products.map(p => [p.name, p.sizeMl, p.category, p.barcode, money(p.priceCents), p.active ? 'Yes' : 'No', nairobiStamp(p.createdAt)[0]])
      if (products.length < EXPORT_BATCH) return
      after = products[products.length - 1]!.id
    }
  }
  return csvResponse(`products-${todayNairobi()}.csv`, PRODUCTS_HEADER, rows())
})
