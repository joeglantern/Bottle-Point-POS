import { Hono } from 'hono'
import { auth } from '../../auth.js'
import { prisma } from '../../db.js'
import { audit } from '../../lib/audit.js'
import { notFound, unauthorized, unprocessable } from '../../lib/errors.js'
import { id, parse } from '../../lib/validate.js'
import { requireRole, type AppEnv } from '../../middleware/auth.js'
import { deviceLabel } from '../../rules/settings.js'

// Mounted at /api/admin by ../settings.ts. Paths here are relative to /api/admin.
export const sessionsRoutes = new Hono<AppEnv>()

// The session making this request. Sessions are read from the database on
// every request (no cookie cache), so a deleted row is signed out at once.
async function currentSessionId(headers: Headers) {
  const s = await auth.api.getSession({ headers })
  if (!s) throw unauthorized()
  return s.session.id
}

sessionsRoutes.get('/sessions', requireRole('OWNER'), async c => {
  const actor = c.get('actor')
  const current = await currentSessionId(c.req.raw.headers)
  const rows = await prisma.session.findMany({
    // platform staff have no business, the second check is a belt and braces one
    where: { expiresAt: { gt: new Date() }, user: { businessId: actor.businessId, platformRole: null } },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    select: {
      id: true,
      createdAt: true,
      updatedAt: true,
      ipAddress: true,
      userAgent: true,
      user: { select: { id: true, name: true, role: true } }
    }
  })
  const sessions = rows.map(s => ({
    id: s.id,
    user: s.user,
    createdAt: s.createdAt,
    lastSeenAt: s.updatedAt,
    device: deviceLabel(s.userAgent),
    ip: s.ipAddress || null,
    current: s.id === current
  }))
  return c.json({ sessions, total: sessions.length })
})

sessionsRoutes.delete('/sessions/:id', requireRole('OWNER'), async c => {
  const actor = c.get('actor')
  const sessionId = parse(id, c.req.param('id'))
  const current = await currentSessionId(c.req.raw.headers)

  await prisma.$transaction(async tx => {
    const s = await tx.session.findFirst({
      where: { id: sessionId, user: { businessId: actor.businessId, platformRole: null } },
      select: { id: true, userAgent: true, ipAddress: true, user: { select: { id: true, name: true } } }
    })
    if (!s) throw notFound('Session')
    if (s.id === current) throw unprocessable('This is the device you are using now. Use sign out instead.', 'own_session')
    // two owners pressing at once: only the delete that removed the row is logged
    const gone = await tx.session.deleteMany({ where: { id: s.id } })
    if (gone.count === 0) throw notFound('Session')
    await audit(tx, actor, 'session.revoked', 'session', s.id, {
      userId: s.user.id,
      name: s.user.name,
      device: deviceLabel(s.userAgent),
      ip: s.ipAddress || null
    })
  })
  return c.json({ ok: true })
})

sessionsRoutes.post('/users/:id/sign-out', requireRole('OWNER'), async c => {
  const actor = c.get('actor')
  const userId = parse(id, c.req.param('id'))
  const current = await currentSessionId(c.req.raw.headers)

  const signedOut = await prisma.$transaction(async tx => {
    const u = await tx.user.findFirst({ where: { id: userId, businessId: actor.businessId, platformRole: null }, select: { id: true, name: true } })
    if (!u) throw notFound('User')
    // an owner signing themself out everywhere keeps the device in their hand
    const gone = await tx.session.deleteMany({ where: { userId: u.id, id: { not: current } } })
    await audit(tx, actor, 'user.signed_out', 'user', u.id, { name: u.name, sessionsEnded: gone.count })
    return gone.count
  })
  return c.json({ signedOut })
})
