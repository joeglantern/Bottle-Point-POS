import { Hono } from 'hono'
import { z } from 'zod'
import { Prisma, prisma, type Plan, type Subscription } from '../../db.js'
import { platformAudit } from '../../lib/audit.js'
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js'
import { createStaff, pinSchemaRule, setPin } from '../../lib/users.js'
import { body, id as idRule, phone, query } from '../../lib/validate.js'
import { allowPlatform, assertPlatform, type ConsoleEnv } from '../../middleware/platform.js'
import { env } from '../../env.js'
import { forgetTenant, RESERVED_SLUGS, SLUG_RE } from '../../lib/tenant.js'
import { billedInArrears, describePrice, monthlyValueCents, periodEnd } from '../../rules/pricing.js'
import {
  DAY_MS,
  estimateNextInvoice,
  hasOverdueInvoice,
  lockSubscription,
  monthlyValue,
  paging,
  raiseSubscriptionInvoice,
  randomPin,
  requireBusiness
} from '../../rules/platform.js'
import { limitsFor, salesCentsBetween, usageFor } from '../../rules/usage.js'

// Client businesses ("tenants"): the list, onboarding, the client page,
// suspension, people, notes and history.
export const tenantRoutes = new Hono<ConsoleEnv>()

const care = allowPlatform('SUPPORT')
const STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'NONE'] as const
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

// The client's own address, for example https://nyrolix.pos.flarehub.co.ke
export const tenantUrl = (slug: string | null | undefined) =>
  slug && env.TENANT_BASE_DOMAIN ? `https://${slug}.${env.TENANT_BASE_DOMAIN}` : null

const slugRule = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SLUG_RE, 'Use 3 to 40 lowercase letters, digits or dashes, not starting or ending with a dash')
  .refine(v => !RESERVED_SLUGS.has(v), 'That address is reserved. Choose another one.')

// Two clients cannot share a username or an address.
function uniqueField(err: unknown): 'slug' | 'username' | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return null
  return JSON.stringify(err.meta ?? {}).includes('slug') ? 'slug' : 'username'
}

// ---------- list ----------

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(STATUSES).optional(),
  planId: idRule.optional(),
  sort: z.enum(['name', 'joined', 'mrr', 'sales']).default('name'),
  dir: z.enum(['asc', 'desc']).optional(),
  ...paging
})

type ListRow = {
  id: string
  name: string
  slug: string | null
  createdAt: Date
  status: (typeof STATUSES)[number]
  trialEndsAt: Date | null
  planId: string | null
  planName: string | null
  model: Plan['model'] | null
  interval: Plan['interval'] | null
  priceCents: number | null
  perBranchCents: number | null
  percentBps: number | null
  minimumCents: number | null
  discountBps: number | null
  customPriceCents: number | null
  branches: number
  staff: number
  sales: bigint
}

// q matches the client name, its id, or the username of one of its owners.
function listFilter(q: string | undefined, planId: string | undefined): Prisma.Sql {
  const conds: Prisma.Sql[] = [Prisma.sql`TRUE`]
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, m => '\\' + m)}%`
    conds.push(Prisma.sql`(b."name" ILIKE ${like} OR b."id" = ${q} OR EXISTS (
      SELECT 1 FROM "user" o WHERE o."businessId" = b."id" AND o."role" = 'OWNER' AND o."username" ILIKE ${like}))`)
  }
  if (planId) conds.push(Prisma.sql`s."planId" = ${planId}`)
  return Prisma.join(conds, ' AND ')
}

tenantRoutes.get('/tenants', async c => {
  const input = query(c, listQuery)
  const now = new Date()
  const since = new Date(now.getTime() - 30 * DAY_MS)
  const filter = listFilter(input.q || undefined, input.planId)
  const dir = (input.dir ?? (input.sort === 'name' ? 'asc' : 'desc')) === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`
  const key = {
    name: Prisma.sql`LOWER(v."name")`,
    joined: Prisma.sql`v."createdAt"`,
    mrr: Prisma.sql`v."mrr"`,
    sales: Prisma.sql`v."sales"`
  }[input.sort]
  const statusFilter = input.status ? Prisma.sql`v."status" = ${input.status}` : Prisma.sql`TRUE`

  // The mrr column mirrors monthlyValueCents and is used for ordering only:
  // the figure sent to the browser is priced in code below.
  const rows = await prisma.$queryRaw<ListRow[]>`
    WITH base AS (
      SELECT b."id", b."name", b."slug", b."createdAt", COALESCE(s."status"::text, 'NONE') AS "status", s."trialEndsAt",
        p."id" AS "planId", p."name" AS "planName", p."model"::text AS "model", p."interval"::text AS "interval",
        p."priceCents", p."perBranchCents", p."percentBps", p."minimumCents", s."discountBps", s."customPriceCents",
        (SELECT COUNT(*) FROM "Branch" br WHERE br."businessId" = b."id" AND br."active")::int AS "branches",
        (SELECT COUNT(*) FROM "user" u WHERE u."businessId" = b."id" AND u."active")::int AS "staff",
        (COALESCE((SELECT SUM(sa."totalCents") FROM "Sale" sa JOIN "Branch" br ON br."id" = sa."branchId"
            WHERE br."businessId" = b."id" AND sa."status" IN ('PAID', 'REFUNDED') AND sa."paidAt" >= ${since} AND sa."paidAt" < ${now}), 0)
          - COALESCE((SELECT SUM(r."amountCents") FROM "Refund" r JOIN "Sale" sa ON sa."id" = r."saleId" JOIN "Branch" br ON br."id" = sa."branchId"
            WHERE br."businessId" = b."id" AND r."createdAt" >= ${since} AND r."createdAt" < ${now}), 0))::bigint AS "sales"
      FROM "Business" b
      LEFT JOIN "Subscription" s ON s."businessId" = b."id"
      LEFT JOIN "Plan" p ON p."id" = s."planId"
      WHERE ${filter}
    ), valued AS (
      SELECT base.*, COALESCE(CASE
          WHEN base."status" NOT IN ('ACTIVE', 'PAST_DUE') OR base."interval" = 'ONCE' OR base."model" = 'ONE_TIME' THEN 0
          WHEN base."interval" = 'YEAR' THEN ROUND(n.net / 12.0)
          ELSE n.net END, 0)::bigint AS "mrr"
      FROM base,
        LATERAL (SELECT (CASE
          WHEN base."customPriceCents" IS NOT NULL THEN base."customPriceCents"
          WHEN base."model" = 'PER_BRANCH' THEN base."priceCents" + base."branches" * base."perBranchCents"
          WHEN base."model" = 'PERCENT_OF_SALES' THEN GREATEST(ROUND(GREATEST(base."sales", 0) * base."percentBps" / 10000.0), base."minimumCents")
          ELSE base."priceCents" END)::numeric AS gross) g,
        LATERAL (SELECT g.gross - ROUND(g.gross * COALESCE(base."discountBps", 0) / 10000.0) AS net) n
    )
    SELECT v.* FROM valued v WHERE ${statusFilter}
    ORDER BY ${key} ${dir}, v."id" ASC
    LIMIT ${input.limit} OFFSET ${input.offset}`

  // Chip counts respect the search and the plan, not the chosen status.
  const grouped = await prisma.$queryRaw<{ status: string; n: number }[]>`
    SELECT COALESCE(s."status"::text, 'NONE') AS "status", COUNT(*)::int AS "n"
    FROM "Business" b LEFT JOIN "Subscription" s ON s."businessId" = b."id"
    WHERE ${filter} GROUP BY 1`
  const counts: Record<string, number> = { ALL: 0 }
  for (const s of STATUSES) counts[s] = 0
  for (const g of grouped) {
    counts[g.status] = g.n
    counts.ALL = (counts.ALL ?? 0) + g.n
  }

  const tenants = rows.map(r => {
    const sales30dCents = Number(r.sales)
    const paying = r.status === 'ACTIVE' || r.status === 'PAST_DUE'
    const mrrCents =
      paying && r.model && r.interval
        ? monthlyValueCents(
            {
              name: r.planName ?? '',
              model: r.model,
              interval: r.interval,
              priceCents: r.priceCents ?? 0,
              perBranchCents: r.perBranchCents ?? 0,
              percentBps: r.percentBps ?? 0,
              minimumCents: r.minimumCents ?? 0
            },
            { discountBps: r.discountBps ?? 0, customPriceCents: r.customPriceCents },
            { branches: r.branches, salesCents: sales30dCents }
          )
        : 0
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      url: tenantUrl(r.slug),
      status: r.status,
      plan: r.planId ? { id: r.planId, name: r.planName } : null,
      branches: r.branches,
      staff: r.staff,
      sales30dCents,
      mrrCents,
      createdAt: r.createdAt,
      trialEndsAt: r.trialEndsAt
    }
  })
  return c.json({ tenants, total: input.status ? counts[input.status] ?? 0 : counts.ALL ?? 0, counts })
})

// ---------- onboarding ----------

const onboardSchema = z.object({
  businessName: z.string().trim().min(2).max(120),
  slug: slugRule,
  branchName: z.string().trim().min(1).max(80),
  ownerName: z.string().trim().min(2).max(120),
  ownerUsername: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9._-]{2,31}$/, 'Username is 3 to 32 letters, digits, dots, dashes or underscores'),
  ownerPin: z.string().regex(pinSchemaRule, 'PIN is 4 to 6 digits').optional(),
  // optional: a client can start without a plan and be put on one later
  planId: idRule.optional(),
  trialDays: z.number().int().min(0).max(90).optional(),
  email: z.string().trim().toLowerCase().email().max(200).optional(),
  phone: phone.optional()
})

const subscriptionDTO = (s: Subscription & { plan: Plan }) => ({
  id: s.id,
  status: s.status,
  plan: {
    id: s.plan.id,
    code: s.plan.code,
    name: s.plan.name,
    model: s.plan.model,
    interval: s.plan.interval,
    active: s.plan.active,
    priceText: describePrice(s.plan)
  },
  trialEndsAt: s.trialEndsAt,
  currentPeriodStart: s.currentPeriodStart,
  currentPeriodEnd: s.currentPeriodEnd,
  cancelAtPeriodEnd: s.cancelAtPeriodEnd,
  cancelledAt: s.cancelledAt,
  discountBps: s.discountBps,
  customPriceCents: s.customPriceCents,
  suspendedReason: s.suspendedReason,
  suspendedAt: s.suspendedAt
})

tenantRoutes.post('/tenants', care, async c => {
  const platform = c.get('platform')
  const input = await body(c, onboardSchema)
  const dupe = () => conflict(`The username ${input.ownerUsername} is already taken.`, 'duplicate_username')
  const slugTaken = () => conflict(`The address ${input.slug} is already used by another client.`, 'duplicate_slug')
  // Shown once in the response. Never stored in plain, logged or audited.
  const generated = input.ownerPin ? null : randomPin()
  const pin = input.ownerPin ?? generated!
  try {
    const out = await prisma.$transaction(async tx => {
      const plan = input.planId ? await tx.plan.findUnique({ where: { id: input.planId } }) : null
      if (input.planId && !plan) throw notFound('Plan')
      if (plan && !plan.active) throw unprocessable(`The ${plan.name} plan is archived and cannot be given to new clients.`, 'plan_archived')
      if (await tx.user.findUnique({ where: { username: input.ownerUsername } })) throw dupe()
      if (await tx.business.findUnique({ where: { slug: input.slug } })) throw slugTaken()

      const business = await tx.business.create({
        data: { name: input.businessName, slug: input.slug, email: input.email ?? null, phone: input.phone ?? null }
      })
      const branch = await tx.branch.create({ data: { businessId: business.id, name: input.branchName } })
      const owner = await createStaff(tx, {
        businessId: business.id,
        name: input.ownerName,
        username: input.ownerUsername,
        pin,
        role: 'OWNER',
        branchIds: []
      })

      const now = new Date()
      if (!plan) {
        await platformAudit(tx, platform, 'console.tenant.created', 'Business', business.id,
          { businessName: business.name, slug: business.slug, branchName: branch.name, ownerUsername: owner.username, plan: null, pinGenerated: !!generated }, business.id)
        return { business, branch, owner, sub: null, invoice: null }
      }
      const trialDays = input.trialDays ?? plan.trialDays
      const trialEndsAt = trialDays > 0 ? new Date(now.getTime() + trialDays * DAY_MS) : null
      const sub = await tx.subscription.create({
        data: {
          businessId: business.id,
          planId: plan.id,
          status: trialEndsAt ? 'TRIALING' : 'ACTIVE',
          trialEndsAt,
          currentPeriodStart: now,
          currentPeriodEnd: trialEndsAt ?? periodEnd(now, plan.interval)
        },
        include: { plan: true }
      })
      // No trial: plans billed in advance owe their first period straight away.
      const invoice =
        !trialEndsAt && !billedInArrears(plan)
          ? await raiseSubscriptionInvoice(tx, sub, sub.currentPeriodStart, sub.currentPeriodEnd, now)
          : null
      await platformAudit(
        tx,
        platform,
        'console.tenant.created',
        'Business',
        business.id,
        {
          businessName: business.name,
          slug: business.slug,
          branchName: branch.name,
          ownerUsername: owner.username,
          plan: plan.code,
          trialDays,
          pinGenerated: !!generated
        },
        business.id
      )
      return { business, branch, owner, sub, invoice }
    })
    return c.json(
      {
        tenant: {
          id: out.business.id,
          name: out.business.name,
          slug: out.business.slug,
          url: tenantUrl(out.business.slug),
          email: out.business.email,
          phone: out.business.phone,
          createdAt: out.business.createdAt
        },
        branch: { id: out.branch.id, name: out.branch.name },
        owner: { id: out.owner.id, name: out.owner.name, username: out.owner.username },
        subscription: out.sub ? subscriptionDTO(out.sub) : null,
        invoice: out.invoice ? { id: out.invoice.id, number: out.invoice.number, totalCents: out.invoice.totalCents, status: out.invoice.status } : null,
        ownerPin: generated
      },
      201
    )
  } catch (err) {
    const field = uniqueField(err)
    if (field === 'slug') throw slugTaken()
    if (field) throw dupe()
    throw err
  }
})

// ---------- client page ----------

tenantRoutes.get('/tenants/:id', async c => {
  const businessId = c.req.param('id')
  const business = await requireBusiness(prisma, businessId)
  const now = new Date()
  const since = new Date(now.getTime() - 30 * DAY_MS)
  const [sub, usage, limits, sales30dCents, lastSale, lastSignIn, owners, open, overdue] = await Promise.all([
    prisma.subscription.findUnique({ where: { businessId }, include: { plan: true } }),
    usageFor(prisma, businessId),
    limitsFor(prisma, businessId),
    salesCentsBetween(prisma, businessId, since, now),
    prisma.sale.aggregate({ where: { branch: { businessId }, status: { in: ['PAID', 'REFUNDED'] } }, _max: { paidAt: true } }),
    prisma.session.aggregate({ where: { user: { businessId } }, _max: { createdAt: true } }),
    prisma.user.findMany({
      where: { businessId, role: 'OWNER' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, username: true, active: true }
    }),
    prisma.invoice.aggregate({ where: { businessId, status: 'OPEN' }, _sum: { totalCents: true, paidCents: true }, _count: true }),
    prisma.invoice.count({ where: { businessId, status: 'OPEN', dueAt: { lt: now } } })
  ])
  const estimate = sub ? await estimateNextInvoice(prisma, sub, now) : null
  return c.json({
    tenant: {
      id: business.id,
      name: business.name,
      slug: business.slug,
      url: tenantUrl(business.slug),
      legalName: business.legalName,
      email: business.email,
      phone: business.phone,
      address: business.address,
      kraPin: business.kraPin,
      createdAt: business.createdAt,
      status: sub?.status ?? 'NONE',
      subscription: sub ? subscriptionDTO(sub) : null,
      usage,
      limits: limits ? { maxBranches: limits.maxBranches, maxStaff: limits.maxStaff, maxProducts: limits.maxProducts } : null,
      sales30dCents,
      mrrCents: sub ? monthlyValue(sub, usage.branches, sales30dCents) : 0,
      lastSaleAt: lastSale._max.paidAt,
      lastSignInAt: lastSignIn._max.createdAt,
      owners,
      nextInvoice: estimate
        ? {
            periodStart: estimate.periodStart,
            periodEnd: estimate.periodEnd,
            issueAt: estimate.issueAt,
            lines: estimate.lines,
            subtotalCents: estimate.subtotalCents,
            taxCents: estimate.taxCents,
            totalCents: estimate.totalCents
          }
        : null,
      openInvoiceCents: (open._sum.totalCents ?? 0) - (open._sum.paidCents ?? 0),
      openInvoiceCount: open._count,
      overdueInvoiceCount: overdue
    }
  })
})

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform(v => (v === '' ? null : v))

const patchSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    legalName: text(160),
    email: z.union([z.string().trim().toLowerCase().email().max(200), z.literal(''), z.null()]).transform(v => v || null),
    phone: z.union([phone, z.literal(''), z.null()]).transform(v => v || null),
    address: text(300),
    kraPin: z
      .union([z.string().trim().toUpperCase().regex(/^[A-Z]\d{9}[A-Z]$/, 'A KRA PIN is a letter, nine digits and a letter'), z.literal(''), z.null()])
      .transform(v => v || null)
  })
  .extend({ slug: slugRule })
  .partial()
  .refine(v => Object.keys(v).length > 0, 'Nothing to change')

tenantRoutes.patch('/tenants/:id', care, async c => {
  const platform = c.get('platform')
  const businessId = c.req.param('id')
  const input = await body(c, patchSchema)
  // moving a client to a new address breaks their bookmarks: super admins only
  if (input.slug !== undefined) assertPlatform(platform, 'SUPER_ADMIN')
  let oldSlug: string | null = null
  const business = await prisma.$transaction(async tx => {
    const before = await requireBusiness(tx, businessId)
    oldSlug = before.slug
    if (input.slug && input.slug !== before.slug && (await tx.business.findUnique({ where: { slug: input.slug } }))) {
      throw conflict(`The address ${input.slug} is already used by another client.`, 'duplicate_slug')
    }
    const changed: Record<string, { from: unknown; to: unknown }> = {}
    for (const [k, v] of Object.entries(input)) {
      const old = (before as Record<string, unknown>)[k]
      if (v !== undefined && old !== v) changed[k] = { from: old, to: v }
    }
    const moving = input.slug !== undefined && input.slug !== before.slug
    const formerSlugs = moving
      ? [...new Set([...(before.formerSlugs ?? []), ...(before.slug ? [before.slug] : [])])].filter(s => s !== input.slug)
      : undefined
    const after = await tx.business.update({ where: { id: businessId }, data: { ...input, ...(formerSlugs ? { formerSlugs } : {}) } })
    await platformAudit(tx, platform, 'console.tenant.updated', 'Business', businessId, { businessName: after.name, changed }, businessId)
    return after
  })
  forgetTenant(oldSlug)
  forgetTenant(business.slug)
  return c.json({
    tenant: {
      id: business.id,
      name: business.name,
      slug: business.slug,
      url: tenantUrl(business.slug),
      legalName: business.legalName,
      email: business.email,
      phone: business.phone,
      address: business.address,
      kraPin: business.kraPin
    }
  })
})

// ---------- suspend and reactivate ----------

tenantRoutes.post('/tenants/:id/suspend', care, async c => {
  const platform = c.get('platform')
  const businessId = c.req.param('id')
  const input = await body(c, z.object({ reason: z.string().trim().min(3).max(300) }))
  const sub = await prisma.$transaction(async tx => {
    const business = await requireBusiness(tx, businessId)
    const current = await lockSubscription(tx, businessId)
    if (!current) {
      throw unprocessable('This client has no subscription yet. Give it a plan first, then it can be suspended.', 'no_subscription')
    }
    if (current.status === 'SUSPENDED') throw unprocessable('This client is already suspended.')
    if (current.status === 'CANCELLED') throw unprocessable('This subscription is cancelled, so there is nothing to suspend.')
    const now = new Date()
    const after = await tx.subscription.update({
      where: { id: current.id },
      data: { status: 'SUSPENDED', suspendedReason: input.reason, suspendedAt: now },
      include: { plan: true }
    })
    await platformAudit(
      tx,
      platform,
      'console.tenant.suspended',
      'Business',
      businessId,
      { businessName: business.name, reason: input.reason, from: current.status },
      businessId
    )
    return after
  })
  return c.json({ subscription: subscriptionDTO(sub) })
})

tenantRoutes.post('/tenants/:id/reactivate', care, async c => {
  const platform = c.get('platform')
  const businessId = c.req.param('id')
  const sub = await prisma.$transaction(async tx => {
    const business = await requireBusiness(tx, businessId)
    const current = await lockSubscription(tx, businessId)
    if (!current) throw unprocessable('This client has no subscription to reactivate.', 'no_subscription')
    if (current.status !== 'SUSPENDED') throw unprocessable('Only a suspended client can be reactivated.')
    const now = new Date()
    // Back to where it stood: still on trial, still owing, or in good standing.
    const status =
      current.trialEndsAt && current.trialEndsAt > now ? 'TRIALING' : (await hasOverdueInvoice(tx, businessId, now)) ? 'PAST_DUE' : 'ACTIVE'
    const after = await tx.subscription.update({
      where: { id: current.id },
      data: { status, suspendedReason: null, suspendedAt: null },
      include: { plan: true }
    })
    await platformAudit(
      tx,
      platform,
      'console.tenant.reactivated',
      'Business',
      businessId,
      { businessName: business.name, to: status, wasReason: current.suspendedReason },
      businessId
    )
    return after
  })
  return c.json({ subscription: subscriptionDTO(sub) })
})

// ---------- people ----------

tenantRoutes.get('/tenants/:id/people', async c => {
  const businessId = c.req.param('id')
  await requireBusiness(prisma, businessId)
  const [users, lastSeen] = await Promise.all([
    prisma.user.findMany({
      where: { businessId },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
      include: { branches: { include: { branch: { select: { id: true, name: true } } } } }
    }),
    prisma.session.groupBy({ by: ['userId'], where: { user: { businessId } }, _max: { createdAt: true } })
  ])
  const seen = new Map(lastSeen.map(s => [s.userId, s._max.createdAt]))
  const now = new Date()
  return c.json({
    people: users.map(u => ({
      id: u.id,
      name: u.name,
      username: u.username,
      role: u.role,
      active: u.active,
      locked: !!u.lockedUntil && u.lockedUntil > now,
      branches: u.branches.map(b => b.branch),
      lastSignInAt: seen.get(u.id) ?? null,
      createdAt: u.createdAt
    }))
  })
})

tenantRoutes.post('/tenants/:id/people/:userId/reset-pin', care, async c => {
  const platform = c.get('platform')
  const businessId = c.req.param('id')
  const userId = c.req.param('userId')
  // Shown once in the response. Never stored in plain, logged or audited.
  const ownerPin = randomPin()
  const out = await prisma.$transaction(async tx => {
    const business = await requireBusiness(tx, businessId)
    const user = await tx.user.findFirst({ where: { id: userId, businessId } })
    if (!user) throw notFound('Staff member')
    if (user.role !== 'OWNER') {
      throw unprocessable('Only an owner PIN can be reset from the console. The owner resets PINs for their own staff.', 'not_owner')
    }
    await setPin(tx, userId, ownerPin)
    await tx.user.update({ where: { id: userId }, data: { failedPins: 0, lockedUntil: null } })
    const ended = await tx.session.deleteMany({ where: { userId } })
    await platformAudit(
      tx,
      platform,
      'console.tenant.pin_reset',
      'user',
      userId,
      { businessName: business.name, userName: user.name, username: user.username, sessionsEnded: ended.count },
      businessId
    )
    return { user, sessionsEnded: ended.count }
  })
  return c.json({ user: { id: out.user.id, name: out.user.name, username: out.user.username }, ownerPin, sessionsEnded: out.sessionsEnded })
})

tenantRoutes.post('/tenants/:id/sign-out-all', care, async c => {
  const platform = c.get('platform')
  const businessId = c.req.param('id')
  const sessionsEnded = await prisma.$transaction(async tx => {
    const business = await requireBusiness(tx, businessId)
    const ended = await tx.session.deleteMany({ where: { user: { businessId } } })
    await platformAudit(
      tx,
      platform,
      'console.tenant.signed_out',
      'Business',
      businessId,
      { businessName: business.name, sessionsEnded: ended.count },
      businessId
    )
    return ended.count
  })
  return c.json({ sessionsEnded })
})

// ---------- notes ----------

async function withAuthors<T extends { authorId: string }>(notes: T[]) {
  const authors = await prisma.user.findMany({
    where: { id: { in: [...new Set(notes.map(n => n.authorId))] } },
    select: { id: true, name: true }
  })
  const byId = new Map(authors.map(a => [a.id, a.name]))
  return notes.map(({ authorId, ...n }) => ({ ...n, author: { id: authorId, name: byId.get(authorId) ?? 'Former team member' } }))
}

tenantRoutes.get('/tenants/:id/notes', async c => {
  const businessId = c.req.param('id')
  await requireBusiness(prisma, businessId)
  const notes = await prisma.tenantNote.findMany({
    where: { businessId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 200,
    select: { id: true, body: true, createdAt: true, authorId: true }
  })
  return c.json({ notes: await withAuthors(notes) })
})

tenantRoutes.post('/tenants/:id/notes', care, async c => {
  const platform = c.get('platform')
  const businessId = c.req.param('id')
  const input = await body(c, z.object({ body: z.string().trim().min(1).max(2000) }))
  const note = await prisma.$transaction(async tx => {
    const business = await requireBusiness(tx, businessId)
    const created = await tx.tenantNote.create({
      data: { businessId, authorId: platform.id, body: input.body },
      select: { id: true, body: true, createdAt: true, authorId: true }
    })
    await platformAudit(tx, platform, 'console.note.added', 'TenantNote', created.id, { businessName: business.name }, businessId)
    return created
  })
  const { authorId, ...rest } = note
  return c.json({ note: { ...rest, author: { id: authorId, name: platform.name } } }, 201)
})

tenantRoutes.delete('/tenants/:id/notes/:noteId', care, async c => {
  const platform = c.get('platform')
  const businessId = c.req.param('id')
  const noteId = c.req.param('noteId')
  await prisma.$transaction(async tx => {
    const business = await requireBusiness(tx, businessId)
    const note = await tx.tenantNote.findFirst({ where: { id: noteId, businessId } })
    if (!note) throw notFound('Note')
    if (note.authorId !== platform.id && platform.role !== 'SUPER_ADMIN') {
      throw forbidden('Only the person who wrote a note, or a super admin, can delete it.')
    }
    await tx.tenantNote.delete({ where: { id: noteId } })
    await platformAudit(
      tx,
      platform,
      'console.note.deleted',
      'TenantNote',
      noteId,
      { businessName: business.name, authorId: note.authorId },
      businessId
    )
  })
  return c.json({ ok: true })
})

// ---------- history ----------

const activityQuery = z.object({
  limit: paging.limit,
  before: z
    .string()
    .regex(/^\d{1,18}$/, 'before is the id of the last row you have')
    .optional()
})

tenantRoutes.get('/tenants/:id/activity', async c => {
  const businessId = c.req.param('id')
  await requireBusiness(prisma, businessId)
  const input = query(c, activityQuery)
  const rows = await prisma.auditLog.findMany({
    where: { businessId, ...(input.before ? { id: { lt: BigInt(input.before) } } : {}) },
    orderBy: { id: 'desc' },
    take: input.limit + 1
  })
  const pageRows = rows.slice(0, input.limit)
  const actorIds = [...new Set(pageRows.map(r => r.userId).filter((v): v is string => !!v))]
  const actors = await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, platformRole: true } })
  const byId = new Map(actors.map(a => [a.id, a]))
  const activity = pageRows.map(r => {
    const who = r.userId ? byId.get(r.userId) : null
    return {
      id: r.id.toString(),
      at: iso(r.at),
      action: r.action,
      entity: r.entity,
      entityId: r.entityId,
      data: r.data,
      actor: r.userId
        ? { id: r.userId, name: who?.name ?? 'Removed user', kind: who?.platformRole ? ('platform' as const) : ('shop' as const) }
        : { id: null, name: 'Bottle Point', kind: 'system' as const }
    }
  })
  const last = pageRows[pageRows.length - 1]
  return c.json({ activity, nextBefore: rows.length > input.limit && last ? last.id.toString() : null })
})
