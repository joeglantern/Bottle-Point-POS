import { Hono } from 'hono'
import { z } from 'zod'
import { hashPassword, verifyPassword } from 'better-auth/crypto'
import { auth } from '../../auth.js'
import { prisma } from '../../db.js'
import { AppError, badRequest, unauthorized } from '../../lib/errors.js'
import { platformAudit } from '../../lib/audit.js'
import { body } from '../../lib/validate.js'
import { passwordRule } from '../../lib/users.js'
import { requirePlatform, type ConsoleEnv } from '../../middleware/platform.js'

const MAX_TRIES = 5
const LOCK_MINUTES = 15

const loginBody = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(128)
})
const passwordBody = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordRule
})

export const consoleSessionRoutes = new Hono<ConsoleEnv>()

// Console sign in. Only platform staff can get a session here: a shop
// account is refused before its PIN is ever checked, so this route cannot be
// used to guess till PINs.
consoleSessionRoutes.post('/login', async c => {
  const input = await body(c, loginBody)
  const user = await prisma.user.findUnique({ where: { email: input.email } })
  const staff = user && user.platformRole && !user.businessId ? user : null

  if (staff?.lockedUntil && staff.lockedUntil > new Date()) {
    const mins = Math.ceil((staff.lockedUntil.getTime() - Date.now()) / 60000)
    throw new AppError(423, 'locked', `Too many wrong passwords. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`)
  }
  if (!staff || !staff.active) {
    // same answer and similar work whether or not the email exists
    await hashPassword(input.password)
    throw unauthorized('Wrong email or password.')
  }

  const res = await auth.api.signInEmail({
    body: { email: input.email, password: input.password },
    headers: c.req.raw.headers,
    asResponse: true
  })

  if (!res.ok) {
    const tries = staff.failedPins + 1
    await prisma.user.update({
      where: { id: staff.id },
      data: tries >= MAX_TRIES ? { failedPins: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60000) } : { failedPins: tries }
    })
    await platformAudit(prisma, null, 'console.login_failed', 'user', staff.id, { tries })
    throw unauthorized('Wrong email or password.')
  }

  await prisma.user.update({ where: { id: staff.id }, data: { failedPins: 0, lockedUntil: null } })
  await platformAudit(prisma, { id: staff.id }, 'console.login', 'user', staff.id)

  const out = c.json({ ok: true })
  for (const cookie of res.headers.getSetCookie()) out.headers.append('set-cookie', cookie)
  return out
})

consoleSessionRoutes.post('/logout', async c => {
  const res = await auth.api.signOut({ headers: c.req.raw.headers, asResponse: true })
  const out = c.json({ ok: true })
  for (const cookie of res.headers.getSetCookie()) out.headers.append('set-cookie', cookie)
  return out
})

consoleSessionRoutes.get('/me', requirePlatform, c => c.json({ user: c.get('platform') }))

// Change my own password. Signs out every other device.
consoleSessionRoutes.post('/password', requirePlatform, async c => {
  const me = c.get('platform')
  const input = await body(c, passwordBody)
  const account = await prisma.account.findFirst({ where: { userId: me.id, providerId: 'credential' } })
  if (!account?.password || !(await verifyPassword({ hash: account.password, password: input.currentPassword }))) {
    throw badRequest('Your current password is not right.')
  }
  if (input.newPassword === input.currentPassword) throw badRequest('Choose a password you have not just used.')

  const current = await auth.api.getSession({ headers: c.req.raw.headers })
  await prisma.$transaction(async tx => {
    await tx.account.update({ where: { id: account.id }, data: { password: await hashPassword(input.newPassword) } })
    await tx.session.deleteMany({ where: { userId: me.id, NOT: { id: current?.session.id ?? '' } } })
    await platformAudit(tx, me, 'console.password_changed', 'user', me.id)
  })
  return c.json({ ok: true })
})
