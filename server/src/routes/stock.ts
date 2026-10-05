import { Hono } from 'hono'
import { z } from 'zod'
import { prisma, type Tx } from '../db.js'
import { audit } from '../lib/audit.js'
import { notFound } from '../lib/errors.js'
import { body, id, parse, query } from '../lib/validate.js'
import { branchFor, requireRole, type Actor, type AppEnv } from '../middleware/auth.js'
import { emitStock } from '../rules/sale-core.js'
import { toStockDTO } from '../rules/catalog.js'

export const stockRoutes = new Hono<AppEnv>()

const listQuery = z.object({
  low: z.enum(['true', 'false', '1', '0']).optional(),
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(40).optional(),
  branchId: z.string().optional()
})

const receiveSchema = z.object({
  items: z
    .array(
      z.object({
        productId: id,
        qty: z.number().int().min(1, 'Quantity must be at least 1').max(100_000),
        note: z.string().trim().max(200).optional()
      })
    )
    .min(1, 'Add at least one item')
    .max(200)
})

const adjustSchema = z.object({
  productId: id,
  countedQty: z.number().int().min(0, 'Counted quantity cannot be negative').max(1_000_000),
  reason: z.string().trim().min(3, 'Give a reason of at least 3 characters').max(200)
})

const reorderSchema = z.object({ reorderAt: z.number().int().min(0).max(100_000) })

const movementsQuery = z.object({
  productId: id.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  branchId: z.string().optional()
})

async function assertProducts(actor: Actor, productIds: string[]) {
  const unique = [...new Set(productIds)]
  const found = await prisma.product.findMany({ where: { id: { in: unique }, businessId: actor.businessId }, select: { id: true } })
  if (found.length !== unique.length) throw notFound('Product')
}

// Makes sure the row exists, then locks it until the transaction ends so a
// sale or delivery running at the same moment waits for us.
async function lockStock(tx: Tx, branchId: string, productId: string) {
  await tx.$executeRaw`INSERT INTO "Stock" ("branchId", "productId", "qty", "reorderAt") VALUES (${branchId}, ${productId}, 0, 10) ON CONFLICT DO NOTHING`
  const rows = await tx.$queryRaw<{ qty: number }[]>`SELECT qty FROM "Stock" WHERE "branchId" = ${branchId} AND "productId" = ${productId} FOR UPDATE`
  return rows[0]!.qty
}

async function stockRows(branchId: string, productIds: string[]) {
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    include: { stock: { where: { branchId } } },
    orderBy: { name: 'asc' }
  })
  return products.map(p => toStockDTO(p, p.stock[0], branchId))
}

stockRoutes.get('/', async c => {
  const actor = c.get('actor')
  const q = query(c, listQuery)
  const branchId = branchFor(c)
  const products = await prisma.product.findMany({
    where: {
      businessId: actor.businessId,
      active: true,
      ...(q.category ? { category: { equals: q.category, mode: 'insensitive' as const } } : {}),
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' as const } }, { barcode: { startsWith: q.q } }] } : {})
    },
    include: { stock: { where: { branchId } } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }]
  })
  let stock = products.map(p => toStockDTO(p, p.stock[0], branchId))
  if (q.low === 'true' || q.low === '1') stock = stock.filter(s => s.low)
  return c.json({ branchId, stock })
})

stockRoutes.get('/movements', requireRole('MANAGER'), async c => {
  const actor = c.get('actor')
  const q = query(c, movementsQuery)
  const branchId = branchFor(c)
  if (q.productId) await assertProducts(actor, [q.productId])
  const rows = await prisma.stockMovement.findMany({
    where: { branchId, ...(q.productId ? { productId: q.productId } : {}) },
    include: { product: { select: { name: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: q.limit
  })
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map(r => r.userId))] } }, select: { id: true, name: true } })
  const names = new Map(users.map(u => [u.id, u.name]))
  return c.json({
    branchId,
    movements: rows.map(r => ({
      id: r.id,
      productId: r.productId,
      productName: r.product.name,
      delta: r.delta,
      reason: r.reason,
      saleId: r.saleId,
      note: r.note,
      userId: r.userId,
      userName: names.get(r.userId) ?? null,
      createdAt: r.createdAt
    }))
  })
})

stockRoutes.post('/receive', requireRole('MANAGER'), async c => {
  const actor = c.get('actor')
  const input = await body(c, receiveSchema)
  const branchId = branchFor(c)
  await assertProducts(actor, input.items.map(i => i.productId))

  // Same order every time so two deliveries cannot deadlock each other.
  const items = [...input.items].sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0))
  await prisma.$transaction(async tx => {
    for (const item of items) {
      await tx.$executeRaw`INSERT INTO "Stock" ("branchId", "productId", "qty", "reorderAt") VALUES (${branchId}, ${item.productId}, ${item.qty}, 10)
        ON CONFLICT ("branchId", "productId") DO UPDATE SET qty = "Stock".qty + EXCLUDED.qty`
      await tx.stockMovement.create({
        data: { branchId, productId: item.productId, delta: item.qty, reason: 'RECEIVE', userId: actor.id, note: item.note ?? null }
      })
    }
    await audit(tx, actor, 'stock.received', 'branch', branchId, { items: input.items }, branchId)
  })

  const productIds = [...new Set(items.map(i => i.productId))]
  await emitStock(branchId, productIds)
  return c.json({ stock: await stockRows(branchId, productIds) })
})

stockRoutes.post('/adjust', requireRole('MANAGER'), async c => {
  const actor = c.get('actor')
  const input = await body(c, adjustSchema)
  const branchId = branchFor(c)
  await assertProducts(actor, [input.productId])

  const result = await prisma.$transaction(async tx => {
    const before = await lockStock(tx, branchId, input.productId)
    const delta = input.countedQty - before
    await tx.stock.update({
      where: { branchId_productId: { branchId, productId: input.productId } },
      data: { qty: input.countedQty }
    })
    const movement =
      delta === 0
        ? null
        : await tx.stockMovement.create({
            data: { branchId, productId: input.productId, delta, reason: 'ADJUST', userId: actor.id, note: input.reason }
          })
    await audit(tx, actor, 'stock.adjusted', 'product', input.productId, { from: before, to: input.countedQty, delta, reason: input.reason }, branchId)
    return { before, delta, movement }
  })

  await emitStock(branchId, [input.productId])
  const [stock] = await stockRows(branchId, [input.productId])
  return c.json({ stock, previousQty: result.before, delta: result.delta, movement: result.movement })
})

stockRoutes.patch('/:productId', requireRole('MANAGER'), async c => {
  const actor = c.get('actor')
  const productId = parse(id, c.req.param('productId'))
  const input = await body(c, reorderSchema)
  const branchId = branchFor(c)
  await assertProducts(actor, [productId])

  await prisma.$transaction(async tx => {
    const before = await lockStock(tx, branchId, productId)
    const row = await tx.stock.findUniqueOrThrow({ where: { branchId_productId: { branchId, productId } } })
    await tx.stock.update({ where: { branchId_productId: { branchId, productId } }, data: { reorderAt: input.reorderAt } })
    await audit(tx, actor, 'stock.reorder_changed', 'product', productId, { from: row.reorderAt, to: input.reorderAt, qty: before }, branchId)
  })

  await emitStock(branchId, [productId])
  const [stock] = await stockRows(branchId, [productId])
  return c.json({ stock })
})
