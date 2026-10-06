import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { decryptSecret, encryptSecret, secretHint } from '../src/lib/secrets.js'
import { app, Client, CONSOLE_PASSWORD, consoleLogin, ORIGIN, resetDb, seedFixture, seedPlatform, type Fixture } from './helpers.js'

let fx: Fixture
beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
  await seedPlatform()
})

const login = (email: string, password: string) =>
  app.request('/api/console/session/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email, password })
  })

describe('console sign in', () => {
  it('platform staff sign in with email and password', async () => {
    const c = await consoleLogin('admin@bottlepoint.test')
    const me = await c.get('/api/console/session/me')
    expect(me.status).toBe(200)
    expect(me.body.user).toMatchObject({ email: 'admin@bottlepoint.test', role: 'SUPER_ADMIN' })
  })

  it('wrong password and unknown email get the same answer', async () => {
    const a = await login('admin@bottlepoint.test', 'not-the-password')
    const b = await login('nobody@bottlepoint.test', 'not-the-password')
    expect(a.status).toBe(401)
    expect(b.status).toBe(401)
    expect(await a.json()).toEqual(await b.json())
  })

  it('locks after five wrong passwords', async () => {
    for (let i = 0; i < 5; i++) expect((await login('admin@bottlepoint.test', 'wrong-password-x')).status).toBe(401)
    expect((await login('admin@bottlepoint.test', CONSOLE_PASSWORD)).status).toBe(423)
  })

  it('a shop account cannot sign in to the console, even with its real PIN', async () => {
    const r = await login('cashier@staff.bottlepoint.local', '1234')
    expect(r.status).toBe(401)
    const u = await prisma.user.findUniqueOrThrow({ where: { username: 'cashier' } })
    expect(u.failedPins).toBe(0)
  })

  it('a shop session cannot use the console API', async () => {
    const owner = await Client.login('owner')
    expect((await owner.get('/api/console/session/me')).status).toBe(401)
  })

  it('a console session cannot use the shop API', async () => {
    const c = await consoleLogin('admin@bottlepoint.test')
    expect((await c.get('/api/sales')).status).toBe(401)
    expect((await c.get('/api/session/me')).status).toBe(401)
  })

  it('a switched off console user loses access at once', async () => {
    const c = await consoleLogin('support@bottlepoint.test')
    await prisma.user.update({ where: { email: 'support@bottlepoint.test' }, data: { active: false } })
    expect((await c.get('/api/console/session/me')).status).toBe(401)
    expect((await login('support@bottlepoint.test', CONSOLE_PASSWORD)).status).toBe(401)
  })

  it('changing the password needs the current one and signs out other devices', async () => {
    const here = await consoleLogin('admin@bottlepoint.test')
    const there = await consoleLogin('admin@bottlepoint.test')
    const bad = await here.post('/api/console/session/password', { currentPassword: 'nope-nope-nope', newPassword: 'a-much-better-secret' })
    expect(bad.status).toBe(400)
    const weak = await here.post('/api/console/session/password', { currentPassword: CONSOLE_PASSWORD, newPassword: 'short' })
    expect(weak.status).toBe(400)
    const ok = await here.post('/api/console/session/password', { currentPassword: CONSOLE_PASSWORD, newPassword: 'a-much-better-secret' })
    expect(ok.status).toBe(200)
    expect((await here.get('/api/console/session/me')).status).toBe(200)
    expect((await there.get('/api/console/session/me')).status).toBe(401)
    expect((await login('admin@bottlepoint.test', CONSOLE_PASSWORD)).status).toBe(401)
    expect((await login('admin@bottlepoint.test', 'a-much-better-secret')).status).toBe(200)
  })

  it('the database refuses a user who is both platform staff and shop staff', async () => {
    await expect(
      prisma.user.update({ where: { username: 'cashier' }, data: { platformRole: 'SUPPORT' } })
    ).rejects.toThrow()
  })
})

describe('suspended clients', () => {
  async function subscribe(status: 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED') {
    const plan = await prisma.plan.create({ data: { code: 'test', name: 'Test', model: 'FLAT', priceCents: 250000 } })
    const now = new Date()
    await prisma.subscription.create({
      data: { businessId: fx.business.id, planId: plan.id, status, currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * 86400000) }
    })
  }

  it('no subscription record means the shop works as before', async () => {
    const c = await Client.login('cashier')
    expect((await c.get('/api/sales')).status).toBe(200)
  })

  it.each(['ACTIVE', 'TRIALING', 'PAST_DUE'] as const)('%s shops keep working', async status => {
    await subscribe(status)
    const c = await Client.login('cashier')
    expect((await c.get('/api/sales')).status).toBe(200)
  })

  it('a suspended shop can sign in and see why, but cannot trade', async () => {
    await subscribe('SUSPENDED')
    const c = await Client.login('cashier')
    expect((await c.get('/api/session/me')).status).toBe(200)
    const r = await c.get('/api/sales')
    expect(r.status).toBe(402)
    expect(r.body.error.code).toBe('subscription_suspended')
    const w = await c.post('/api/sales', { lines: [{ productId: fx.products.beer.id, qty: 1 }] })
    expect(w.status).toBe(402)
  })

  it('suspension takes effect on the very next request of an open session', async () => {
    await subscribe('ACTIVE')
    const c = await Client.login('cashier')
    expect((await c.get('/api/sales')).status).toBe(200)
    await prisma.subscription.update({ where: { businessId: fx.business.id }, data: { status: 'SUSPENDED' } })
    expect((await c.get('/api/sales')).status).toBe(402)
  })

  it('a cancelled shop is blocked too', async () => {
    await subscribe('CANCELLED')
    const c = await Client.login('owner')
    const r = await c.get('/api/products')
    expect(r.status).toBe(402)
    expect(r.body.error.code).toBe('subscription_cancelled')
  })
})

describe('secrets at rest', () => {
  it('round trips and never stores the plain value', () => {
    const stored = encryptSecret('bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919')
    expect(stored).not.toContain('bfb279f9')
    expect(decryptSecret(stored)).toBe('bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919')
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'))
    expect(secretHint(stored)).toMatch(/c919$/)
  })

  it('refuses a tampered value', () => {
    const stored = encryptSecret('consumer-secret')
    const parts = stored.split('.')
    parts[3] = Buffer.from('something-else!').toString('base64url')
    expect(() => decryptSecret(parts.join('.'))).toThrow()
  })
})
