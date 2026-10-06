import { beforeEach, describe, expect, it } from 'vitest'
import { createPlatformAdmin } from '../scripts/create-platform-admin.js'
import { prisma } from '../src/db.js'
import { createPlatformUser } from '../src/lib/users.js'
import { Client, CONSOLE_PASSWORD, consoleLogin, resetDb, seedFixture, seedPlatform, type Fixture } from './helpers.js'

let fx: Fixture
let team: Awaited<ReturnType<typeof seedPlatform>>
let admin: Client
let support: Client
let billing: Client

const email = (name: string) => `${name}@bottlepoint.test`

beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
  team = await seedPlatform()
  admin = await consoleLogin(email('admin'))
  support = await consoleLogin(email('support'))
  billing = await consoleLogin(email('billing'))
})

// Nothing readable may hold the plain password: not the account row, not the audit trail.
async function expectNotStored(password: string, userId: string) {
  const accounts = await prisma.account.findMany({ where: { userId } })
  expect(accounts).toHaveLength(1)
  expect(accounts[0]!.password).not.toBe(password)
  expect(accounts[0]!.password).not.toContain(password)
  const audit = await prisma.auditLog.findMany()
  expect(JSON.stringify(audit, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(password)
  const users = await prisma.user.findMany()
  expect(JSON.stringify(users)).not.toContain(password)
}

describe('console team: who may use it', () => {
  it('answers 401 without a session and to a shop owner', async () => {
    const owner = await Client.login('owner')
    for (const c of [new Client(), owner]) {
      expect((await c.get('/api/console/team')).status).toBe(401)
      expect((await c.post('/api/console/team', { name: 'Jane Doe', email: 'jane@x.test', role: 'SUPPORT' })).status).toBe(401)
      expect((await c.patch(`/api/console/team/${team.support.id}`, { active: false })).status).toBe(401)
      expect((await c.post(`/api/console/team/${team.support.id}/reset-password`)).status).toBe(401)
    }
    expect(await prisma.user.count({ where: { platformRole: { not: null } } })).toBe(3)
  })

  it('lets every role read the list but only a super admin change it', async () => {
    for (const c of [support, billing]) {
      expect((await c.get('/api/console/team')).status).toBe(200)
      const create = await c.post('/api/console/team', { name: 'Jane Doe', email: 'jane@x.test', role: 'SUPPORT' })
      expect(create.status).toBe(403)
      expect(create.body.error.code).toBe('forbidden')
      expect((await c.patch(`/api/console/team/${team.admin.id}`, { role: 'SUPPORT' })).status).toBe(403)
      expect((await c.patch(`/api/console/team/${team.billing.id}`, { name: 'Someone Else' })).status).toBe(403)
      expect((await c.post(`/api/console/team/${team.admin.id}/reset-password`)).status).toBe(403)
    }
    expect(await prisma.user.count({ where: { platformRole: { not: null } } })).toBe(3)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: team.admin.id } })).platformRole).toBe('SUPER_ADMIN')
  })
})

describe('GET /team', () => {
  it('lists console users only, with no secrets', async () => {
    const r = await admin.get('/api/console/team')
    expect(r.status).toBe(200)
    expect(r.body.team).toHaveLength(3)
    const me = r.body.team.find((m: any) => m.id === team.admin.id)
    expect(me).toMatchObject({ name: 'admin', email: email('admin'), role: 'SUPER_ADMIN', active: true, locked: false })
    expect(Object.keys(me).sort()).toEqual(['active', 'createdAt', 'email', 'id', 'lastSignInAt', 'locked', 'name', 'role'])
    expect(typeof me.lastSignInAt).toBe('string')
    // shop staff never show up here
    expect(r.body.team.some((m: any) => m.name === 'owner')).toBe(false)
    expect(JSON.stringify(r.body)).not.toMatch(/password|failedPins/)
  })

  it('shows who is locked out and who never signed in', async () => {
    const fresh = await createPlatformUser(prisma, { name: 'Fresh', email: 'fresh@x.test', password: CONSOLE_PASSWORD, role: 'BILLING' })
    await prisma.user.update({ where: { id: fresh.id }, data: { lockedUntil: new Date(Date.now() + 600_000) } })
    const r = await support.get('/api/console/team')
    const row = r.body.team.find((m: any) => m.id === fresh.id)
    expect(row.locked).toBe(true)
    expect(row.lastSignInAt).toBeNull()
  })
})

describe('POST /team', () => {
  it('creates a member and returns a temporary password once that works for sign in', async () => {
    const r = await admin.post('/api/console/team', { name: '  Jane Doe ', email: ' Jane@Example.COM ', role: 'SUPPORT' })
    expect(r.status).toBe(201)
    expect(r.body.member).toMatchObject({ name: 'Jane Doe', email: 'jane@example.com', role: 'SUPPORT', active: true, locked: false })
    const password: string = r.body.temporaryPassword
    expect(password).toMatch(/^[A-Za-z0-9]{20}$/)

    const jane = await consoleLogin('jane@example.com', password)
    expect((await jane.get('/api/console/session/me')).body.user.role).toBe('SUPPORT')

    await expectNotStored(password, r.body.member.id)
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'console.team.created' } })
    expect(row.userId).toBe(team.admin.id)
    expect(row.entityId).toBe(r.body.member.id)
    expect(row.data).toEqual({ name: 'Jane Doe', email: 'jane@example.com', role: 'SUPPORT' })
    // the list never repeats it
    expect(JSON.stringify((await admin.get('/api/console/team')).body)).not.toContain(password)
  })

  it('gives each member a different password', async () => {
    const a = await admin.post('/api/console/team', { name: 'Jane Doe', email: 'a@x.test', role: 'SUPPORT' })
    const b = await admin.post('/api/console/team', { name: 'John Doe', email: 'b@x.test', role: 'BILLING' })
    expect(a.body.temporaryPassword).not.toBe(b.body.temporaryPassword)
  })

  it('validates the input', async () => {
    const bad = [
      { name: 'Jane Doe', email: 'not-an-email', role: 'SUPPORT' },
      { name: 'J', email: 'jane@x.test', role: 'SUPPORT' },
      { name: 'Jane Doe', email: 'jane@x.test', role: 'OWNER' },
      { name: 'Jane Doe', email: 'jane@x.test' },
      { email: 'jane@x.test', role: 'SUPPORT' },
      { name: 'x'.repeat(81), email: 'jane@x.test', role: 'SUPPORT' }
    ]
    for (const b of bad) {
      const r = await admin.post('/api/console/team', b)
      expect(r.status).toBe(400)
      expect(r.body.error.code).toBe('bad_request')
    }
    expect(await prisma.user.count({ where: { platformRole: { not: null } } })).toBe(3)
  })

  it('refuses an email already used by the team or by shop staff', async () => {
    const dup = await admin.post('/api/console/team', { name: 'Other Support', email: 'SUPPORT@bottlepoint.test', role: 'BILLING' })
    expect(dup.status).toBe(409)
    expect(dup.body.error.code).toBe('duplicate_email')

    const staff = await admin.post('/api/console/team', { name: 'Shop Owner', email: fx.users.owner.email, role: 'SUPER_ADMIN' })
    expect(staff.status).toBe(409)
    expect(staff.body.error.code).toBe('duplicate_email')
    // the shop owner is untouched and still a shop user
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: fx.users.owner.id } })
    expect(owner.platformRole).toBeNull()
    expect(owner.businessId).toBe(fx.business.id)

    // an address in the shop staff domain is refused even when nobody has it yet
    const reserved = await admin.post('/api/console/team', { name: 'Future Staff', email: 'nobody@staff.bottlepoint.local', role: 'SUPPORT' })
    expect(reserved.status).toBe(400)
    expect(await prisma.user.count({ where: { platformRole: { not: null } } })).toBe(3)
  })

  it('lets exactly one of two racing requests take an email', async () => {
    const input = { name: 'Jane Doe', email: 'race@x.test', role: 'SUPPORT' }
    const [a, b] = await Promise.all([admin.post('/api/console/team', input), admin.post('/api/console/team', input)])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    const loser = a.status === 409 ? a : b
    expect(loser.body.error.code).toBe('duplicate_email')
    expect(await prisma.user.count({ where: { email: 'race@x.test' } })).toBe(1)
    expect(await prisma.auditLog.count({ where: { action: 'console.team.created' } })).toBe(1)
  })
})

describe('PATCH /team/:id', () => {
  it('renames without ending sessions', async () => {
    const r = await admin.patch(`/api/console/team/${team.support.id}`, { name: 'Sam Support' })
    expect(r.status).toBe(200)
    expect(r.body.member.name).toBe('Sam Support')
    expect(r.body.sessionsEnded).toBe(0)
    expect((await support.get('/api/console/session/me')).status).toBe(200)
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'console.team.updated' } })
    expect(row.data).toMatchObject({ changes: { name: { from: 'support', to: 'Sam Support' } } })
  })

  it('changing the role signs that person out and applies on their next sign in', async () => {
    const r = await admin.patch(`/api/console/team/${team.support.id}`, { role: 'BILLING' })
    expect(r.status).toBe(200)
    expect(r.body.member.role).toBe('BILLING')
    expect(r.body.sessionsEnded).toBe(1)
    expect((await support.get('/api/console/session/me')).status).toBe(401)
    const again = await consoleLogin(email('support'))
    expect((await again.get('/api/console/session/me')).body.user.role).toBe('BILLING')
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'console.team.updated' } })
    expect(row.data).toMatchObject({ changes: { role: { from: 'SUPPORT', to: 'BILLING' } }, sessionsEnded: 1 })
  })

  it('switching off ends sessions and blocks sign in, switching on restores it and clears a lockout', async () => {
    const off = await admin.patch(`/api/console/team/${team.billing.id}`, { active: false })
    expect(off.status).toBe(200)
    expect(off.body.member.active).toBe(false)
    expect(off.body.sessionsEnded).toBe(1)
    expect((await billing.get('/api/console/team')).status).toBe(401)
    await expect(consoleLogin(email('billing'))).rejects.toThrow(/401/)

    await prisma.user.update({ where: { id: team.billing.id }, data: { failedPins: 3, lockedUntil: new Date(Date.now() + 600_000) } })
    const on = await admin.patch(`/api/console/team/${team.billing.id}`, { active: true })
    expect(on.body.member).toMatchObject({ active: true, locked: false })
    const back = await consoleLogin(email('billing'))
    expect((await back.get('/api/console/session/me')).status).toBe(200)
  })

  it('writes no audit row and ends no session when nothing really changes', async () => {
    const r = await admin.patch(`/api/console/team/${team.support.id}`, { role: 'SUPPORT', active: true, name: 'support' })
    expect(r.status).toBe(200)
    expect(r.body.sessionsEnded).toBe(0)
    expect(await prisma.auditLog.count({ where: { action: 'console.team.updated' } })).toBe(0)
    expect((await support.get('/api/console/session/me')).status).toBe(200)
  })

  it('validates and answers 404 for unknown people and for shop staff', async () => {
    expect((await admin.patch(`/api/console/team/${team.support.id}`, {})).status).toBe(400)
    expect((await admin.patch(`/api/console/team/${team.support.id}`, { role: 'OWNER' })).status).toBe(400)
    expect((await admin.patch(`/api/console/team/${team.support.id}`, { active: 'no' })).status).toBe(400)
    expect((await admin.patch('/api/console/team/nobody', { active: false })).status).toBe(404)
    const shop = await admin.patch(`/api/console/team/${fx.users.owner.id}`, { role: 'SUPER_ADMIN' })
    expect(shop.status).toBe(404)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: fx.users.owner.id } })).platformRole).toBeNull()
  })

  it('does not let you demote or switch off yourself, but you can fix your name', async () => {
    const demote = await admin.patch(`/api/console/team/${team.admin.id}`, { role: 'SUPPORT' })
    expect(demote.status).toBe(422)
    expect(demote.body.error.code).toBe('cannot_change_self')
    const off = await admin.patch(`/api/console/team/${team.admin.id}`, { active: false })
    expect(off.status).toBe(422)
    expect(off.body.error.code).toBe('cannot_change_self')
    const me = await prisma.user.findUniqueOrThrow({ where: { id: team.admin.id } })
    expect(me).toMatchObject({ platformRole: 'SUPER_ADMIN', active: true })

    const rename = await admin.patch(`/api/console/team/${team.admin.id}`, { name: 'Ada Admin' })
    expect(rename.status).toBe(200)
    expect((await admin.get('/api/console/session/me')).body.user.name).toBe('Ada Admin')
  })

  it('a super admin can demote another one while one remains', async () => {
    const second = await createPlatformUser(prisma, { name: 'Second', email: 'second@x.test', password: CONSOLE_PASSWORD, role: 'SUPER_ADMIN' })
    const r = await admin.patch(`/api/console/team/${second.id}`, { role: 'SUPPORT' })
    expect(r.status).toBe(200)
    expect(await prisma.user.count({ where: { platformRole: 'SUPER_ADMIN', active: true } })).toBe(1)
  })

  for (const change of [{ role: 'SUPPORT' }, { active: false }]) {
    it(`two super admins removing each other at once (${JSON.stringify(change)}): exactly one wins`, async () => {
      const second = await createPlatformUser(prisma, { name: 'Second', email: 'second@x.test', password: CONSOLE_PASSWORD, role: 'SUPER_ADMIN' })
      const other = await consoleLogin('second@x.test')
      const [a, b] = await Promise.all([
        admin.patch(`/api/console/team/${second.id}`, change),
        other.patch(`/api/console/team/${team.admin.id}`, change)
      ])
      expect([a.status, b.status].filter(s => s === 200)).toHaveLength(1)
      const loser = a.status === 200 ? b : a
      expect([401, 403, 422]).toContain(loser.status)
      // the console always keeps one working super admin
      expect(await prisma.user.count({ where: { platformRole: 'SUPER_ADMIN', active: true } })).toBe(1)
      expect(await prisma.auditLog.count({ where: { action: 'console.team.updated' } })).toBe(1)
    })
  }
})

describe('POST /team/:id/reset-password', () => {
  it('gives a new temporary password once, ends sessions and clears the lockout', async () => {
    await prisma.user.update({ where: { id: team.support.id }, data: { failedPins: 4, lockedUntil: new Date(Date.now() + 600_000) } })
    const r = await admin.post(`/api/console/team/${team.support.id}/reset-password`)
    expect(r.status).toBe(200)
    const password: string = r.body.temporaryPassword
    expect(password).toMatch(/^[A-Za-z0-9]{20}$/)
    expect(r.body.sessionsEnded).toBe(1)
    expect(r.body.member).toMatchObject({ id: team.support.id, locked: false })

    expect((await support.get('/api/console/session/me')).status).toBe(401)
    await expect(consoleLogin(email('support'), CONSOLE_PASSWORD)).rejects.toThrow(/401/)
    const again = await consoleLogin(email('support'), password)
    expect((await again.get('/api/console/session/me')).body.user.id).toBe(team.support.id)

    await expectNotStored(password, team.support.id)
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'console.team.password_reset' } })
    expect(row.userId).toBe(team.admin.id)
    expect(row.data).toEqual({ name: 'support', email: email('support'), sessionsEnded: 1 })
  })

  it('answers 404 for unknown people and never touches a shop PIN', async () => {
    expect((await admin.post('/api/console/team/nobody/reset-password')).status).toBe(404)
    const before = await prisma.account.findFirstOrThrow({ where: { userId: fx.users.owner.id } })
    expect((await admin.post(`/api/console/team/${fx.users.owner.id}/reset-password`)).status).toBe(404)
    const after = await prisma.account.findFirstOrThrow({ where: { userId: fx.users.owner.id } })
    expect(after.password).toBe(before.password)
    expect((await Client.login('owner')).cookie).not.toBe('')
  })
})

describe('scripts/create-platform-admin', () => {
  const passwordIn = (out: string[]) => out.join('\n').match(/assword: (\S+)/)?.[1] ?? ''

  it('creates a super admin by default with a 20 character password printed once', async () => {
    const r = await createPlatformAdmin(['Root@Example.com', 'Root Admin'])
    expect(r.code).toBe(0)
    const password = passwordIn(r.out)
    expect(password).toHaveLength(20)
    expect(r.out.join('\n').split(password)).toHaveLength(2)
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'root@example.com' } })
    expect(user).toMatchObject({ name: 'Root Admin', platformRole: 'SUPER_ADMIN', businessId: null, active: true })
    const c = await consoleLogin('root@example.com', password)
    expect((await c.get('/api/console/session/me')).body.user.role).toBe('SUPER_ADMIN')
    await expectNotStored(password, user.id)
  })

  it('takes a role, and refuses bad input', async () => {
    const ok = await createPlatformAdmin(['bill@example.com', 'Bill Collector', 'billing'])
    expect(ok.code).toBe(0)
    expect((await prisma.user.findUniqueOrThrow({ where: { email: 'bill@example.com' } })).platformRole).toBe('BILLING')

    for (const args of [[], ['nope', 'Some Name'], ['a@example.com'], ['a@example.com', 'Some Name', 'OWNER'], ['a@example.com', 'Some Name', '--force']]) {
      const r = await createPlatformAdmin(args)
      expect(r.code).toBe(1)
      expect(r.err.length).toBeGreaterThan(0)
      expect(r.out).toEqual([])
    }
    expect(await prisma.user.count({ where: { email: 'a@example.com' } })).toBe(0)
  })

  it('leaves an existing user alone unless --reset-password is passed', async () => {
    const first = await createPlatformAdmin(['root@example.com', 'Root Admin'])
    const old = passwordIn(first.out)
    const session = await consoleLogin('root@example.com', old)

    const again = await createPlatformAdmin(['root@example.com', 'Root Admin'])
    expect(again.code).toBe(1)
    expect(again.err.join(' ')).toContain('--reset-password')
    expect((await session.get('/api/console/session/me')).status).toBe(200)

    const reset = await createPlatformAdmin(['root@example.com', '--reset-password'])
    expect(reset.code).toBe(0)
    const fresh = passwordIn(reset.out)
    expect(fresh).toHaveLength(20)
    expect(fresh).not.toBe(old)
    expect((await session.get('/api/console/session/me')).status).toBe(401)
    await expect(consoleLogin('root@example.com', old)).rejects.toThrow(/401/)
    await consoleLogin('root@example.com', fresh)
    expect(await prisma.user.count({ where: { email: 'root@example.com' } })).toBe(1)
  })

  it('never turns a shop account into a console user', async () => {
    for (const args of [[fx.users.owner.email, 'Shop Owner'], [fx.users.owner.email, '--reset-password']]) {
      const r = await createPlatformAdmin(args)
      expect(r.code).toBe(1)
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: fx.users.owner.id } })).platformRole).toBeNull()
    expect((await Client.login('owner')).cookie).not.toBe('')
  })
})
