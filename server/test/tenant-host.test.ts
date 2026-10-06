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
