import type { Context, MiddlewareHandler } from 'hono'
import { auth } from '../auth.js'
import { prisma, type Role } from '../db.js'
import { forbidden, unauthorized } from '../lib/errors.js'

export type Actor = {
  id: string
  name: string
  username: string
  role: Role
  businessId: string
  // branches this person may act in. Owners get every branch of the business.
  branchIds: string[]
}

export type AppEnv = { Variables: { actor: Actor } }

const RANK: Record<Role, number> = { CASHIER: 1, MANAGER: 2, OWNER: 3 }
export const atLeast = (actor: Actor, role: Role) => RANK[actor.role] >= RANK[role]

export async function loadActor(userId: string): Promise<Actor | null> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    include: { branches: true }
  })
  if (!u || !u.active || !u.businessId) return null
  let branchIds = u.branches.map(b => b.branchId)
  if (u.role === 'OWNER') {
    const all = await prisma.branch.findMany({ where: { businessId: u.businessId, active: true }, select: { id: true } })
    branchIds = all.map(b => b.id)
  }
  return {
    id: u.id,
    name: u.name,
    username: u.username ?? '',
    role: u.role,
    businessId: u.businessId,
    branchIds
  }
}

export async function actorFromHeaders(headers: Headers): Promise<Actor | null> {
  const session = await auth.api.getSession({ headers })
  if (!session) return null
  return loadActor(session.user.id)
}

// Every API route except sign in goes through this.
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const actor = await actorFromHeaders(c.req.raw.headers)
  if (!actor) throw unauthorized()
  c.set('actor', actor)
  await next()
}

export const requireRole = (role: Role): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (!atLeast(c.get('actor'), role)) throw forbidden()
  await next()
}

export function assertRole(actor: Actor, role: Role) {
  if (!atLeast(actor, role)) throw forbidden()
}

// Which branch this request acts on. Taken from (in order) the explicit
// argument, the ?branchId query, or the X-Branch-Id header. Falls back to the
// user's only branch. Always checked against what the user may access.
export function branchFor(c: Context<AppEnv>, explicit?: string | null): string {
  const actor = c.get('actor')
  const wanted = explicit ?? c.req.query('branchId') ?? c.req.header('x-branch-id') ?? null
  if (wanted) {
    assertBranch(actor, wanted)
    return wanted
  }
  if (actor.branchIds.length === 1) return actor.branchIds[0]!
  throw forbidden('Pick a branch first.')
}

export function assertBranch(actor: Actor, branchId: string) {
  if (!actor.branchIds.includes(branchId)) throw forbidden('You do not have access to this branch.')
}
