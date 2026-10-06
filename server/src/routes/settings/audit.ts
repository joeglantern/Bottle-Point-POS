import { Hono } from 'hono'
import { z } from 'zod'
import { prisma, type Prisma } from '../../db.js'
import { badRequest } from '../../lib/errors.js'
import { id, query } from '../../lib/validate.js'
import { requireRole, type AppEnv } from '../../middleware/auth.js'
import { AUDIT_GROUPS, GROUP_RULES, HIDDEN_PREFIXES, SUPPORT_NAME, cleanData, groupOf, isPlatformAction, summarize } from '../../rules/settings.js'

// Mounted at /api/admin by ../settings.ts. Paths here are relative to /api/admin.
export const auditRoutes = new Hono<AppEnv>()

const DAY_MS = 24 * 60 * 60 * 1000

// A calendar day in Africa/Nairobi (UTC+3, no daylight saving).
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-01-31')
  .refine(s => {
    const d = new Date(`${s}T00:00:00+03:00`)
    return !Number.isNaN(d.getTime()) && new Date(d.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10) === s
  }, 'That is not a real date')
const dayStart = (s: string) => new Date(`${s}T00:00:00+03:00`)

const listQuery = z.object({
  from: day.optional(),
  to: day.optional(),
  userId: id.optional(),
  branchId: id.optional(),
  group: z.enum(AUDIT_GROUPS).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // ids are BigInt in the database, so they travel as strings of digits
  before: z.string().regex(/^\d{1,18}$/, 'before must be an entry id').optional()
})

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

auditRoutes.get('/audit', requireRole('OWNER'), async c => {
  const actor = c.get('actor')
  const q = query(c, listQuery)
  if (q.from && q.to && q.from > q.to) throw badRequest('The start date must not be after the end date.')

  const [branches, users] = await Promise.all([
    prisma.branch.findMany({ where: { businessId: actor.businessId }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { businessId: actor.businessId, platformRole: null }, select: { id: true, name: true } })
  ])
  const branchName = new Map(branches.map(b => [b.id, b.name]))
  const userName = new Map(users.map(u => [u.id, u.name]))

  // A user or branch of another business matches nothing, and looks no
  // different from one that does not exist.
  if ((q.userId && !userName.has(q.userId)) || (q.branchId && !branchName.has(q.branchId))) {
    return c.json({ entries: [], nextBefore: null })
  }

  // What belongs to this business: rows stamped with it, rows the system
  // wrote for one of its branches (M-Pesa callbacks carry no business), and
  // failed PIN attempts on one of its staff (written before anyone is signed in).
  const scope: Prisma.AuditLogWhereInput = {
    OR: [
      { businessId: actor.businessId },
      { businessId: null, branchId: { in: [...branchName.keys()] } },
      { businessId: null, branchId: null, userId: null, entity: 'user', action: { startsWith: 'auth.' }, entityId: { in: [...userName.keys()] } }
    ]
  }
  const and: Prisma.AuditLogWhereInput[] = [scope]
  for (const p of HIDDEN_PREFIXES) and.push({ NOT: { action: { startsWith: p } } })
  if (q.from) and.push({ at: { gte: dayStart(q.from) } })
  if (q.to) and.push({ at: { lt: new Date(dayStart(q.to).getTime() + DAY_MS) } })
  if (q.userId) and.push({ userId: q.userId })
  if (q.branchId) and.push({ branchId: q.branchId })
  if (q.before) and.push({ id: { lt: BigInt(q.before) } })
  if (q.group) {
    const rule = GROUP_RULES[q.group]
    and.push({ OR: rule.include.map(p => ({ action: { startsWith: p } })) })
    for (const p of rule.exclude) and.push({ NOT: { action: { startsWith: p } } })
  }

  const rows = await prisma.auditLog.findMany({ where: { AND: and }, orderBy: { id: 'desc' }, take: q.limit + 1 })
  const page = rows.slice(0, q.limit)

  // Sale numbers for the summaries, only ever from this business's branches.
  const saleIds = new Set<string>()
  for (const r of page) {
    if (r.entity === 'sale' && r.entityId) saleIds.add(r.entityId)
    const sid = rec(r.data).saleId
    if (typeof sid === 'string') saleIds.add(sid)
  }
  const sales = saleIds.size
    ? await prisma.sale.findMany({ where: { id: { in: [...saleIds] }, branch: { businessId: actor.businessId } }, select: { id: true, number: true } })
    : []
  const saleNumber = new Map(sales.map(s => [s.id, s.number]))

  // Rows written from the console must not say which staff member it was. A
  // user id that is not one of this business's people can only be platform
  // staff, whatever the action is called. Rows with no user count as the
  // platform's when the action says so (the billing run).
  const isPlatform = (r: { action: string; userId: string | null }) => (r.userId !== null ? !userName.has(r.userId) : isPlatformAction(r.action))
  const hasPlatformRows = page.some(isPlatform)
  const staff = hasPlatformRows
    ? await prisma.user.findMany({ where: { platformRole: { not: null } }, select: { id: true, name: true, email: true } })
    : []
  const needles = staff.flatMap(s => [s.id, s.name, s.email])

  const entries = page.map(r => {
    const platform = isPlatform(r)
    const data = cleanData(r.data, platform ? { staff: true, needles } : {})
    const who = platform ? SUPPORT_NAME : r.userId ? userName.get(r.userId)! : null
    const d = rec(r.data)
    const sid = r.entity === 'sale' ? r.entityId : typeof d.saleId === 'string' ? d.saleId : null
    const subjectId = r.entity === 'user' ? r.entityId : typeof d.userId === 'string' ? d.userId : null
    return {
      id: r.id.toString(),
      at: r.at,
      action: r.action,
      group: groupOf(r.action),
      summary: summarize({
        action: r.action,
        data,
        who,
        saleNumber: sid ? saleNumber.get(sid) ?? null : null,
        subjectName: subjectId ? userName.get(subjectId) ?? null : null
      }),
      actor: platform ? { id: null, name: SUPPORT_NAME } : r.userId ? { id: r.userId, name: who } : null,
      branch: r.branchId && branchName.has(r.branchId) ? { id: r.branchId, name: branchName.get(r.branchId)! } : null,
      data
    }
  })

  return c.json({ entries, nextBefore: rows.length > q.limit ? page[page.length - 1]!.id.toString() : null })
})
