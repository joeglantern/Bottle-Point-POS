import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { env } from '../src/env.js'
import { forgetTenant, slugFromHost } from '../src/lib/tenant.js'
import { createStaff } from '../src/lib/users.js'
import { app, ORIGIN, PIN, resetDb, seedFixture, type Fixture } from './helpers.js'

const BASE = 'pos.example.test'
let fx: Fixture
let saved: string | undefined

beforeAll(() => {
  saved = env.TENANT_BASE_DOMAIN
  env.TENANT_BASE_DOMAIN = BASE
})
afterAll(() => {
  env.TENANT_BASE_DOMAIN = saved
  forgetTenant()
})
beforeEach(async () => {
  await resetDb()
  forgetTenant()
  fx = await seedFixture()
  await prisma.business.update({ where: { id: fx.business.id }, data: { slug: 'nyrolix' } })
  const other = await prisma.business.create({ data: { name: 'Other Shop', slug: 'othershop' } })
  const branch = await prisma.branch.create({ data: { businessId: other.id, name: 'Main' } })
  await createStaff(prisma, { businessId: other.id, name: 'Other owner', username: 'otherowner', pin: PIN, role: 'OWNER', branchIds: [branch.id] })
})

const host = (slug: string) => `${slug}.${BASE}`

async function signIn(h: string, username: string, pin = PIN) {
  const res = await app.request('/api/session/pin', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, host: h },
    body: JSON.stringify({ username, pin })
  })
  const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
  return { status: res.status, cookie, body: await res.json() }
}
const get = (h: string, path: string, cookie = '') => app.request(path, { headers: { origin: ORIGIN, host: h, cookie } })

describe('one address per client', () => {
  it('reads the client from the address', () => {
    expect(slugFromHost('nyrolix.pos.example.test')).toBe('nyrolix')
    expect(slugFromHost('pos.example.test')).toBeNull()
    expect(slugFromHost('a.b.pos.example.test')).toBeNull()
    expect(slugFromHost('console.pos.example.test')).toBeNull()
    expect(slugFromHost('nyrolix.pos.example.test.evil.com')).toBeNull()
    expect(slugFromHost('evilpos.example.test')).toBeNull()
  })

  it('the sign in screen learns the shop name from the address', async () => {
    const r = await get(host('nyrolix'), '/api/session/tenant')
    expect(r.status).toBe(200)
    expect((await r.json()).tenant).toEqual({ name: 'Test Wines', slug: 'nyrolix' })
    expect((await get(host('nobody'), '/api/session/tenant')).status).toBe(404)
    expect((await get(BASE, '/api/session/tenant')).status).toBe(404)
  })

  it('staff sign in on their own address and work normally', async () => {
    const s = await signIn(host('nyrolix'), 'cashier')
    expect(s.status).toBe(200)
    expect((await get(host('nyrolix'), '/api/session/me', s.cookie)).status).toBe(200)
    expect((await get(host('nyrolix'), '/api/sales', s.cookie)).status).toBe(200)
  })

  it('staff of another client cannot sign in here, and get the same answer as a wrong PIN', async () => {
    const s = await signIn(host('nyrolix'), 'otherowner')
    expect(s.status).toBe(401)
    expect(s.body.error.message).toBe('Wrong username or PIN.')
    // and it never counts towards their lockout
    const u = await prisma.user.findUniqueOrThrow({ where: { username: 'otherowner' } })
    expect(u.failedPins).toBe(0)
  })

  it('a session taken to another client address is refused', async () => {
    const s = await signIn(host('nyrolix'), 'owner')
    expect((await get(host('othershop'), '/api/session/me', s.cookie)).status).toBe(401)
    expect((await get(host('othershop'), '/api/sales', s.cookie)).status).toBe(401)
  })

  it('no one can sign in on the bare domain or an unknown address', async () => {
    expect((await signIn(BASE, 'cashier')).status).toBe(404)
    expect((await signIn(host('nobody'), 'cashier')).status).toBe(404)
  })

  it('a session from the bare domain cannot reach a client', async () => {
    const s = await signIn(host('nyrolix'), 'cashier')
    expect((await get(BASE, '/api/sales', s.cookie)).status).toBe(401)
  })

  it('a renamed address takes effect at once', async () => {
    const s = await signIn(host('nyrolix'), 'cashier')
    await prisma.business.update({ where: { id: fx.business.id }, data: { slug: 'nyrolix-wines' } })
    forgetTenant()
    expect((await get(host('nyrolix'), '/api/sales', s.cookie)).status).toBe(401)
    expect((await get(host('nyrolix-wines'), '/api/sales', s.cookie)).status).toBe(200)
  })

  it('the database refuses a badly formed address', async () => {
    await expect(prisma.business.update({ where: { id: fx.business.id }, data: { slug: 'Bad Slug' } })).rejects.toThrow()
    await expect(prisma.business.update({ where: { id: fx.business.id }, data: { slug: '-dash' } })).rejects.toThrow()
  })
})

describe('changing a client address', () => {
  it('moves the shop, forwards the old address and keeps sessions working on the new one', async () => {
    const { seedPlatform, consoleLogin } = await import('./helpers.js')
    await seedPlatform()
    const admin = await consoleLogin('admin@bottlepoint.test')
    const support = await consoleLogin('support@bottlepoint.test')

    // only super admins move an address
    const denied = await support.patch(`/api/console/tenants/${fx.business.id}`, { slug: 'nayotix' })
    expect(denied.status).toBe(403)

    const r = await admin.patch(`/api/console/tenants/${fx.business.id}`, { slug: 'nayotix', name: 'Nayotix' })
    expect(r.status).toBe(200)
    expect(r.body.tenant.slug).toBe('nayotix')

    // the new address is the shop now
    const here = await get(host('nayotix'), '/api/session/tenant')
    expect((await here.json()).tenant).toEqual({ name: 'Nayotix', slug: 'nayotix' })
    expect((await signIn(host('nayotix'), 'cashier')).status).toBe(200)

    // the old address tells the page where to go, and nobody can sign in there
    const old = await get(host('nyrolix'), '/api/session/tenant')
    expect(old.status).toBe(404)
    const body = await old.json()
    expect(body.error.code).toBe('shop_moved')
    expect(body.error.details.url).toBe(`https://nayotix.${BASE}`)
    expect((await signIn(host('nyrolix'), 'cashier')).status).toBe(404)

    // moving again keeps every earlier address
    await admin.patch(`/api/console/tenants/${fx.business.id}`, { slug: 'nayotix-wines' })
    const b = await prisma.business.findUniqueOrThrow({ where: { id: fx.business.id } })
    expect(b.formerSlugs.sort()).toEqual(['nayotix', 'nyrolix'])
    expect((await (await get(host('nyrolix'), '/api/session/tenant')).json()).error.details.url).toBe(`https://nayotix-wines.${BASE}`)

    // moving back to a former address takes it off the former list
    await admin.patch(`/api/console/tenants/${fx.business.id}`, { slug: 'nyrolix' })
    const back = await prisma.business.findUniqueOrThrow({ where: { id: fx.business.id } })
    expect(back.formerSlugs.sort()).toEqual(['nayotix', 'nayotix-wines'])
  })

  it('a live shop always wins over someone else\'s former address', async () => {
    const { seedPlatform, consoleLogin } = await import('./helpers.js')
    await seedPlatform()
    const admin = await consoleLogin('admin@bottlepoint.test')
    await admin.patch(`/api/console/tenants/${fx.business.id}`, { slug: 'nayotix' })
    // another client is now given the old name
    const other = await prisma.business.findFirstOrThrow({ where: { slug: 'othershop' } })
    expect((await admin.patch(`/api/console/tenants/${other.id}`, { slug: 'nyrolix' })).status).toBe(200)
    const t = await get(host('nyrolix'), '/api/session/tenant')
    expect((await t.json()).tenant.name).toBe('Other Shop')
  })

  it('cannot take an address another client is using', async () => {
    const { seedPlatform, consoleLogin } = await import('./helpers.js')
    await seedPlatform()
    const admin = await consoleLogin('admin@bottlepoint.test')
    const r = await admin.patch(`/api/console/tenants/${fx.business.id}`, { slug: 'othershop' })
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('duplicate_slug')
  })
})
