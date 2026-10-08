import { Hono } from 'hono'
import { z } from 'zod'
import { auth } from '../auth.js'
import { prisma } from '../db.js'
import { AppError, unauthorized } from '../lib/errors.js'
import { body } from '../lib/validate.js'
import { audit } from '../lib/audit.js'
import { actorFromHeaders, requireAuth, type AppEnv } from '../middleware/auth.js'
import { brandingFor } from '../lib/branding.js'
import { movedTenantFromHeaders, tenantMode, tenantOf } from '../lib/tenant.js'
import { env } from '../env.js'

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
  // on a client's own address only that client's staff can sign in
  const tenant = tenantMode() ? await tenantOf(c) : null
  if (tenantMode() && !tenant) throw new AppError(404, 'no_shop', 'There is no shop at this address.')
  const found = await prisma.user.findUnique({ where: { username: input.username } })
  // someone else's staff on this address are treated exactly like an unknown name,
  // and never count towards that person's lockout
  const user = found && (!tenant || found.businessId === tenant.id) ? found : null
  if (found && !user) throw unauthorized('Wrong username or PIN.')

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
  return c.json({ user: actor, branches, branding: await brandingFor(actor.businessId) })
})

// The shop this address belongs to, so the sign in screen can greet it by
// name. Public, and says nothing more than the name.
sessionRoutes.get('/tenant', async c => {
  if (!tenantMode()) return c.json({ tenant: null, tenantMode: false })
  const tenant = await tenantOf(c)
  if (!tenant) {
    // the shop changed its address: tell the page where it went
    const moved = await movedTenantFromHeaders(c.req.raw.headers)
    if (moved) {
      throw new AppError(404, 'shop_moved', `${moved.name} has moved to a new address.`, { url: `https://${moved.slug}.${env.TENANT_BASE_DOMAIN}`, name: moved.name })
    }
    throw new AppError(404, 'no_shop', 'There is no shop at this address.')
  }
  return c.json({ tenant: { name: tenant.name, slug: tenant.slug }, branding: await brandingFor(tenant.id), tenantMode: true })
})

// The shop's logo. On a shop's address it is that shop's (public, like the
// shop's name on the sign in screen); without addresses (development) it is
// the signed in person's shop. The URL carries the upload time, so it can be
// cached for good.
sessionRoutes.get('/logo', async c => {
  const businessId = tenantMode() ? (await tenantOf(c))?.id : (await actorFromHeaders(c.req.raw.headers))?.businessId
  const b = businessId ? await prisma.business.findUnique({ where: { id: businessId }, select: { logo: true, logoType: true } }) : null
  if (!b?.logo || !b.logoType) throw new AppError(404, 'no_logo', 'This shop has no logo.')
  return new Response(new Uint8Array(b.logo), {
    headers: {
      'content-type': b.logoType,
      'cache-control': c.req.query('v') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'"
    }
  })
})
