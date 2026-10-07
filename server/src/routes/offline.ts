import { Hono, type MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { prisma, type Device } from '../db.js'
import { AppError, notFound, unprocessable } from '../lib/errors.js'
import { body, id, query } from '../lib/validate.js'
import { audit } from '../lib/audit.js'
import { tenantFromHeaders, tenantMode } from '../lib/tenant.js'
import { assertBranch, requireRole, type AppEnv } from '../middleware/auth.js'
import { hashToken, MAX_OPS, newDeviceToken, syncOps } from '../rules/offline.js'

// ---------- Sync: authenticated by the till's own key ----------

type DeviceEnv = { Variables: { device: Device } }

// A till's key works only on its own business's address and until revoked.
// It can do exactly one thing: send what it recorded while offline.
const requireDevice: MiddlewareHandler<DeviceEnv> = async (c, next) => {
  const token = c.req.header('x-device-token') ?? ''
  const device = token.length >= 20 && token.length <= 200 ? await prisma.device.findUnique({ where: { tokenHash: hashToken(token) } }) : null
  if (!device || device.revokedAt) throw new AppError(401, 'device_unknown', 'This till is not registered. Sign in on it once with internet.')
  if (tenantMode()) {
    const tenant = await tenantFromHeaders(c.req.raw.headers)
    if (!tenant || tenant.id !== device.businessId) throw new AppError(401, 'device_unknown', 'This till belongs to another shop.')
  }
  if (!device.lastSeenAt || Date.now() - device.lastSeenAt.getTime() > 60_000) {
    await prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } })
  }
  c.set('device', device)
  await next()
}

const syncBody = z.object({ ops: z.array(z.unknown()).min(1).max(MAX_OPS) })

export const deviceSyncRoutes = new Hono<DeviceEnv>()

deviceSyncRoutes.post('/', requireDevice, async c => {
  const { ops } = await body(c, syncBody)
  const results = await syncOps(c.get('device'), ops)
  return c.json({ results, serverTime: new Date().toISOString() })
})

// ---------- Signed in: registering tills, what to keep offline, issues ----------

export const offlineRoutes = new Hono<AppEnv>()

const MAX_DEVICES = 200
const registerBody = z.object({ name: z.string().trim().max(60).optional() })

// Called by the till the first time someone signs in on it. The key is shown
// to the till once and only its hash is kept.
offlineRoutes.post('/devices', async c => {
  const actor = c.get('actor')
  const input = await body(c, registerBody)
  const token = newDeviceToken()
  const device = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Business" WHERE id = ${actor.businessId} FOR UPDATE`
    const existing = await tx.device.findMany({ where: { businessId: actor.businessId }, select: { code: true, revokedAt: true } })
    if (existing.filter(d => !d.revokedAt).length >= MAX_DEVICES) throw unprocessable('This shop has too many registered tills. Remove old ones in Settings.', 'too_many_devices')
    const next = existing.reduce((m, d) => Math.max(m, Number(d.code.slice(1)) || 0), 0) + 1
    const d = await tx.device.create({
      data: { businessId: actor.businessId, code: `T${next}`, name: input.name || null, tokenHash: hashToken(token), createdById: actor.id, lastSeenAt: new Date() }
    })
    await audit(tx, actor, 'device.register', 'device', d.id, { code: d.code, name: d.name })
    await tx.deviceUser.create({ data: { deviceId: d.id, userId: actor.id } })
    return d
  })
  return c.json({ device: { id: device.id, code: device.code, name: device.name }, token }, 201)
})

// The till tells the server who just signed in on it with internet. Offline
// sales by anyone else are flagged.
offlineRoutes.post('/devices/seen', async c => {
  const actor = c.get('actor')
  const token = c.req.header('x-device-token') ?? ''
  const device = token.length >= 20 && token.length <= 200 ? await prisma.device.findUnique({ where: { tokenHash: hashToken(token) } }) : null
  if (!device || device.revokedAt || device.businessId !== actor.businessId) throw new AppError(404, 'device_unknown', 'This till is not registered.')
  const now = new Date()
  await prisma.deviceUser.upsert({
    where: { deviceId_userId: { deviceId: device.id, userId: actor.id } },
    create: { deviceId: device.id, userId: actor.id },
    update: { lastSeenAt: now }
  })
  return c.json({ ok: true, code: device.code })
})

offlineRoutes.get('/devices', requireRole('MANAGER'), async c => {
  const actor = c.get('actor')
  const devices = await prisma.device.findMany({ where: { businessId: actor.businessId }, orderBy: { createdAt: 'asc' } })
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(devices.map(d => d.createdById))] } }, select: { id: true, name: true } })
  const names = new Map(users.map(u => [u.id, u.name]))
  return c.json({
    devices: devices.map(d => ({ id: d.id, code: d.code, name: d.name, createdAt: d.createdAt, createdBy: names.get(d.createdById) ?? null, lastSeenAt: d.lastSeenAt, revokedAt: d.revokedAt }))
  })
})

// A lost or retired till. Anything it still holds can no longer sync.
offlineRoutes.post('/devices/:id/revoke', requireRole('MANAGER'), async c => {
  const actor = c.get('actor')
  const d = await prisma.device.findUnique({ where: { id: c.req.param('id') } })
  if (!d || d.businessId !== actor.businessId) throw notFound('Till')
  if (d.revokedAt) return c.json({ ok: true })
  await prisma.$transaction(async tx => {
    await tx.device.update({ where: { id: d.id }, data: { revokedAt: new Date() } })
    await audit(tx, actor, 'device.revoke', 'device', d.id, { code: d.code })
  })
  return c.json({ ok: true })
})

const bootstrapQuery = z.object({ users: z.string().max(2000).optional() })

// What a till keeps so it can work offline: the shop's receipt details, and
// which of the people who signed in on it may still do so.
offlineRoutes.get('/bootstrap', async c => {
  const actor = c.get('actor')
  const q = query(c, bootstrapQuery)
  const ids = (q.users ?? '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 100)
  const [biz, staff] = await Promise.all([
    prisma.business.findUniqueOrThrow({ where: { id: actor.businessId } }),
    ids.length ? prisma.user.findMany({ where: { id: { in: ids }, businessId: actor.businessId, active: true }, select: { id: true } }) : []
  ])
  return c.json({
    serverTime: new Date().toISOString(),
    business: {
      name: biz.name,
      legalName: biz.legalName,
      address: biz.address,
      phone: biz.phone,
      email: biz.email,
      kraPin: biz.kraPin,
      receiptFooter: biz.receiptFooter,
      vatRateBps: biz.vatRateBps
    },
    // only those still allowed; the till forgets everyone else
    activeStaff: staff.map(s => s.id)
  })
})

const issuesQuery = z.object({ status: z.enum(['open', 'all']).default('open'), branchId: id.optional(), limit: z.coerce.number().int().min(1).max(200).default(100) })

offlineRoutes.get('/issues', requireRole('MANAGER'), async c => {
  const actor = c.get('actor')
  const q = query(c, issuesQuery)
  if (q.branchId) assertBranch(actor, q.branchId)
  const branchIds = q.branchId ? [q.branchId] : actor.branchIds
  const where = { businessId: actor.businessId, branchId: { in: branchIds }, ...(q.status === 'open' ? { resolvedAt: null } : {}) }
  const [rows, open] = await Promise.all([
    prisma.offlineIssue.findMany({ where, orderBy: { createdAt: 'desc' }, take: q.limit }),
    prisma.offlineIssue.count({ where: { businessId: actor.businessId, branchId: { in: branchIds }, resolvedAt: null } })
  ])
  const [sales, devices, users] = await Promise.all([
    prisma.sale.findMany({ where: { id: { in: rows.flatMap(r => (r.saleId ? [r.saleId] : [])) } }, select: { id: true, number: true, offlineRef: true, status: true } }),
    prisma.device.findMany({ where: { id: { in: rows.flatMap(r => (r.deviceId ? [r.deviceId] : [])) } }, select: { id: true, code: true } }),
    prisma.user.findMany({ where: { id: { in: rows.flatMap(r => (r.resolvedById ? [r.resolvedById] : [])) } }, select: { id: true, name: true } })
  ])
  const sale = new Map(sales.map(s => [s.id, s]))
  const device = new Map(devices.map(d => [d.id, d.code]))
  const user = new Map(users.map(u => [u.id, u.name]))
  return c.json({
    open,
    issues: rows.map(r => ({
      id: r.id,
      kind: r.kind,
      message: r.message,
      createdAt: r.createdAt,
      branchId: r.branchId,
      sale: r.saleId ? (sale.get(r.saleId) ?? null) : null,
      deviceCode: r.deviceId ? (device.get(r.deviceId) ?? null) : null,
      resolvedAt: r.resolvedAt,
      resolvedBy: r.resolvedById ? (user.get(r.resolvedById) ?? null) : null,
      resolveNote: r.resolveNote
    }))
  })
})

const resolveBody = z.object({ note: z.string().trim().min(3, 'Say what you found or did').max(300) })

offlineRoutes.post('/issues/:id/resolve', requireRole('MANAGER'), async c => {
  const actor = c.get('actor')
  const input = await body(c, resolveBody)
  const issue = await prisma.offlineIssue.findUnique({ where: { id: c.req.param('id') } })
  if (!issue || issue.businessId !== actor.businessId || !actor.branchIds.includes(issue.branchId)) throw notFound('Item')
  if (issue.resolvedAt) throw unprocessable('This was already dealt with.', 'already_resolved')
  await prisma.$transaction(async tx => {
    await tx.offlineIssue.update({ where: { id: issue.id }, data: { resolvedAt: new Date(), resolvedById: actor.id, resolveNote: input.note } })
    await audit(tx, actor, 'offline.issue_resolved', 'offlineIssue', issue.id, { kind: issue.kind, note: input.note, saleId: issue.saleId }, issue.branchId)
  })
  return c.json({ ok: true })
})
