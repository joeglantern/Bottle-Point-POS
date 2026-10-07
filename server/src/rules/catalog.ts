import type { Context } from 'hono'
import { z } from 'zod'
import type { Db, Product, Stock } from '../db.js'
import { branchFor, type AppEnv } from '../middleware/auth.js'

export const barcode = z.string().trim().regex(/^\d{6,14}$/, 'Barcode must be 6 to 14 digits')

// Branch used to show stock next to a product. An owner with several
// branches who has not picked one simply gets no stock figures.
export function stockBranchFor(c: Context<AppEnv>): string | null {
  const actor = c.get('actor')
  // a shop that does not count stock never sees stock figures
  if (!actor.trackStock) return null
  const wanted = c.req.query('branchId') ?? c.req.header('x-branch-id')
  if (wanted || actor.branchIds.length === 1) return branchFor(c)
  return null
}

export function toProductDTO(p: Product, stock?: Stock | null) {
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    sizeMl: p.sizeMl,
    barcode: p.barcode,
    priceCents: p.priceCents,
    active: p.active,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    ...(stock === undefined ? {} : { qty: stock?.qty ?? null, reorderAt: stock?.reorderAt ?? null })
  }
}
export type ProductDTO = ReturnType<typeof toProductDTO>

export function toStockDTO(p: Product, s: Stock | null | undefined, branchId: string) {
  const qty = s?.qty ?? 0
  const reorderAt = s?.reorderAt ?? 10
  return {
    branchId,
    productId: p.id,
    name: p.name,
    category: p.category,
    sizeMl: p.sizeMl,
    barcode: p.barcode,
    priceCents: p.priceCents,
    active: p.active,
    qty,
    reorderAt,
    low: qty <= reorderAt
  }
}

// Stock rows (qty 0) so a product shows up in every active branch.
export async function ensureStockRows(db: Db, branchIds: string[], productIds: string[]) {
  if (!branchIds.length || !productIds.length) return
  await db.stock.createMany({
    data: branchIds.flatMap(branchId => productIds.map(productId => ({ branchId, productId, qty: 0 }))),
    skipDuplicates: true
  })
}
