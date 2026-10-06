import { Hono } from 'hono'
import { z } from 'zod'
import { prisma, type Plan } from '../../db.js'
import { platformAudit } from '../../lib/audit.js'
import { badRequest, conflict, notFound } from '../../lib/errors.js'
import { body, cents, query } from '../../lib/validate.js'
import { allowPlatform, type ConsoleEnv } from '../../middleware/platform.js'
import { describePrice } from '../../rules/pricing.js'

export const planRoutes = new Hono<ConsoleEnv>()

const limit = z.number().int().min(1).max(100_000).nullable()

// Fields that may be set on create and changed later. `code` is not here:
// invoices and audit rows refer to it, so it never changes.
const editable = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable(),
  model: z.enum(['FLAT', 'PER_BRANCH', 'PERCENT_OF_SALES', 'ONE_TIME']),
  interval: z.enum(['MONTH', 'YEAR', 'ONCE']),
  priceCents: cents,
  perBranchCents: cents,
  percentBps: z.number().int().min(0).max(10_000),
  minimumCents: cents,
  trialDays: z.number().int().min(0).max(365),
  maxBranches: limit,
  maxStaff: limit,
  maxProducts: limit,
  features: z.record(z.string(), z.unknown()),
  public: z.boolean(),
  sortOrder: z.number().int().min(-1000).max(1000)
}

const createSchema = z.object({
  ...editable,
  code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase letters, digits and dashes'),
  description: editable.description.optional(),
  interval: editable.interval.optional(),
  priceCents: cents.default(0),
  perBranchCents: cents.default(0),
  percentBps: editable.percentBps.default(0),
  minimumCents: cents.default(0),
  trialDays: editable.trialDays.default(14),
  maxBranches: limit.optional(),
  maxStaff: limit.optional(),
  maxProducts: limit.optional(),
  features: editable.features.default({}),
  public: z.boolean().default(true),
  sortOrder: editable.sortOrder.default(0)
})

const patchSchema = z.object({ ...editable, code: z.string() }).partial()

type Terms = Pick<Plan, 'model' | 'interval' | 'priceCents' | 'perBranchCents' | 'percentBps'>

// Each pricing model needs its own numbers to make sense. Checked on the
// plan as it would be saved, so a partial edit cannot leave it half valid.
function assertTerms(p: Terms) {
  const errors: Record<string, string[]> = {}
  const bad = (field: string, msg: string) => (errors[field] = [...(errors[field] ?? []), msg])
  if (p.model === 'FLAT') {
    if (p.interval === 'ONCE') bad('interval', 'A flat plan is billed every month or every year')
  } else if (p.model === 'PER_BRANCH') {
    if (p.perBranchCents <= 0) bad('perBranchCents', 'A per branch plan needs a price per branch')
    if (p.interval === 'ONCE') bad('interval', 'A per branch plan is billed every month or every year')
  } else if (p.model === 'PERCENT_OF_SALES') {
    if (p.percentBps < 1 || p.percentBps > 5000) bad('percentBps', 'The share of sales must be between 0.01% and 50%')
    if (p.interval !== 'MONTH') bad('interval', 'A share of sales plan is billed every month')
  } else {
    if (p.interval !== 'ONCE') bad('interval', 'A one time licence is billed once')
  }
  if (Object.keys(errors).length) throw badRequest('Invalid input.', { formErrors: [], fieldErrors: errors })
}

const view = (plan: Plan, clients: number) => ({
  id: plan.id,
  code: plan.code,
  name: plan.name,
  description: plan.description,
  model: plan.model,
  interval: plan.interval,
  priceCents: plan.priceCents,
  perBranchCents: plan.perBranchCents,
  percentBps: plan.percentBps,
  minimumCents: plan.minimumCents,
  trialDays: plan.trialDays,
  maxBranches: plan.maxBranches,
  maxStaff: plan.maxStaff,
  maxProducts: plan.maxProducts,
  features: plan.features,
  active: plan.active,
  public: plan.public,
  sortOrder: plan.sortOrder,
  createdAt: plan.createdAt,
  updatedAt: plan.updatedAt,
  priceText: describePrice(plan),
  clients
})

// Clients on each plan. Cancelled subscriptions are no longer clients of it.
async function clientCounts(planIds?: string[]) {
  const rows = await prisma.subscription.groupBy({
    by: ['planId'],
    where: { status: { not: 'CANCELLED' }, ...(planIds ? { planId: { in: planIds } } : {}) },
    _count: { _all: true }
  })
  return new Map(rows.map(r => [r.planId, r._count._all]))
}

async function viewOf(plan: Plan) {
  return view(plan, (await clientCounts([plan.id])).get(plan.id) ?? 0)
}

planRoutes.get('/plans', async c => {
  const q = query(c, z.object({ includeArchived: z.enum(['true', 'false', '1', '0']).optional() }))
  const all = q.includeArchived === 'true' || q.includeArchived === '1'
  const [plans, counts] = await Promise.all([
    prisma.plan.findMany({ where: all ? {} : { active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    clientCounts()
  ])
  return c.json({ plans: plans.map(p => view(p, counts.get(p.id) ?? 0)) })
})

planRoutes.get('/plans/:id', async c => {
  const plan = await prisma.plan.findUnique({ where: { id: c.req.param('id') } })
  if (!plan) throw notFound('Plan')
  return c.json({ plan: await viewOf(plan) })
})

planRoutes.post('/plans', allowPlatform('BILLING'), async c => {
  const platform = c.get('platform')
  const input = await body(c, createSchema)
  const interval = input.interval ?? (input.model === 'ONE_TIME' ? 'ONCE' : 'MONTH')
  assertTerms({ ...input, interval })
  const plan = await prisma.$transaction(async tx => {
    if (await tx.plan.findUnique({ where: { code: input.code } })) {
      throw conflict(`There is already a plan with the code "${input.code}".`, 'duplicate_code')
    }
    const created = await tx.plan.create({
      data: { ...input, interval, description: input.description || null, features: input.features as never }
    })
    await platformAudit(tx, platform, 'console.plan.created', 'Plan', created.id, {
      code: created.code,
      name: created.name,
      model: created.model,
      priceText: describePrice(created)
    })
    return created
  })
  return c.json({ plan: view(plan, 0) }, 201)
})

planRoutes.patch('/plans/:id', allowPlatform('BILLING'), async c => {
  const platform = c.get('platform')
  const planId = c.req.param('id')
  const { code, ...input } = await body(c, patchSchema)
  const plan = await prisma.$transaction(async tx => {
    // two edits at once must not validate against each other's stale copy
    await tx.$queryRaw`SELECT "id" FROM "Plan" WHERE "id" = ${planId} FOR UPDATE`
    const before = await tx.plan.findUnique({ where: { id: planId } })
    if (!before) throw notFound('Plan')
    if (code !== undefined && code !== before.code) {
      throw badRequest('Invalid input.', { formErrors: [], fieldErrors: { code: ['The plan code cannot be changed'] } })
    }
    assertTerms({ ...before, ...input })
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    for (const [key, to] of Object.entries(input)) {
      const from = (before as Record<string, unknown>)[key]
      if (to !== undefined && JSON.stringify(from) !== JSON.stringify(to)) changes[key] = { from, to }
    }
    if (!Object.keys(changes).length) return before
    // Issued invoices carry their own lines and totals, so a new price only
    // reaches invoices raised from now on.
    const updated = await tx.plan.update({
      where: { id: planId },
      data: { ...input, features: input.features as never }
    })
    await platformAudit(tx, platform, 'console.plan.updated', 'Plan', planId, {
      code: updated.code,
      name: updated.name,
      priceText: describePrice(updated),
      changes
    })
    return updated
  })
  return c.json({ plan: await viewOf(plan) })
})

// Archiving hides a plan from new clients. The clients already on it stay.
const setActive = (active: boolean) =>
  planRoutes.post(`/plans/:id/${active ? 'unarchive' : 'archive'}`, allowPlatform('BILLING'), async c => {
    const platform = c.get('platform')
    const planId = c.req.param('id')
    const plan = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Plan" WHERE "id" = ${planId} FOR UPDATE`
      const before = await tx.plan.findUnique({ where: { id: planId } })
      if (!before) throw notFound('Plan')
      if (before.active === active) return before
      const updated = await tx.plan.update({ where: { id: planId }, data: { active } })
      await platformAudit(tx, platform, active ? 'console.plan.unarchived' : 'console.plan.archived', 'Plan', planId, {
        code: updated.code,
        name: updated.name
      })
      return updated
    })
    return c.json({ plan: await viewOf(plan) })
  })

setActive(false)
setActive(true)
