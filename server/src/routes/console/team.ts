import { Hono } from 'hono'
import { z } from 'zod'
import { prisma, type Tx, type User } from '../../db.js'
import { platformAudit } from '../../lib/audit.js'
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js'
import { createPlatformUser, setPassword } from '../../lib/users.js'
import { body, id as idRule, parse } from '../../lib/validate.js'
import { allowPlatform, type ConsoleEnv } from '../../middleware/platform.js'
import { temporaryPassword } from '../../rules/platform.js'

// The platform team: who can sign in to the console and with which role.
// Anyone on the team may see the list. Only a SUPER_ADMIN changes it.
export const teamRoutes = new Hono<ConsoleEnv>()

// Shop staff get an address under this domain when they are created, so a
// console user may never take one.
const STAFF_EMAIL_DOMAIN = '@staff.bottlepoint.local'

const roleRule = z.enum(['SUPER_ADMIN', 'SUPPORT', 'BILLING'])
const nameRule = z.string().trim().min(2, 'Enter the full name').max(80)

const createBody = z.object({
  name: nameRule,
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(200),
  role: roleRule
})

const patchBody = z
  .object({ name: nameRule.optional(), role: roleRule.optional(), active: z.boolean().optional() })
  .refine(v => v.name !== undefined || v.role !== undefined || v.active !== undefined, 'Nothing to change')

type Member = Pick<User, 'id' | 'name' | 'email' | 'platformRole' | 'active' | 'lockedUntil' | 'createdAt'>

const shape = (u: Member, lastSignInAt: Date | null = null) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.platformRole,
  active: u.active,
  locked: !!u.lockedUntil && u.lockedUntil > new Date(),
  createdAt: u.createdAt,
  lastSignInAt
})

const isUniqueError = (err: unknown) => (err as { code?: string } | null)?.code === 'P2002'

// Every change to the team takes this lock first, so two requests cannot
// both pass the "is there another super admin" check and remove the last two.
async function lockTeam(tx: Tx) {
  await tx.$queryRaw`SELECT "id" FROM "user" WHERE "platformRole" IS NOT NULL ORDER BY "id" FOR UPDATE`
}

async function member(tx: Tx, userId: string) {
  const u = await tx.user.findUnique({ where: { id: userId } })
  if (!u || !u.platformRole || u.businessId) throw notFound('Team member')
  return u
}

// The role of the caller was read before the lock. Read it again under the
// lock: a racing request may have just demoted or switched off this caller.
async function assertStillSuperAdmin(tx: Tx, userId: string) {
  const me = await tx.user.findUnique({ where: { id: userId } })
  if (!me || !me.active || me.platformRole !== 'SUPER_ADMIN') throw forbidden('Your console role does not allow this.')
}

teamRoutes.get('/team', async c => {
  const users = await prisma.user.findMany({
    where: { platformRole: { not: null }, businessId: null },
    orderBy: [{ active: 'desc' }, { name: 'asc' }]
  })
  // sessions vanish on sign out, the audit trail keeps the last sign in
  const seen = await prisma.auditLog.groupBy({
    by: ['userId'],
    where: { action: 'console.login', userId: { in: users.map(u => u.id) } },
    _max: { at: true }
  })
  const last = new Map(seen.map(s => [s.userId, s._max.at]))
  return c.json({ team: users.map(u => shape(u, last.get(u.id) ?? null)) })
})

teamRoutes.post('/team', allowPlatform(), async c => {
  const me = c.get('platform')
  const input = await body(c, createBody)
  // made here, returned once, stored only as a hash
  const password = temporaryPassword()
  try {
    const user = await prisma.$transaction(async tx => {
      if (await tx.user.findUnique({ where: { email: input.email } })) {
        throw conflict('Someone already uses that email address.', 'duplicate_email')
      }
      if (input.email.endsWith(STAFF_EMAIL_DOMAIN)) throw badRequest('That address is reserved for shop staff.')
      const created = await createPlatformUser(tx, { name: input.name, email: input.email, password, role: input.role })
      await platformAudit(tx, me, 'console.team.created', 'user', created.id, {
        name: created.name,
        email: created.email,
        role: input.role
      })
      return created
    })
    return c.json({ member: shape(user), temporaryPassword: password }, 201)
  } catch (err) {
    // two requests with the same address at the same moment
    if (isUniqueError(err)) throw conflict('Someone already uses that email address.', 'duplicate_email')
    throw err
  }
})

teamRoutes.patch('/team/:id', allowPlatform(), async c => {
  const me = c.get('platform')
  const userId = parse(idRule, c.req.param('id'))
  const input = await body(c, patchBody)

  const result = await prisma.$transaction(async tx => {
    await lockTeam(tx)
    await assertStillSuperAdmin(tx, me.id)
    const before = await member(tx, userId)
    const role = input.role ?? before.platformRole!
    const active = input.active ?? before.active
    const roleChanged = role !== before.platformRole
    const activeChanged = active !== before.active

    if (userId === me.id && (roleChanged || !active)) {
      throw unprocessable('You cannot switch off or demote your own account. Ask another super admin.', 'cannot_change_self')
    }
    const wasAdmin = before.active && before.platformRole === 'SUPER_ADMIN'
    const staysAdmin = active && role === 'SUPER_ADMIN'
    if (wasAdmin && !staysAdmin) {
      const others = await tx.user.count({
        where: { platformRole: 'SUPER_ADMIN', active: true, businessId: null, NOT: { id: userId } }
      })
      if (others === 0) throw unprocessable('The console needs at least one active super admin.', 'last_super_admin')
    }

    const changes: Record<string, { from: unknown; to: unknown }> = {}
    if (input.name !== undefined && input.name !== before.name) changes.name = { from: before.name, to: input.name }
    if (roleChanged) changes.role = { from: before.platformRole, to: role }
    if (activeChanged) changes.active = { from: before.active, to: active }

    const user = await tx.user.update({
      where: { id: userId },
      data: {
        name: input.name ?? before.name,
        platformRole: role,
        active,
        // switching someone back on also clears an old lockout
        ...(activeChanged && active ? { failedPins: 0, lockedUntil: null } : {})
      }
    })
    // a session carries the old access, so end them when access changes
    const sessionsEnded = roleChanged || activeChanged ? (await tx.session.deleteMany({ where: { userId } })).count : 0
    if (Object.keys(changes).length) {
      await platformAudit(tx, me, 'console.team.updated', 'user', userId, {
        name: user.name,
        email: user.email,
        changes,
        sessionsEnded
      })
    }
    return { user, sessionsEnded }
  })
  return c.json({ member: shape(result.user), sessionsEnded: result.sessionsEnded })
})

teamRoutes.post('/team/:id/reset-password', allowPlatform(), async c => {
  const me = c.get('platform')
  const userId = parse(idRule, c.req.param('id'))
  const password = temporaryPassword()

  const result = await prisma.$transaction(async tx => {
    await lockTeam(tx)
    await assertStillSuperAdmin(tx, me.id)
    const before = await member(tx, userId)
    await setPassword(tx, userId, password)
    const user = await tx.user.update({ where: { id: userId }, data: { failedPins: 0, lockedUntil: null } })
    const sessionsEnded = (await tx.session.deleteMany({ where: { userId } })).count
    await platformAudit(tx, me, 'console.team.password_reset', 'user', userId, {
      name: before.name,
      email: before.email,
      sessionsEnded
    })
    return { user, sessionsEnded }
  })
  return c.json({ member: shape(result.user), temporaryPassword: password, sessionsEnded: result.sessionsEnded })
})
