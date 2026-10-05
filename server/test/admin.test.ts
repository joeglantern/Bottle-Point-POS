import { beforeEach, describe, expect, it } from 'vitest'
import { Client, resetDb, seedFixture, type Fixture } from './helpers.js'
import { prisma } from '../src/db.js'

let fx: Fixture

beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
})

const newUser = (over: Record<string, unknown> = {}) => ({
  name: 'Mercy A.',
  username: 'mercy',
  pin: '5678',
  role: 'CASHIER',
  branchIds: [fx.branches.kili.id],
  ...over
})

describe('branches', () => {
  it('owner lists, creates and renames branches', async () => {
    const o = await Client.login('owner')
    expect((await o.get('/api/admin/branches')).body.branches.map((b: any) => b.name)).toEqual(['Kilimani', 'Westlands'])
    const r = await o.post('/api/admin/branches', { name: 'Thika Road' })
    expect(r.status).toBe(201)
    const stock = await prisma.stock.findMany({ where: { branchId: r.body.branch.id } })
    expect(stock).toHaveLength(3)
    expect(stock.every(s => s.qty === 0)).toBe(true)
    const dup = await o.post('/api/admin/branches', { name: 'thika road' })
    expect(dup.status).toBe(409)
    expect(dup.body.error.code).toBe('duplicate_branch')
    const p = await o.patch(`/api/admin/branches/${r.body.branch.id}`, { name: 'Thika Rd' })
    expect(p.body.branch.name).toBe('Thika Rd')
    expect((await o.patch(`/api/admin/branches/${r.body.branch.id}`, { name: 'Kilimani' })).status).toBe(409)
    expect(await prisma.auditLog.count({ where: { action: { startsWith: 'branch.' } } })).toBe(2)
  })

  it('a deactivated branch drops out of the owner branches', async () => {
    const o = await Client.login('owner')
    await o.patch(`/api/admin/branches/${fx.branches.kili.id}`, { active: false })
    const me = await o.get('/api/session/me')
    expect(me.body.branches.map((b: any) => b.name)).toEqual(['Westlands'])
    const last = await o.patch(`/api/admin/branches/${fx.branches.west.id}`, { active: false })
    expect(last.status).toBe(422)
  })

  it('only the owner manages branches', async () => {
    const m = await Client.login('manager')
    expect((await m.get('/api/admin/branches')).status).toBe(403)
    expect((await m.post('/api/admin/branches', { name: 'X' })).status).toBe(403)
    expect((await m.patch(`/api/admin/branches/${fx.branches.west.id}`, { name: 'X' })).status).toBe(403)
  })
})

describe('users', () => {
  it('owner creates a user who can then sign in, with no secrets in the response', async () => {
    const o = await Client.login('owner')
    const r = await o.post('/api/admin/users', newUser())
    expect(r.status).toBe(201)
    expect(r.body.user).toMatchObject({ username: 'mercy', role: 'CASHIER', active: true, branchIds: [fx.branches.kili.id] })
    const text = JSON.stringify(r.body)
    expect(text).not.toContain('password')
    expect(text).not.toContain('account')
    const c = await Client.login('mercy', '5678')
    const me = await c.get('/api/session/me')
    expect(me.body.branches.map((b: any) => b.name)).toEqual(['Kilimani'])
    expect(await prisma.auditLog.count({ where: { action: 'user.created' } })).toBe(1)
  })

  it('validates new users', async () => {
    const o = await Client.login('owner')
    const bad = [
      newUser({ username: 'ab' }),
      newUser({ username: 'Mercy' }),
      newUser({ username: 'mer cy' }),
      newUser({ username: 'm'.repeat(33) }),
      newUser({ pin: '123' }),
      newUser({ pin: '1234567' }),
      newUser({ pin: 'abcd' }),
      newUser({ role: 'ADMIN' }),
      newUser({ branchIds: [] }),
      newUser({ name: '' })
    ]
    for (const b of bad) expect((await o.post('/api/admin/users', b)).status, JSON.stringify(b)).toBe(400)
    // owners do not need a branch
    expect((await o.post('/api/admin/users', newUser({ role: 'OWNER', branchIds: [] }))).status).toBe(201)
  })

  it('branches must belong to the business', async () => {
    const other = await prisma.business.create({ data: { name: 'Other' } })
    const ob = await prisma.branch.create({ data: { businessId: other.id, name: 'Elsewhere' } })
    const o = await Client.login('owner')
    expect((await o.post('/api/admin/users', newUser({ branchIds: [ob.id] }))).status).toBe(400)
  })

  it('usernames are unique', async () => {
    const o = await Client.login('owner')
    const r = await o.post('/api/admin/users', newUser({ username: 'cashier' }))
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('duplicate_username')
    const res = await Promise.all([o.post('/api/admin/users', newUser()), o.post('/api/admin/users', newUser())])
    expect(res.map(x => x.status).sort()).toEqual([201, 409])
  })

  it('owner sees everyone, manager sees only their branch and cannot change anything', async () => {
    const o = await Client.login('owner')
    expect((await o.get('/api/admin/users')).body.users).toHaveLength(6)
    const m = await Client.login('manager')
    const r = await m.get('/api/admin/users')
    expect(r.status).toBe(200)
    expect(r.body.users.map((u: any) => u.username).sort()).toEqual(['cashier', 'cashier2', 'manager'])
    expect((await m.post('/api/admin/users', newUser())).status).toBe(403)
    expect((await m.patch(`/api/admin/users/${fx.users.cashier.id}`, { active: false })).status).toBe(403)
    expect((await m.post(`/api/admin/users/${fx.users.cashier.id}/pin`, { pin: '9999' })).status).toBe(403)
    const c = await Client.login('cashier')
    expect((await c.get('/api/admin/users')).status).toBe(403)
  })

  it('PIN reset ends old sessions, clears lockout and the new PIN works', async () => {
    const old = await Client.login('cashier')
    await prisma.user.update({ where: { id: fx.users.cashier.id }, data: { failedPins: 3, lockedUntil: new Date(Date.now() + 60_000) } })
    const o = await Client.login('owner')
    const r = await o.post(`/api/admin/users/${fx.users.cashier.id}/pin`, { pin: '9876' })
    expect(r.status).toBe(200)
    expect(r.body.user.locked).toBe(false)
    expect((await old.get('/api/session/me')).status).toBe(401)
    await expect(Client.login('cashier', '1234')).rejects.toThrow()
    const fresh = await Client.login('cashier', '9876')
    expect((await fresh.get('/api/session/me')).status).toBe(200)
    expect((await o.post(`/api/admin/users/${fx.users.cashier.id}/pin`, { pin: '12' })).status).toBe(400)
    expect(await prisma.auditLog.count({ where: { action: 'user.pin_reset' } })).toBe(1)
  })

  it('deactivating a user kills the session and blocks sign in', async () => {
    const s = await Client.login('cashier')
    const o = await Client.login('owner')
    const r = await o.patch(`/api/admin/users/${fx.users.cashier.id}`, { active: false })
    expect(r.status).toBe(200)
    expect(await prisma.session.count({ where: { userId: fx.users.cashier.id } })).toBe(0)
    expect((await s.get('/api/session/me')).status).toBe(401)
    await expect(Client.login('cashier')).rejects.toThrow('403')
  })

  it('moving a user to another branch takes effect at once', async () => {
    const s = await Client.login('cashier')
    const o = await Client.login('owner')
    const r = await o.patch(`/api/admin/users/${fx.users.cashier.id}`, { branchIds: [fx.branches.kili.id], name: 'Cash Ier' })
    expect(r.body.user).toMatchObject({ name: 'Cash Ier', branchIds: [fx.branches.kili.id] })
    expect((await s.get('/api/session/me')).status).toBe(401)
    const again = await Client.login('cashier')
    expect((await again.get('/api/session/me')).body.branches.map((b: any) => b.name)).toEqual(['Kilimani'])
  })

  it('a name change alone keeps the session', async () => {
    const s = await Client.login('cashier')
    const o = await Client.login('owner')
    await o.patch(`/api/admin/users/${fx.users.cashier.id}`, { name: 'New Name' })
    expect((await s.get('/api/session/me')).status).toBe(200)
  })

  it('promoting a manager ends their session, demoting to cashier needs a branch', async () => {
    const s = await Client.login('manager')
    const o = await Client.login('owner')
    expect((await o.patch(`/api/admin/users/${fx.users.manager.id}`, { role: 'CASHIER' })).body.user.role).toBe('CASHIER')
    expect((await s.get('/api/session/me')).status).toBe(401)
    expect((await o.patch(`/api/admin/users/${fx.users.manager.id}`, { branchIds: [] })).status).toBe(400)
  })

  it('protects the last owner and stops owners demoting themselves', async () => {
    const o = await Client.login('owner')
    const r = await o.patch(`/api/admin/users/${fx.users.owner.id}`, { role: 'MANAGER', branchIds: [fx.branches.west.id] })
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('last_owner')
    expect((await o.patch(`/api/admin/users/${fx.users.owner.id}`, { active: false })).status).toBe(422)

    // with a second owner the rule is about yourself
    const second = (await o.post('/api/admin/users', newUser({ username: 'owner2', role: 'OWNER', branchIds: [] }))).body.user
    const self = await o.patch(`/api/admin/users/${fx.users.owner.id}`, { active: false })
    expect(self.status).toBe(422)
    expect(self.body.error.code).toBe('cannot_change_self')
    // removing the other owner is fine, and then the last one is protected
    expect((await o.patch(`/api/admin/users/${second.id}`, { active: false })).status).toBe(200)
    const o2 = await Client.login('owner')
    expect((await o2.patch(`/api/admin/users/${fx.users.owner.id}`, { role: 'CASHIER', branchIds: [fx.branches.west.id] })).status).toBe(422)
    expect(await prisma.user.count({ where: { role: 'OWNER', active: true } })).toBe(1)
  })

  it('two owners removing each other at the same moment: one owner is always left', async () => {
    const o = await Client.login('owner')
    const second = (await o.post('/api/admin/users', newUser({ username: 'owner2', role: 'OWNER', branchIds: [] }))).body.user
    const o2 = await Client.login('owner2', '5678')
    const res = await Promise.all([
      o.patch(`/api/admin/users/${second.id}`, { active: false }),
      o2.patch(`/api/admin/users/${fx.users.owner.id}`, { active: false })
    ])
    expect(res.filter(r => r.status === 200).length).toBeLessThanOrEqual(1)
    expect(await prisma.user.count({ where: { role: 'OWNER', active: true } })).toBe(1)
  })

  it('cannot touch users of another business', async () => {
    const other = await prisma.business.create({ data: { name: 'Other' } })
    const u = await prisma.user.create({ data: { id: 'x1', name: 'x', email: 'x@x.x', businessId: other.id } })
    const o = await Client.login('owner')
    expect((await o.patch(`/api/admin/users/${u.id}`, { active: false })).status).toBe(404)
    expect((await o.post(`/api/admin/users/${u.id}/pin`, { pin: '1111' })).status).toBe(404)
  })
})
