// Sale helpers used by the sales routes: access checks and line pricing.
// Payments and the PAID transition live in sale-core.ts (applyPayment).

import { z } from 'zod'
import type { Db } from '../db.js'
import type { Actor } from '../middleware/auth.js'
import { AppError, badRequest, notFound } from '../lib/errors.js'
import { id } from '../lib/validate.js'
import { loadSale } from './sale-core.js'

export const MAX_QTY = 999

export const lineInput = z.object({ productId: id, qty: z.number().int().min(1).max(MAX_QTY) })
export type LineInput = z.infer<typeof lineInput>

// Same product twice in one request becomes one line.
export function mergeLines(lines: LineInput[]) {
  const merged = new Map<string, number>()
  for (const l of lines) merged.set(l.productId, (merged.get(l.productId) ?? 0) + l.qty)
  for (const [productId, qty] of merged) {
    if (qty > MAX_QTY) throw badRequest(`Quantity for one product cannot be more than ${MAX_QTY}.`, { productId, qty })
  }
  return merged
}

export type PricedLine = { productId: string; name: string; unitCents: number; qty: number }

// Turns requested quantities into priced lines. Products already on the sale
// keep their snapshot (name and price at the time they were added). New
// products must belong to the business and be active, and take today's price.
export async function priceLines(
  db: Db,
  businessId: string,
  merged: Map<string, number>,
  keep: Map<string, { name: string; unitCents: number }> = new Map()
): Promise<PricedLine[]> {
  const wanted = [...merged.keys()].filter(pid => !keep.has(pid))
  const products = wanted.length
    ? await db.product.findMany({ where: { id: { in: wanted }, businessId, active: true } })
    : []
  const byId = new Map(products.map(p => [p.id, p]))
  const missing = wanted.filter(pid => !byId.has(pid))
  if (missing.length) {
    throw new AppError(422, 'unknown_product', 'One or more products are not available for sale.', { productIds: missing })
  }
  return [...merged].map(([productId, qty]) => {
    const kept = keep.get(productId)
    if (kept) return { productId, qty, name: kept.name, unitCents: kept.unitCents }
    const p = byId.get(productId)!
    return { productId, qty, name: p.name, unitCents: p.priceCents }
  })
}

export async function assertCustomer(db: Db, businessId: string, customerId: string) {
  const c = await db.customer.findFirst({ where: { id: customerId, businessId }, select: { id: true } })
  if (!c) throw new AppError(422, 'unknown_customer', 'That customer was not found.')
}

// Loads a sale the actor may see. Another branch's sale looks like it does not exist.
export async function saleForActor(db: Db, actor: Actor, saleId: string) {
  const sale = await db.sale.findUnique({ where: { id: saleId }, select: { branchId: true, branch: { select: { businessId: true } } } })
  if (!sale || sale.branch.businessId !== actor.businessId || !actor.branchIds.includes(sale.branchId)) throw notFound('Sale')
  return loadSale(db, saleId)
}

export const EDITABLE = ['SAVED', 'OPEN'] as const
export const isEditable = (status: string) => (EDITABLE as readonly string[]).includes(status)
