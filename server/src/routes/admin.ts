import { Hono } from 'hono'
import { z } from 'zod'
import { prisma, Prisma, type Role, type Tx } from '../db.js'
import { audit } from '../lib/audit.js'
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors.js'
import { body, id, parse } from '../lib/validate.js'
import { createStaff, pinSchemaRule, setPin } from '../lib/users.js'
import { requireRole, type Actor, type AppEnv } from '../middleware/auth.js'
import { ensureStockRows } from '../rules/catalog.js'

export const adminRoutes = new Hono<AppEnv>()

const branchName = z.string().trim().min(2, 'Branch name is too short').max(60)
const role = z.enum(['CASHIER', 'MANAGER', 'OWNER'])
const pin = z.string().regex(pinSchemaRule, 'PIN is 4 to 6 digits')
const branchIds = z.array(id).max(50)

const createBranchSchema = z.object({ name: branchName })
const patchBranchSchema = z
  .object({ name: branchName.optional(), active: z.boolean().optional() })
  .refine(v => Object.keys(v).length > 0, 'Nothing to change')

const createUserSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  username: z
    .string()
    .trim()
    .regex(/^[a-z0-9._]{3,32}$/, 'Username is 3 to 32 lowercase letters, digits, dots or underscores'),
  pin,
  role,
  branchIds: branchIds.default([])
})
const patchUserSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    role: role.optional(),
    branchIds: branchIds.optional(),
    active: z.boolean().optional()
  })
  .refine(v => Object.keys(v).length > 0, 'Nothing to change')
const pinSchema = z.object({ pin })

const isUnique = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'

// ---------- Branches ----------

const branchSelect = { id: true, name: true, active: true, createdAt: true } as const

adminRoutes.get('/branches', requireRole('OWNER'), async c => {
  const actor = c.get('actor')
  const branches = await prisma.branch.findMany({ where: { businessId: actor.businessId }, select: branchSelect, orderBy: { name: 'asc' } })
  return c.json({ branches })
})

adminRoutes.post('/branches', requireRole('OWNER'), async c => {
  const actor = c.get('actor')
  const input = await body(c, createBranchSchema)
  const taken = await prisma.branch.findFirst({ where: { businessId: actor.businessId, name: { equals: input.name, mode: 'insensitive' } } })
  if (taken) throw conflict(`There is already a branch called ${taken.name}.`, 'duplicate_branch')
  try {
    const branch = await prisma.$transaction(async tx => {
      const b = await tx.branch.create({ data: { businessId: actor.businessId, name: input.name }, select: branchSelect })
      const products = await tx.product.findMany({ where: { businessId: actor.businessId, active: true }, select: { id: true } })
      await ensureStockRows(tx, [b.id], products.map(p => p.id))
      await audit(tx, actor, 'branch.created', 'branch', b.id, { name: b.name }, b.id)
      return b
    })
    return c.json({ branch }, 201)
  } catch (err) {
    if (isUnique(err)) throw conflict(`There is already a branch called ${input.name}.`, 'duplicate_branch')
    throw err
  }
})

adminRoutes.patch('/branches/:id', requireRole('OWNER'), async c => {
  const actor = c.get('actor')
  const branchId = parse(id, c.req.param('id'))
  const input = await body(c, patchBranchSchema)
  const before = await prisma.branch.findFirst({ where: { id: branchId, businessId: actor.businessId } })
  if (!before) throw notFound('Branch')
  if (input.name && input.name.toLowerCase() !== before.name.toLowerCase()) {
    const taken = await prisma.branch.findFirst({
      where: { businessId: actor.businessId, name: { equals: input.name, mode: 'insensitive' }, id: { not: branchId } }
    })
    if (taken) throw conflict(`There is already a branch called ${taken.name}.`, 'duplicate_branch')
  }
  try {
    const branch = await prisma.$transaction(async tx => {
      if (input.active === false && before.active) {
        const others = await tx.branch.count({ where: { businessId: actor.businessId, active: true, id: { not: branchId } } })
        if (!others) throw unprocessable('A business needs at least one active branch.', 'last_branch')
      }
      const b = await tx.branch.update({ where: { id: branchId }, data: input, select: branchSelect })
      if (input.active === true && !before.active) {
        const products = await tx.product.findMany({ where: { businessId: actor.businessId, active: true }, select: { id: true } })
        await ensureStockRows(tx, [b.id], products.map(p => p.id))
      }
      await audit(tx, actor, 'branch.updated', 'branch', b.id, { from: { name: before.name, active: before.active }, to: { name: b.name, active: b.active } }, b.id)
      return b
    })
    return c.json({ branch })
  } catch (err) {
    if (isUnique(err)) throw conflict('There is already a branch with that name.', 'duplicate_branch')
    throw err
  }
})

// ---------- Users ----------

const userSelect = {
  id: true,
  name: true,
  username: true,
  role: true,
  active: true,
  lockedUntil: true,
  createdAt: true,
  updatedAt: true,
  branches: { select: { branch: { select: { id: true, name: true } } } }
} as const

type UserRow = Prisma.UserGetPayload<{ select: typeof userSelect }>

// Never includes the PIN hash or account rows.
const toUserDTO = (u: UserRow) => ({
  id: u.id,
  name: u.name,
  username: u.username,
  role: u.role,
  active: u.active,
  locked: !!u.lockedUntil && u.lockedUntil > new Date(),
  branchIds: u.branches.map(b => b.branch.id),
  branches: u.branches.map(b => b.branch).sort((a, b) => a.name.localeCompare(b.name)),
  createdAt: u.createdAt,
  updatedAt: u.updatedAt
})

async function assertBranchesInBusiness(db: Tx | typeof prisma, actor: Actor, ids: string[]) {
  const unique = [...new Set(ids)]
  if (!unique.length) return unique
  const found = await db.branch.count({ where: { id: { in: unique }, businessId: actor.businessId, active: true } })
  if (found !== unique.length) throw badRequest('One or more branches do not exist in this business.')
  return unique
}

async function loadUser(actor: Actor, userId: string) {
  const u = await prisma.user.findFirst({ where: { id: userId, businessId: actor.businessId }, select: userSelect })
  if (!u) throw notFound('User')
  return u
}

adminRoutes.get('/users', requireRole('MANAGER'), async c => {
  const actor = c.get('actor')
  const where: Prisma.UserWhereInput = { businessId: actor.businessId }
  // Managers get a read only view of the people in their own branches.
  if (actor.role !== 'OWNER') where.branches = { some: { branchId: { in: actor.branchIds } } }
  const users = await prisma.user.findMany({ where, select: userSelect, orderBy: [{ name: 'asc' }, { id: 'asc' }] })
  return c.json({ users: users.map(toUserDTO) })
})

adminRoutes.post('/users', requireRole('OWNER'), async c => {
  const actor = c.get('actor')
  const input = await body(c, createUserSchema)
  const ids = input.role === 'OWNER' ? [] : await assertBranchesInBusiness(prisma, actor, input.branchIds)
  if (input.role !== 'OWNER' && !ids.length) throw badRequest('Pick at least one branch for this person.')
  const dupe = () => conflict(`The username ${input.username} is already taken.`, 'duplicate_username')
  if (await prisma.user.findUnique({ where: { username: input.username } })) throw dupe()

  try {
    const userId = await prisma.$transaction(async tx => {
      const u = await createStaff(tx, { businessId: actor.businessId, name: input.name, username: input.username, pin: input.pin, role: input.role, branchIds: ids })
      await audit(tx, actor, 'user.created', 'user', u.id, { name: u.name, username: u.username, role: u.role, branchIds: ids })
      return u.id
    })
    return c.json({ user: toUserDTO(await loadUser(actor, userId)) }, 201)
  } catch (err) {
    if (isUnique(err)) throw dupe()
    throw err
  }
})

// Locks every owner row of the business so two owners cannot remove each
// other at the same moment and leave nobody in charge.
async function lockOwners(tx: Tx, businessId: string) {
  await tx.$queryRaw`SELECT id FROM "user" WHERE "businessId" = ${businessId} AND role = 'OWNER' FOR UPDATE`
}

adminRoutes.patch('/users/:id', requireRole('OWNER'), async c => {
  const actor = c.get('actor')
  const userId = parse(id, c.req.param('id'))
  const input = await body(c, patchUserSchema)
  const before = await loadUser(actor, userId)

  const nextRole: Role = input.role ?? before.role
  const nextActive = input.active ?? before.active
  let nextBranches = before.branches.map(b => b.branch.id)
  if (input.branchIds) nextBranches = await assertBranchesInBusiness(prisma, actor, input.branchIds)
  if (nextRole === 'OWNER' && input.branchIds === undefined && input.role === 'OWNER') nextBranches = []
  if (nextRole !== 'OWNER' && nextActive && !nextBranches.length) throw badRequest('Pick at least one branch for this person.')

  const user = await prisma.$transaction(async tx => {
    const removingOwner = before.role === 'OWNER' && before.active && (nextRole !== 'OWNER' || !nextActive)
    if (removingOwner) {
      await lockOwners(tx, actor.businessId)
      const others = await tx.user.count({ where: { businessId: actor.businessId, role: 'OWNER', active: true, id: { not: userId } } })
      if (!others) throw unprocessable('This is the last active owner. Add another owner first.', 'last_owner')
    }
    if (userId === actor.id && (nextRole !== 'OWNER' || !nextActive)) {
      throw unprocessable('You cannot switch off or demote yourself. Ask another owner.', 'cannot_change_self')
    }

    const branchesChanged =
      input.branchIds !== undefined || (input.role === 'OWNER' && before.role !== 'OWNER')
    await tx.user.update({
      where: { id: userId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.active !== undefined ? { active: input.active } : {})
      }
    })
    if (branchesChanged) {
      await tx.userBranch.deleteMany({ where: { userId } })
      if (nextBranches.length) await tx.userBranch.createMany({ data: nextBranches.map(branchId => ({ userId, branchId })) })
    }
    const before_ = { name: before.name, role: before.role, active: before.active, branchIds: before.branches.map(b => b.branch.id) }
    const after = { name: input.name ?? before.name, role: nextRole, active: nextActive, branchIds: branchesChanged ? nextBranches : before_.branchIds }

    // Access changes take effect at once: sign the person out everywhere.
    const accessChanged =
      after.role !== before_.role ||
      after.active !== before_.active ||
      [...after.branchIds].sort().join() !== [...before_.branchIds].sort().join()
    let sessionsEnded = 0
    if (accessChanged) sessionsEnded = (await tx.session.deleteMany({ where: { userId } })).count
    await audit(tx, actor, 'user.updated', 'user', userId, { from: before_, to: after, sessionsEnded })
    return tx.user.findUniqueOrThrow({ where: { id: userId }, select: userSelect })
  })
  return c.json({ user: toUserDTO(user) })
})

adminRoutes.post('/users/:id/pin', requireRole('OWNER'), async c => {
  const actor = c.get('actor')
  const userId = parse(id, c.req.param('id'))
  const input = await body(c, pinSchema)
  await loadUser(actor, userId)
  const user = await prisma.$transaction(async tx => {
    await setPin(tx, userId, input.pin)
    await tx.user.update({ where: { id: userId }, data: { failedPins: 0, lockedUntil: null } })
    const ended = await tx.session.deleteMany({ where: { userId } })
    await audit(tx, actor, 'user.pin_reset', 'user', userId, { sessionsEnded: ended.count })
    return tx.user.findUniqueOrThrow({ where: { id: userId }, select: userSelect })
  })
  return c.json({ user: toUserDTO(user) })
})
