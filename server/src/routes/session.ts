import { Hono } from 'hono'
import { z } from 'zod'
import { auth } from '../auth.js'
import { prisma } from '../db.js'
import { AppError, unauthorized } from '../lib/errors.js'
import { body } from '../lib/validate.js'
import { audit } from '../lib/audit.js'
import { requireAuth, type AppEnv } from '../middleware/auth.js'

const MAX_TRIES = 5
const LOCK_MINUTES = 5

const pinLogin = z.object({
  username: z.string().trim().toLowerCase().min(3).max(32),
  pin: z.string().regex(/^\d{4,6}$/, 'PIN is 4 to 6 digits')
})

export const sessionRoutes = new Hono<AppEnv>()

// Sign in with username and PIN. Wraps Better Auth so we can lock a user out
// after repeated wrong PINs (rate limiting by IP alone is not enough on a
// shared till).
sessionRoutes.post('/pin', async c => {
  const input = await body(c, pinLogin)
  const user = await prisma.user.findUnique({ where: { username: input.username } })

  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    const mins = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000)
    throw new AppError(423, 'locked', `Too many wrong PINs. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`)
  }
  if (user && !user.active) throw new AppError(403, 'inactive', 'This account has been switched off. Ask your manager.')

  const res = await auth.api.signInUsername({
    body: { username: input.username, password: input.pin },
    headers: c.req.raw.headers,
    asResponse: true
  })

  if (!res.ok) {
    if (user) {
      const tries = user.failedPins + 1
      await prisma.user.update({
        where: { id: user.id },
        data:
          tries >= MAX_TRIES
            ? { failedPins: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60000) }
            : { failedPins: tries }
      })
      await audit(prisma, null, 'auth.pin_failed', 'user', user.id, { tries })
    }
    throw unauthorized('Wrong username or PIN.')
  }

  await prisma.user.update({ where: { id: user!.id }, data: { failedPins: 0, lockedUntil: null } })

  const out = c.json({ ok: true })
  for (const cookie of res.headers.getSetCookie()) out.headers.append('set-cookie', cookie)
  return out
})

sessionRoutes.post('/logout', async c => {
  const res = await auth.api.signOut({ headers: c.req.raw.headers, asResponse: true })
  const out = c.json({ ok: true })
  for (const cookie of res.headers.getSetCookie()) out.headers.append('set-cookie', cookie)
  return out
})

// Who am I, and which branches can I use.
sessionRoutes.get('/me', requireAuth, async c => {
  const actor = c.get('actor')
  const branches = await prisma.branch.findMany({
    where: { id: { in: actor.branchIds } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' }
  })
  return c.json({ user: actor, branches })
})

// Names shown on the sign in screen of a till. Only active staff of the
// branch, no roles or other detail.
sessionRoutes.get('/staff', async c => {
  const branchId = c.req.query('branchId')
  if (!branchId) return c.json({ staff: [] })
  const staff = await prisma.user.findMany({
    where: { active: true, OR: [{ branches: { some: { branchId } } }, { role: 'OWNER', business: { branches: { some: { id: branchId } } } }] },
    select: { name: true, username: true, role: true },
    orderBy: { name: 'asc' }
  })
  return c.json({ staff })
})
