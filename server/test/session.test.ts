import { beforeEach, describe, expect, it } from 'vitest'
import { app, Client, ORIGIN, resetDb, seedFixture } from './helpers.js'
import { prisma } from '../src/db.js'

beforeEach(async () => {
  await resetDb()
  await seedFixture()
})

const pinLogin = (username: string, pin: string, origin = ORIGIN) =>
  app.request('/api/session/pin', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ username, pin })
  })

describe('session', () => {
  it('signs in with username and PIN and returns who I am', async () => {
    const c = await Client.login('cashier')
    const me = await c.get('/api/session/me')
    expect(me.status).toBe(200)
    expect(me.body.user.role).toBe('CASHIER')
    expect(me.body.branches.map((b: any) => b.name)).toEqual(['Westlands'])
  })

  it('owner sees every branch', async () => {
    const c = await Client.login('owner')
    const me = await c.get('/api/session/me')
    expect(me.body.branches.map((b: any) => b.name).sort()).toEqual(['Kilimani', 'Westlands'])
  })

  it('rejects a wrong PIN and locks after five tries', async () => {
    for (let i = 0; i < 5; i++) expect((await pinLogin('cashier', '0000')).status).toBe(401)
    const locked = await pinLogin('cashier', '1234')
    expect(locked.status).toBe(423)
  })

  it('a correct PIN resets the counter', async () => {
    for (let i = 0; i < 4; i++) await pinLogin('cashier', '0000')
    expect((await pinLogin('cashier', '1234')).status).toBe(200)
    const u = await prisma.user.findUnique({ where: { username: 'cashier' } })
    expect(u?.failedPins).toBe(0)
  })

  it('unknown user gets the same answer as a wrong PIN', async () => {
    const r = await pinLogin('nobody', '1234')
    expect(r.status).toBe(401)
  })

  it('switched off users cannot sign in', async () => {
    await prisma.user.update({ where: { username: 'cashier' }, data: { active: false } })
    expect((await pinLogin('cashier', '1234')).status).toBe(403)
  })

  it('blocks API calls without a session', async () => {
    const r = await new Client().get('/api/sales')
    expect(r.status).toBe(401)
  })

  it('public sign up is closed', async () => {
    const r = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email: 'x@y.z', password: '12345678', name: 'x' })
    })
    expect(r.status).toBe(404)
  })

  it('rejects state changes from an untrusted origin', async () => {
    const r = await pinLogin('cashier', '1234', 'https://evil.example')
    expect(r.status).toBe(403)
  })

  it('logout ends the session', async () => {
    const c = await Client.login('cashier')
    await c.post('/api/session/logout')
    const me = await c.get('/api/session/me')
    expect(me.status).toBe(401)
  })

  it('a switched off user loses access on the next request', async () => {
    const c = await Client.login('cashier')
    await prisma.user.update({ where: { username: 'cashier' }, data: { active: false } })
    expect((await c.get('/api/session/me')).status).toBe(401)
  })
})
