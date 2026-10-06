import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { createStaff } from '../src/lib/users.js'
import { deviceLabel } from '../src/rules/settings.js'
import { app, Client, consoleLogin, ORIGIN, PIN, resetDb, seedFixture, seedPlatform, type Fixture } from './helpers.js'

let fx: Fixture
beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
})

async function secondBusiness() {
  const business = await prisma.business.create({ data: { name: 'Other Wines' } })
  const branch = await prisma.branch.create({ data: { businessId: business.id, name: 'Karen' } })
  const owner = await createStaff(prisma, { businessId: business.id, name: 'Other Owner', username: 'owner2', pin: PIN, role: 'OWNER', branchIds: [] })
  const cashier = await createStaff(prisma, { businessId: business.id, name: 'Other Cashier', username: 'othercashier', pin: PIN, role: 'CASHIER', branchIds: [branch.id] })
  return { business, branch, owner, cashier }
}

async function suspend(businessId: string) {
  const plan = await prisma.plan.create({ data: { code: 'test', name: 'Test', model: 'FLAT', priceCents: 250000 } })
  const now = new Date()
  await prisma.subscription.create({
    data: { businessId, planId: plan.id, status: 'SUSPENDED', currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * 86400000) }
  })
}

const sessionsOf = (userId: string) => prisma.session.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })
const sessionOf = async (userId: string) => (await sessionsOf(userId))[0]!
const auditRows = (action: string) => prisma.auditLog.findMany({ where: { action } })
const signedIn = async (c: Client) => (await c.get('/api/session/me')).status

const UA = {
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  chromeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  chromeLinux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  chromeOs: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  chromeIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  safariIpad: 'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  edgeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.87',
  edgeAndroid: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 EdgA/126.0.0.0',
  edgeIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/126.0.2592.86 Mobile/15E148 Safari/605.1.15',
  firefoxWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  firefoxIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15',
  samsung: 'Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  opera: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 OPR/111.0.0.0'
}

describe('deviceLabel', () => {
  it('names the browser and the device from real user agents', () => {
    expect(deviceLabel(UA.chromeAndroid)).toBe('Chrome on Android')
    expect(deviceLabel(UA.chromeWindows)).toBe('Chrome on Windows')
    expect(deviceLabel(UA.chromeMac)).toBe('Chrome on macOS')
    expect(deviceLabel(UA.chromeLinux)).toBe('Chrome on Linux')
    expect(deviceLabel(UA.chromeOs)).toBe('Chrome on ChromeOS')
    expect(deviceLabel(UA.chromeIphone)).toBe('Chrome on iPhone')
    expect(deviceLabel(UA.safariIphone)).toBe('Safari on iPhone')
    expect(deviceLabel(UA.safariIpad)).toBe('Safari on iPad')
    expect(deviceLabel(UA.safariMac)).toBe('Safari on macOS')
    expect(deviceLabel(UA.edgeWindows)).toBe('Edge on Windows')
    expect(deviceLabel(UA.edgeAndroid)).toBe('Edge on Android')
    expect(deviceLabel(UA.edgeIphone)).toBe('Edge on iPhone')
    expect(deviceLabel(UA.firefoxWindows)).toBe('Firefox on Windows')
    expect(deviceLabel(UA.firefoxAndroid)).toBe('Firefox on Android')
    expect(deviceLabel(UA.firefoxLinux)).toBe('Firefox on Linux')
    expect(deviceLabel(UA.firefoxIphone)).toBe('Firefox on iPhone')
    expect(deviceLabel(UA.samsung)).toBe('Samsung Internet on Android')
    expect(deviceLabel(UA.opera)).toBe('Opera on Windows')
  })

  it('falls back when there is little or nothing to go on', () => {
    expect(deviceLabel('')).toBe('Unknown device')
    expect(deviceLabel('   ')).toBe('Unknown device')
    expect(deviceLabel(null)).toBe('Unknown device')
    expect(deviceLabel(undefined)).toBe('Unknown device')
    expect(deviceLabel('curl/8.4.0')).toBe('Unknown device')
    expect(deviceLabel('Dalvik/2.1.0 (Linux; U; Android 13; SM-A546B Build/TP1A)')).toBe('Android')
  })
})

describe('GET /api/admin/sessions', () => {
  it('lists the active sessions of this business only', async () => {
    const other = await secondBusiness()
    await seedPlatform()
    const owner = await Client.login('owner')
    await Client.login('cashier')
    await Client.login('manager')
    const gone = await Client.login('kilicashier')
    const owner2 = await Client.login('owner2')
    await Client.login('othercashier')
    await consoleLogin('support@bottlepoint.test')

    const cashierSession = await sessionOf(fx.users.cashier.id)
    await prisma.session.update({ where: { id: cashierSession.id }, data: { userAgent: UA.chromeAndroid, ipAddress: '196.201.214.10' } })
    await prisma.session.update({ where: { id: (await sessionOf(fx.users.manager.id)).id }, data: { userAgent: UA.safariIphone } })
    // no address recorded reads as null, not as an empty string
    await prisma.session.updateMany({ where: { userId: fx.users.owner.id }, data: { ipAddress: '', userAgent: '' } })
    // an expired session is not a signed in device any more
    await prisma.session.updateMany({ where: { userId: fx.users.kiliCashier.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect(await signedIn(gone)).toBe(401)

    const r = await owner.get('/api/admin/sessions')
    expect(r.status).toBe(200)
    expect(r.body.total).toBe(3)
    expect(r.body.sessions.map((s: any) => s.user.name).sort()).toEqual(['cashier', 'manager', 'owner'])
    const byUser = Object.fromEntries(r.body.sessions.map((s: any) => [s.user.name, s]))
    const fresh = await prisma.session.findUniqueOrThrow({ where: { id: cashierSession.id } })
    expect(byUser.cashier).toEqual({
      id: cashierSession.id,
      user: { id: fx.users.cashier.id, name: 'cashier', role: 'CASHIER' },
      createdAt: fresh.createdAt.toISOString(),
      lastSeenAt: fresh.updatedAt.toISOString(),
      device: 'Chrome on Android',
      ip: '196.201.214.10',
      current: false
    })
    expect(byUser.manager.device).toBe('Safari on iPhone')
    expect(byUser.owner.device).toBe('Unknown device')
    expect(byUser.owner.ip).toBeNull()
    expect(byUser.owner.current).toBe(true)
    expect(r.body.sessions.filter((s: any) => s.current)).toHaveLength(1)

    // no session token anywhere in the answer
    const text = JSON.stringify(r.body)
    expect(text).not.toContain('token')
    for (const s of await prisma.session.findMany()) expect(text).not.toContain(s.token)

    const theirs = await owner2.get('/api/admin/sessions')
    expect(theirs.body.sessions.map((s: any) => s.user.id).sort()).toEqual([other.cashier.id, other.owner.id].sort())
    expect(theirs.body.total).toBe(2)
  })

  it('is for owners only', async () => {
    expect((await (await Client.login('cashier')).get('/api/admin/sessions')).status).toBe(403)
    expect((await (await Client.login('manager')).get('/api/admin/sessions')).status).toBe(403)
    expect((await app.request('/api/admin/sessions', { headers: { origin: ORIGIN } })).status).toBe(401)
    await seedPlatform()
    expect((await (await consoleLogin('admin@bottlepoint.test')).get('/api/admin/sessions')).status).toBe(401)
  })

  it('answers 402 when the business is suspended', async () => {
    const owner = await Client.login('owner')
    await suspend(fx.business.id)
    expect((await owner.get('/api/admin/sessions')).status).toBe(402)
  })
})

describe('DELETE /api/admin/sessions/:id', () => {
  it('signs that device out at once and logs it', async () => {
    const owner = await Client.login('owner')
    const cashier = await Client.login('cashier')
    const cashierOther = await Client.login('cashier')
    const [first, second] = await sessionsOf(fx.users.cashier.id)
    await prisma.session.update({ where: { id: first!.id }, data: { userAgent: UA.chromeAndroid, ipAddress: '10.0.0.7' } })
    expect(await signedIn(cashier)).toBe(200)

    const r = await owner.del(`/api/admin/sessions/${first!.id}`)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(await signedIn(cashier)).toBe(401)
    expect((await cashier.get('/api/products')).status).toBe(401)
    // the other device of the same person is untouched
    expect(await signedIn(cashierOther)).toBe(200)
    expect(await prisma.session.count({ where: { id: second!.id } })).toBe(1)

    const rows = await auditRows('session.revoked')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ userId: fx.users.owner.id, businessId: fx.business.id, entity: 'session', entityId: first!.id })
    expect(rows[0]!.data).toEqual({ userId: fx.users.cashier.id, name: 'cashier', device: 'Chrome on Android', ip: '10.0.0.7' })
    expect(JSON.stringify(rows[0]!.data)).not.toContain(first!.token)

    const log = await owner.get('/api/admin/audit?group=signin')
    expect(log.body.entries[0].summary).toBe('owner signed cashier out of Chrome on Android')
    // gone means gone
    expect((await owner.del(`/api/admin/sessions/${first!.id}`)).status).toBe(404)
  })

  it('will not sign out the device making the call', async () => {
    const owner = await Client.login('owner')
    const mine = await sessionOf(fx.users.owner.id)
    const r = await owner.del(`/api/admin/sessions/${mine.id}`)
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('own_session')
    expect(await signedIn(owner)).toBe(200)
    expect(await auditRows('session.revoked')).toHaveLength(0)
    // another device of the same owner can be signed out
    const ownerOther = await Client.login('owner')
    const otherId = (await sessionsOf(fx.users.owner.id)).find(s => s.id !== mine.id)!.id
    expect((await owner.del(`/api/admin/sessions/${otherId}`)).status).toBe(200)
    expect(await signedIn(ownerOther)).toBe(401)
    expect(await signedIn(owner)).toBe(200)
  })

  it('answers 404 for sessions of another business, platform staff, or nothing', async () => {
    const other = await secondBusiness()
    const platform = await seedPlatform()
    const owner = await Client.login('owner')
    const cashier2 = await Client.login('othercashier')
    const staff = await consoleLogin('support@bottlepoint.test')
    const theirs = await sessionOf(other.cashier.id)
    const staffSession = await sessionOf(platform.support.id)

    for (const sid of [theirs.id, staffSession.id, 'nope']) {
      const r = await owner.del(`/api/admin/sessions/${sid}`)
      expect(r.status, sid).toBe(404)
      expect(r.body.error.code).toBe('not_found')
    }
    expect(await signedIn(cashier2)).toBe(200)
    expect((await staff.get('/api/console/session/me')).status).toBe(200)
    expect(await auditRows('session.revoked')).toHaveLength(0)

    // and the other way round
    const owner2 = await Client.login('owner2')
    const mine = await sessionOf(fx.users.owner.id)
    expect((await owner2.del(`/api/admin/sessions/${mine.id}`)).status).toBe(404)
    expect(await signedIn(owner)).toBe(200)
  })

  it('logs once when two requests race', async () => {
    const owner = await Client.login('owner')
    const ownerOther = await Client.login('owner')
    await Client.login('cashier')
    const target = await sessionOf(fx.users.cashier.id)
    const results = await Promise.all([owner.del(`/api/admin/sessions/${target.id}`), ownerOther.del(`/api/admin/sessions/${target.id}`)])
    expect(results.map(r => r.status).sort()).toEqual([200, 404])
    expect(await auditRows('session.revoked')).toHaveLength(1)
  })

  it('is for owners only, never the console, and not while suspended', async () => {
    await Client.login('kilicashier')
    const target = await sessionOf(fx.users.kiliCashier.id)
    const path = `/api/admin/sessions/${target.id}`
    expect((await (await Client.login('cashier')).del(path)).status).toBe(403)
    expect((await (await Client.login('manager')).del(path)).status).toBe(403)
    expect((await app.request(path, { method: 'DELETE', headers: { origin: ORIGIN } })).status).toBe(401)
    await seedPlatform()
    expect((await (await consoleLogin('admin@bottlepoint.test')).del(path)).status).toBe(401)
    const owner = await Client.login('owner')
    await suspend(fx.business.id)
    expect((await owner.del(path)).status).toBe(402)
    expect(await prisma.session.count({ where: { id: target.id } })).toBe(1)
    expect(await auditRows('session.revoked')).toHaveLength(0)
  })
})

describe('POST /api/admin/users/:id/sign-out', () => {
  it('signs a staff member out everywhere and logs it', async () => {
    const owner = await Client.login('owner')
    const a = await Client.login('cashier')
    const b = await Client.login('cashier')
    const manager = await Client.login('manager')

    const r = await owner.post(`/api/admin/users/${fx.users.cashier.id}/sign-out`)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ signedOut: 2 })
    expect(await signedIn(a)).toBe(401)
    expect(await signedIn(b)).toBe(401)
    expect(await signedIn(manager)).toBe(200)
    expect(await signedIn(owner)).toBe(200)

    const rows = await auditRows('user.signed_out')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ userId: fx.users.owner.id, businessId: fx.business.id, entity: 'user', entityId: fx.users.cashier.id })
    expect(rows[0]!.data).toEqual({ name: 'cashier', sessionsEnded: 2 })

    // they can sign in again, and nothing is left to end the second time
    await Client.login('cashier')
    expect((await owner.post(`/api/admin/users/${fx.users.cashier.id}/sign-out`)).body).toEqual({ signedOut: 1 })
    expect((await owner.post(`/api/admin/users/${fx.users.cashier.id}/sign-out`)).body).toEqual({ signedOut: 0 })
    expect(await auditRows('user.signed_out')).toHaveLength(3)
  })

  it('keeps the calling device when the owner signs themself out', async () => {
    const owner = await Client.login('owner')
    const phone = await Client.login('owner')
    const tablet = await Client.login('owner')
    const r = await owner.post(`/api/admin/users/${fx.users.owner.id}/sign-out`)
    expect(r.body).toEqual({ signedOut: 2 })
    expect(await signedIn(phone)).toBe(401)
    expect(await signedIn(tablet)).toBe(401)
    expect(await signedIn(owner)).toBe(200)
    expect((await owner.get('/api/admin/sessions')).body.total).toBe(1)
  })

  it('answers 404 for a user of another business, platform staff, or nobody', async () => {
    const other = await secondBusiness()
    const platform = await seedPlatform()
    const owner = await Client.login('owner')
    const cashier2 = await Client.login('othercashier')
    const staff = await consoleLogin('support@bottlepoint.test')
    for (const uid of [other.cashier.id, other.owner.id, platform.support.id, 'nope']) {
      const r = await owner.post(`/api/admin/users/${uid}/sign-out`)
      expect(r.status, uid).toBe(404)
      expect(r.body.error.code).toBe('not_found')
    }
    expect(await signedIn(cashier2)).toBe(200)
    expect((await staff.get('/api/console/session/me')).status).toBe(200)
    expect(await auditRows('user.signed_out')).toHaveLength(0)

    const owner2 = await Client.login('owner2')
    expect((await owner2.post(`/api/admin/users/${fx.users.owner.id}/sign-out`)).status).toBe(404)
    expect(await signedIn(owner)).toBe(200)
  })

  it('is for owners only, never the console, and not while suspended', async () => {
    const target = await Client.login('kilicashier')
    const path = `/api/admin/users/${fx.users.kiliCashier.id}/sign-out`
    expect((await (await Client.login('cashier')).post(path)).status).toBe(403)
    expect((await (await Client.login('manager')).post(path)).status).toBe(403)
    expect((await app.request(path, { method: 'POST', headers: { origin: ORIGIN } })).status).toBe(401)
    await seedPlatform()
    expect((await (await consoleLogin('admin@bottlepoint.test')).post(path)).status).toBe(401)
    const owner = await Client.login('owner')
    await suspend(fx.business.id)
    expect((await owner.post(path)).status).toBe(402)
    expect(await prisma.session.count({ where: { userId: fx.users.kiliCashier.id } })).toBe(1)
    expect(await auditRows('user.signed_out')).toHaveLength(0)
    void target
  })
})
