import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { env } from '../src/env.js'
import { forgetTenant } from '../src/lib/tenant.js'
import { app, Client, ORIGIN, resetDb, seedFixture, type Fixture } from './helpers.js'

let fx: Fixture
beforeEach(async () => {
  await resetDb()
  forgetTenant()
  fx = await seedFixture()
})

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const upload = (c: Client, image: string) => c.req('PUT', '/api/admin/business/logo', { image })

describe('a shop logo', () => {
  it('only the owner uploads it, and it is served with its own type', async () => {
    const owner = await Client.login('owner')
    expect((await upload(await Client.login('manager'), PNG)).status).toBe(403)
    const r = await upload(owner, PNG)
    expect(r.status).toBe(200)
    expect(r.body.branding.logoUrl).toMatch(/^\/api\/session\/logo\?v=\d+$/)
    const img = await app.request(r.body.branding.logoUrl, { headers: { cookie: owner.cookie, origin: ORIGIN } })
    expect(img.status).toBe(200)
    expect(img.headers.get('content-type')).toBe('image/png')
    expect(img.headers.get('cache-control')).toContain('immutable')
    expect((await (await Client.login('cashier')).get('/api/session/me')).body.branding.logoUrl).toBe(r.body.branding.logoUrl)
  })

  it('refuses SVG, a file pretending to be an image, and anything too large', async () => {
    const owner = await Client.login('owner')
    const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg onload="alert(1)"/>').toString('base64')
    expect((await upload(owner, svg)).status).toBe(400)
    const fake = 'data:image/png;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64')
    expect((await upload(owner, fake)).status).toBe(400)
    const big = 'data:image/png;base64,' + Buffer.concat([Buffer.from(PNG.split(',')[1]!, 'base64'), Buffer.alloc(72_000)]).toString('base64')
    expect((await upload(owner, big)).status).toBeGreaterThanOrEqual(400)
  })

  it('can be removed', async () => {
    const owner = await Client.login('owner')
    await upload(owner, PNG)
    const r = await owner.req('DELETE', '/api/admin/business/logo')
    expect(r.body.branding.logoUrl).toBeNull()
    expect((await app.request('/api/session/logo', { headers: { cookie: owner.cookie } })).status).toBe(404)
  })
})

describe('a shop colour', () => {
  it('is a plain hex colour, set by the owner, back to brass with null', async () => {
    const owner = await Client.login('owner')
    expect((await owner.req('PATCH', '/api/admin/business', { brandColor: 'red' })).status).toBe(400)
    expect((await owner.req('PATCH', '/api/admin/business', { brandColor: '#1F6FEB' })).body.business.brandColor).toBe('#1f6feb')
    expect((await owner.get('/api/session/me')).body.branding.accent).toBe('#1f6feb')
    expect((await owner.req('PATCH', '/api/admin/business', { brandColor: null })).body.business.brandColor).toBeNull()
  })
})

describe('a colour for each part of the till', () => {
  it('saves the set, keeps the button colour in step, and refuses anything else', async () => {
    const owner = await Client.login('owner')
    const set = { buttons: '#0A7C5A', highlights: '#f2a900', text: '#0a7c5a', glow: '#123456' }
    const r = await owner.req('PATCH', '/api/admin/business', { brandTheme: set })
    expect(r.status).toBe(200)
    expect(r.body.business).toMatchObject({ brandColor: '#0a7c5a', brandTheme: { buttons: '#0a7c5a', highlights: '#f2a900', text: '#0a7c5a', glow: '#123456' } })
    const me = (await (await Client.login('cashier')).get('/api/session/me')).body.branding
    expect(me).toMatchObject({ accent: '#0a7c5a', theme: { highlights: '#f2a900' } })

    // parts left out follow the buttons
    const only = await owner.req('PATCH', '/api/admin/business', { brandTheme: { buttons: '#112233', highlights: null } })
    expect(only.body.business.brandTheme).toEqual({ buttons: '#112233' })

    expect((await owner.req('PATCH', '/api/admin/business', { brandTheme: { buttons: 'green' } })).status).toBe(400)
    expect((await owner.req('PATCH', '/api/admin/business', { brandTheme: { buttons: '#112233', background: '#000000' } })).status).toBe(400)
    expect((await owner.req('PATCH', '/api/admin/business', { brandTheme: { highlights: '#112233' } })).status).toBe(400)
    expect((await (await Client.login('manager')).req('PATCH', '/api/admin/business', { brandTheme: set })).status).toBe(403)

    // back to brass
    const reset = await owner.req('PATCH', '/api/admin/business', { brandTheme: null })
    expect(reset.body.business).toMatchObject({ brandColor: null, brandTheme: null })
    expect((await owner.get('/api/session/me')).body.branding).toMatchObject({ accent: null, theme: null })
  })

  it('another shop never sees it', async () => {
    const owner = await Client.login('owner')
    await owner.req('PATCH', '/api/admin/business', { brandTheme: { buttons: '#0a7c5a' } })
    const other = await prisma.business.create({ data: { name: 'Other' } })
    const branch = await prisma.branch.create({ data: { businessId: other.id, name: 'Main' } })
    const { createStaff } = await import('../src/lib/users.js')
    await createStaff(prisma, { businessId: other.id, name: 'O', username: 'otherowner', pin: '1234', role: 'OWNER', branchIds: [branch.id] })
    const o = await Client.login('otherowner')
    expect((await o.get('/api/session/me')).body.branding).toMatchObject({ name: 'Other', accent: null, theme: null })
  })
})

describe('on the shop address, before anyone signs in', () => {
  const BASE = 'pos.example.test'
  let saved: string | undefined
  beforeAll(() => { saved = env.TENANT_BASE_DOMAIN; env.TENANT_BASE_DOMAIN = BASE })
  afterAll(() => { env.TENANT_BASE_DOMAIN = saved; forgetTenant() })

  it('the sign in screen gets the name, colour and logo', async () => {
    await prisma.business.update({ where: { id: fx.business.id }, data: { slug: 'nayotix', brandColor: '#0a7c5a' } })
    const owner = await Client.login('owner').catch(() => null)
    expect(owner).toBeNull() // no address given: sign in needs the shop's address now
    await prisma.business.update({ where: { id: fx.business.id }, data: { logo: Buffer.from(PNG.split(',')[1]!, 'base64'), logoType: 'image/png', logoUpdatedAt: new Date() } })
    forgetTenant()
    const t = await (await app.request('/api/session/tenant', { headers: { host: 'nayotix.' + BASE } })).json()
    expect(t.branding).toMatchObject({ name: 'Test Wines', accent: '#0a7c5a' })
    const img = await app.request(t.branding.logoUrl, { headers: { host: 'nayotix.' + BASE } })
    expect(img.status).toBe(200)
    // another address gets nothing
    expect((await app.request('/api/session/logo', { headers: { host: 'other.' + BASE } })).status).toBe(404)
  })
})
