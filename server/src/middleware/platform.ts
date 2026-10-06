import type { MiddlewareHandler } from 'hono'
import { auth } from '../auth.js'
import { prisma, type PlatformRole } from '../db.js'
import { forbidden, unauthorized } from '../lib/errors.js'

// Staff of the company running Bottle Point. They sign in to the console
// with email and password and never belong to a client business.
export type PlatformActor = {
  id: string
  name: string
  email: string
  role: PlatformRole
}

export type ConsoleEnv = { Variables: { platform: PlatformActor } }

export async function loadPlatformActor(userId: string): Promise<PlatformActor | null> {
  const u = await prisma.user.findUnique({ where: { id: userId } })
  if (!u || !u.active || !u.platformRole || u.businessId) return null
  return { id: u.id, name: u.name, email: u.email, role: u.platformRole }
}

export async function platformFromHeaders(headers: Headers): Promise<PlatformActor | null> {
  const session = await auth.api.getSession({ headers })
  if (!session) return null
  return loadPlatformActor(session.user.id)
}

// Every console route except sign in goes through this.
export const requirePlatform: MiddlewareHandler<ConsoleEnv> = async (c, next) => {
  const platform = await platformFromHeaders(c.req.raw.headers)
  if (!platform) throw unauthorized()
  c.set('platform', platform)
  await next()
}

// SUPER_ADMIN can do everything. Other roles must be listed.
//   SUPPORT: clients, onboarding, notes, sign outs, read billing
//   BILLING: plans, subscriptions, invoices, payments, read clients
export const allowPlatform = (...roles: PlatformRole[]): MiddlewareHandler<ConsoleEnv> => async (c, next) => {
  assertPlatform(c.get('platform'), ...roles)
  await next()
}

export function assertPlatform(platform: PlatformActor, ...roles: PlatformRole[]) {
  if (platform.role === 'SUPER_ADMIN') return
  if (!roles.includes(platform.role)) throw forbidden('Your console role does not allow this.')
}
