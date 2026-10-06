// How much of its plan a client is using. Shared by the console (client
// pages), the client's own billing page and the checks that stop a shop from
// going over its plan.

import type { Db, Plan } from '../db.js'
import { paymentRequired } from '../lib/errors.js'

export type Usage = { branches: number; staff: number; products: number }
export type Limits = Pick<Plan, 'maxBranches' | 'maxStaff' | 'maxProducts'>

// Active branches, staff who can sign in, and products on sale.
export async function usageFor(db: Db, businessId: string): Promise<Usage> {
  const [branches, staff, products] = await Promise.all([
    db.branch.count({ where: { businessId, active: true } }),
    db.user.count({ where: { businessId, active: true } }),
    db.product.count({ where: { businessId, active: true } })
  ])
  return { branches, staff, products }
}

// The limits of the client's current plan, or null when it has no
// subscription record (nothing is limited then).
export async function limitsFor(db: Db, businessId: string): Promise<(Limits & { planName: string }) | null> {
  const sub = await db.subscription.findUnique({ where: { businessId }, include: { plan: true } })
  if (!sub) return null
  const { maxBranches, maxStaff, maxProducts, name } = sub.plan
  return { maxBranches, maxStaff, maxProducts, planName: name }
}

const LABEL = { branches: 'branches', staff: 'staff members', products: 'products' } as const
const FIELD = { branches: 'maxBranches', staff: 'maxStaff', products: 'maxProducts' } as const

// Call inside the transaction that is about to add `adding` more of something.
// Throws 402 plan_limit when the plan does not allow it.
export async function assertWithinPlan(db: Db, businessId: string, what: keyof Usage, adding = 1) {
  const limits = await limitsFor(db, businessId)
  if (!limits) return
  const max = limits[FIELD[what]]
  if (max == null) return
  const used = (await usageFor(db, businessId))[what]
  if (used + adding > max) {
    throw paymentRequired(
      `The ${limits.planName} plan allows ${max} ${LABEL[what]} and you have ${used}. Upgrade the plan to add more.`,
      'plan_limit',
      { what, used, max }
    )
  }
}

// Paid sales net of refunds between two instants, across all branches.
export async function salesCentsBetween(db: Db, businessId: string, from: Date, to: Date): Promise<number> {
  const [paid, refunded] = await Promise.all([
    db.sale.aggregate({
      where: { branch: { businessId }, status: { in: ['PAID', 'REFUNDED'] }, paidAt: { gte: from, lt: to } },
      _sum: { totalCents: true }
    }),
    db.refund.aggregate({ where: { sale: { branch: { businessId } }, createdAt: { gte: from, lt: to } }, _sum: { amountCents: true } })
  ])
  return (paid._sum.totalCents ?? 0) - (refunded._sum.amountCents ?? 0)
}
