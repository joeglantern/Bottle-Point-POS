import { Hono } from 'hono'
import { z } from 'zod'
import { prisma, Prisma, type Product, type Tx } from '../db.js'
import { audit } from '../lib/audit.js'
import { AppError, conflict, notFound } from '../lib/errors.js'
import { body, id, parse, positiveCents, query } from '../lib/validate.js'
import { atLeast, requireRole, type Actor, type AppEnv } from '../middleware/auth.js'
import { emitToBusiness, Events } from '../realtime.js'
import { barcode, ensureStockRows, stockBranchFor, toProductDTO } from '../rules/catalog.js'
import { assertWithinPlan } from '../rules/usage.js'

export const productRoutes = new Hono<AppEnv>()

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(40).optional(),
  includeInactive: z.enum(['true', 'false', '1', '0']).optional(),
  branchId: z.string().optional()
})

const fields = {
  name: z.string().trim().min(1, 'Name is required').max(120),
  category: z.string().trim().min(1, 'Category is required').max(40),
  sizeMl: z.number().int().min(1).max(100_000).nullable(),
  barcode: barcode.nullable(),
  priceCents: positiveCents
}

const createSchema = z.object({
  name: fields.name,
  category: fields.category,
  sizeMl: fields.sizeMl.optional(),
  barcode: fields.barcode.optional(),
  priceCents: fields.priceCents
})

const patchSchema = z
  .object({
    name: fields.name.optional(),
    category: fields.category.optional(),
    sizeMl: fields.sizeMl.optional(),
    barcode: fields.barcode.optional(),
    priceCents: fields.priceCents.optional(),
    active: z.boolean().optional()
  })
  .refine(v => Object.keys(v).length > 0, 'Nothing to change')

const duplicateBarcode = (code: string) => conflict(`Another product already uses barcode ${code}.`, 'duplicate_barcode')

function isUniqueError(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}

// Plan limits are a count then an insert. Taking this lock first means two
// requests at the limit cannot both pass the count. Always taken before the
// product row lock, never after it.
async function lockBusiness(tx: Tx, businessId: string) {
  await tx.$queryRaw`SELECT id FROM "Business" WHERE id = ${businessId} FOR UPDATE`
}

async function stockFor(branchId: string | null, productIds: string[]) {
  if (!branchId || !productIds.length) return new Map()
  const rows = await prisma.stock.findMany({ where: { branchId, productId: { in: productIds } } })
  return new Map(rows.map(r => [r.productId, r]))
}

async function loadProduct(actor: Actor, productId: string) {
  const p = await prisma.product.findFirst({ where: { id: productId, businessId: actor.businessId } })
  if (!p) throw notFound('Product')
  return p
}

function broadcast(p: Product) {
  emitToBusiness(p.businessId, Events.productUpdated, { product: toProductDTO(p) })
}

productRoutes.get('/', async c => {
  const actor = c.get('actor')
  const q = query(c, listQuery)
  const branchId = stockBranchFor(c)
  const includeInactive = (q.includeInactive === 'true' || q.includeInactive === '1') && atLeast(actor, 'MANAGER')

  const where: Prisma.ProductWhereInput = { businessId: actor.businessId }
  if (!includeInactive) where.active = true
  if (q.category) where.category = { equals: q.category, mode: 'insensitive' }
  if (q.q) {
    where.OR = [{ name: { contains: q.q, mode: 'insensitive' } }, { barcode: { startsWith: q.q } }]
  }
  const products = await prisma.product.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 1000 })
  const stock = await stockFor(branchId, products.map(p => p.id))
  return c.json({ branchId, products: products.map(p => toProductDTO(p, branchId ? (stock.get(p.id) ?? null) : null)) })
})

productRoutes.get('/categories', async c => {
  const actor = c.get('actor')
  const rows = await prisma.product.findMany({
    where: { businessId: actor.businessId, active: true },
    distinct: ['category'],
    select: { category: true },
    orderBy: { category: 'asc' }
  })
  return c.json({ categories: rows.map(r => r.category) })
})

productRoutes.get('/barcode/:code', async c => {
  const actor = c.get('actor')
  const code = c.req.param('code').trim()
  const branchId = stockBranchFor(c)
  const p = /^\d{6,14}$/.test(code)
    ? await prisma.product.findFirst({ where: { businessId: actor.businessId, barcode: code, active: true } })
    : null
  if (!p) throw new AppError(404, 'not_found', `No product has barcode ${code.slice(0, 20)}. Check the code or add the product first.`)
  const stock = await stockFor(branchId, [p.id])
  return c.json({ product: toProductDTO(p, branchId ? (stock.get(p.id) ?? null) : null) })
})

productRoutes.get('/:id', async c => {
  const actor = c.get('actor')
  const p = await loadProduct(actor, parse(id, c.req.param('id')))
  const branchId = stockBranchFor(c)
  const stock = await stockFor(branchId, [p.id])
  return c.json({ product: toProductDTO(p, branchId ? (stock.get(p.id) ?? null) : null) })
})

productRoutes.post('/', requireRole('MANAGER'), async c => {
  const actor = c.get('actor')
  const input = await body(c, createSchema)
  if (input.barcode) {
    const taken = await prisma.product.findFirst({ where: { businessId: actor.businessId, barcode: input.barcode } })
    if (taken) throw duplicateBarcode(input.barcode)
  }
  let product: Product
  try {
    product = await prisma.$transaction(async tx => {
      await lockBusiness(tx, actor.businessId)
      await assertWithinPlan(tx, actor.businessId, 'products')
      const p = await tx.product.create({
        data: {
          businessId: actor.businessId,
          name: input.name,
          category: input.category,
          sizeMl: input.sizeMl ?? null,
          barcode: input.barcode ?? null,
          priceCents: input.priceCents
        }
      })
      const branches = await tx.branch.findMany({ where: { businessId: actor.businessId, active: true }, select: { id: true } })
      await ensureStockRows(tx, branches.map(b => b.id), [p.id])
      await audit(tx, actor, 'product.created', 'product', p.id, { ...input })
      return p
    })
  } catch (err) {
    if (isUniqueError(err) && input.barcode) throw duplicateBarcode(input.barcode)
    throw err
  }
  broadcast(product)
  return c.json({ product: toProductDTO(product) }, 201)
})

productRoutes.patch('/:id', requireRole('MANAGER'), async c => {
  const actor = c.get('actor')
  const productId = parse(id, c.req.param('id'))
  const input = await body(c, patchSchema)
  await loadProduct(actor, productId)
  if (input.barcode) {
    const taken = await prisma.product.findFirst({
      where: { businessId: actor.businessId, barcode: input.barcode, id: { not: productId } }
    })
    if (taken) throw duplicateBarcode(input.barcode)
  }
  let product: Product
  try {
    product = await prisma.$transaction(async tx => {
      // Only a request that may bring an archived product back needs the
      // business lock. It comes before the product lock, in the same order as
      // every other path.
      if (input.active === true) await lockBusiness(tx, actor.businessId)
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`
      if (!rows.length) throw notFound('Product')
      const before = await tx.product.findUniqueOrThrow({ where: { id: productId } })
      // Bringing an archived product back uses a place on the plan. A product
      // that is already on sale adds nothing and is never refused.
      if (input.active === true && !before.active) await assertWithinPlan(tx, actor.businessId, 'products')
      const p = await tx.product.update({ where: { id: productId }, data: input })
      // Sale lines keep their own price snapshot, so this never rewrites history.
      if (input.priceCents !== undefined && input.priceCents !== before.priceCents) {
        await audit(tx, actor, 'product.price_changed', 'product', p.id, {
          name: p.name,
          oldPriceCents: before.priceCents,
          newPriceCents: p.priceCents
        })
      }
      const changes: Record<string, { from: unknown; to: unknown }> = {}
      for (const k of Object.keys(input) as (keyof typeof input)[]) {
        if (k === 'priceCents') continue
        if (before[k] !== p[k]) changes[k] = { from: before[k], to: p[k] }
      }
      if (Object.keys(changes).length) await audit(tx, actor, 'product.updated', 'product', p.id, { changes })
      if (input.active === true && !before.active) {
        const branches = await tx.branch.findMany({ where: { businessId: actor.businessId, active: true }, select: { id: true } })
        await ensureStockRows(tx, branches.map(b => b.id), [p.id])
      }
      return p
    })
  } catch (err) {
    if (isUniqueError(err) && input.barcode) throw duplicateBarcode(input.barcode)
    throw err
  }
  broadcast(product)
  return c.json({ product: toProductDTO(product) })
})

// Soft delete: old sales still point at the product.
productRoutes.delete('/:id', requireRole('MANAGER'), async c => {
  const actor = c.get('actor')
  const productId = parse(id, c.req.param('id'))
  await loadProduct(actor, productId)
  const product = await prisma.$transaction(async tx => {
    const p = await tx.product.update({ where: { id: productId }, data: { active: false } })
    await audit(tx, actor, 'product.deactivated', 'product', p.id, { name: p.name })
    return p
  })
  broadcast(product)
  return c.json({ product: toProductDTO(product) })
})
