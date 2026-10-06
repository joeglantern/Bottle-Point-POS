import { beforeEach, describe, expect, it } from 'vitest'
import { Client, consoleLogin, resetDb, seedFixture, seedPlatform, type Fixture, type Res } from './helpers.js'
import { prisma } from '../src/db.js'
import { createStaff } from '../src/lib/users.js'

let fx: Fixture
let o: Client
let m: Client
let seq = 0

beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
  o = await Client.login('owner')
  m = await Client.login('manager')
  seq = 0
})

type Limits = { maxBranches?: number | null; maxStaff?: number | null; maxProducts?: number | null }
type Status = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED'

// Plan and subscription rows written straight to the database: the console
// that normally creates them is not part of this test.
async function subscribe(businessId: string, limits: Limits, status: Status = 'ACTIVE') {
  const plan = await prisma.plan.create({
    data: { code: `plan_${Math.random().toString(36).slice(2)}`, name: 'Starter', model: 'FLAT', priceCents: 250000, ...limits }
  })
  await prisma.subscription.create({
    data: { businessId, planId: plan.id, status, currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) }
  })
  return plan
}

// A second client with one branch and one owner.
async function otherBusiness() {
  const business = await prisma.business.create({ data: { name: 'Other Wines' } })
  const branch = await prisma.branch.create({ data: { businessId: business.id, name: 'Karen' } })
  await createStaff(prisma, { businessId: business.id, name: 'owner2', username: 'owner2', pin: '1234', role: 'OWNER', branchIds: [] })
  return { business, branch }
}

// The three things a plan limits, behind one shape so every rule is checked
// the same way for each of them.
type Kind = {
  what: 'branches' | 'staff' | 'products'
  field: 'maxBranches' | 'maxStaff' | 'maxProducts'
  key: 'branch' | 'user' | 'product'
  label: string
  action: string
  base: number // active rows the fixture starts with
  otherBase: number // active rows otherBusiness() starts with
  create: (c: Client) => Promise<Res>
  off: (id: string) => Promise<Res>
  on: (id: string, c?: Client) => Promise<Res>
  edit: (id: string) => Promise<Res>
  existing: () => string
  active: (businessId: string) => Promise<number>
  seedOther: (ob: { business: { id: string }; branch: { id: string } }, n: number) => Promise<unknown>
}

const kinds: Kind[] = [
  {
    what: 'branches',
    field: 'maxBranches',
    key: 'branch',
    label: 'branches',
    action: 'branch.created',
    base: 2,
    otherBase: 1,
    create: c => c.post('/api/admin/branches', { name: `Branch ${++seq}` }),
    off: id => o.patch(`/api/admin/branches/${id}`, { active: false }),
    on: (id, c = o) => c.patch(`/api/admin/branches/${id}`, { active: true }),
    edit: id => o.patch(`/api/admin/branches/${id}`, { name: 'Renamed' }),
    existing: () => fx.branches.kili.id,
    active: businessId => prisma.branch.count({ where: { businessId, active: true } }),
    seedOther: (ob, n) =>
      prisma.branch.createMany({ data: Array.from({ length: n }, (_, i) => ({ businessId: ob.business.id, name: `Other ${i}` })) })
  },
  {
    what: 'staff',
    field: 'maxStaff',
    key: 'user',
    label: 'staff members',
    action: 'user.created',
    base: 6,
    otherBase: 1,
    create: c => {
      const n = ++seq
      return c.post('/api/admin/users', { name: `Person ${n}`, username: `person${n}`, pin: '5678', role: 'OWNER', branchIds: [] })
    },
    off: id => o.patch(`/api/admin/users/${id}`, { active: false }),
    on: (id, c = o) => c.patch(`/api/admin/users/${id}`, { active: true }),
    edit: id => o.patch(`/api/admin/users/${id}`, { name: 'New Name' }),
    existing: () => fx.users.cashier.id,
    active: businessId => prisma.user.count({ where: { businessId, active: true } }),
    seedOther: async (ob, n) => {
      for (let i = 0; i < n; i++) {
        await createStaff(prisma, { businessId: ob.business.id, name: `o${i}`, username: `other${i}`, pin: '1234', role: 'CASHIER', branchIds: [ob.branch.id] })
      }
    }
  },
  {
    what: 'products',
    field: 'maxProducts',
    key: 'product',
    label: 'products',
    action: 'product.created',
    base: 3,
    otherBase: 0,
    create: c => c.post('/api/products', { name: `Product ${++seq}`, category: 'Beer', priceCents: 10000 }),
    off: id => m.del(`/api/products/${id}`),
    on: (id, c = m) => c.patch(`/api/products/${id}`, { active: true }),
    edit: id => m.patch(`/api/products/${id}`, { priceCents: 12345 }),
    existing: () => fx.products.gin.id,
    active: businessId => prisma.product.count({ where: { businessId, active: true } }),
    seedOther: (ob, n) =>
      prisma.product.createMany({
        data: Array.from({ length: n }, (_, i) => ({ businessId: ob.business.id, name: `Other ${i}`, category: 'Beer', priceCents: 5000 }))
      })
  }
]

// Who adds this kind of thing in the first business.
const maker = (k: Kind) => (k.what === 'products' ? m : o)

describe.each(kinds)('plan limit on $what', k => {
  const used = () => k.active(fx.business.id)

  it('at the limit: refused with 402 plan_limit, the exact body, and nothing written', async () => {
    await subscribe(fx.business.id, { [k.field]: k.base })
    const r = await k.create(maker(k))
    expect(r.status).toBe(402)
    expect(r.body).toEqual({
      error: {
        code: 'plan_limit',
        message: `The Starter plan allows ${k.base} ${k.label} and you have ${k.base}. Upgrade the plan to add more.`,
        details: { what: k.what, used: k.base, max: k.base }
      }
    })
    expect(await used()).toBe(k.base)
    expect(await prisma.auditLog.count({ where: { action: k.action } })).toBe(0)
  })

  it('already over the limit (the plan was lowered): refused, reports the real count', async () => {
    await subscribe(fx.business.id, { [k.field]: k.base - 1 })
    const r = await k.create(maker(k))
    expect(r.status).toBe(402)
    expect(r.body.error.details).toEqual({ what: k.what, used: k.base, max: k.base - 1 })
  })

  it('one under the limit: allowed once, then refused', async () => {
    await subscribe(fx.business.id, { [k.field]: k.base + 1 })
    expect((await k.create(maker(k))).status).toBe(201)
    expect(await used()).toBe(k.base + 1)
    const r = await k.create(maker(k))
    expect(r.status).toBe(402)
    expect(r.body.error.code).toBe('plan_limit')
    expect(r.body.error.details).toEqual({ what: k.what, used: k.base + 1, max: k.base + 1 })
    expect(await used()).toBe(k.base + 1)
  })

  it('inactive ones do not count, and bringing one back does', async () => {
    const plan = await subscribe(fx.business.id, { [k.field]: k.base })
    const id = k.existing()
    // Switching off is never limited and frees a place.
    expect((await k.off(id)).status).toBe(200)
    expect(await used()).toBe(k.base - 1)
    expect((await k.create(maker(k))).status).toBe(201)
    expect(await used()).toBe(k.base)

    // The place is taken now: the old one cannot come back.
    const back = await k.on(id)
    expect(back.status).toBe(402)
    expect(back.body.error.code).toBe('plan_limit')
    expect(back.body.error.details).toEqual({ what: k.what, used: k.base, max: k.base })
    expect(await used()).toBe(k.base)

    // A bigger plan lets it back in.
    await prisma.plan.update({ where: { id: plan.id }, data: { [k.field]: k.base + 1 } })
    const ok = await k.on(id)
    expect(ok.status).toBe(200)
    expect(ok.body[k.key].active).toBe(true)
    expect(await used()).toBe(k.base + 1)
  })

  it('editing something active at the limit still works', async () => {
    await subscribe(fx.business.id, { [k.field]: k.base })
    const id = k.existing()
    expect((await k.edit(id)).status).toBe(200)
    // active: true on a row that is already active adds nothing
    const same = await k.on(id)
    expect(same.status).toBe(200)
    expect(same.body[k.key].active).toBe(true)
    expect((await k.off(id)).status).toBe(200)
    expect(await used()).toBe(k.base - 1)
  })

  it('over the limit: active rows can still be edited and switched off', async () => {
    await subscribe(fx.business.id, { [k.field]: 1 })
    const id = k.existing()
    expect((await k.edit(id)).status).toBe(200)
    expect((await k.on(id)).status).toBe(200)
    expect((await k.off(id)).status).toBe(200)
  })

  it('a null limit means unlimited', async () => {
    await subscribe(fx.business.id, { maxBranches: 1, maxStaff: 1, maxProducts: 1, [k.field]: null })
    expect((await k.create(maker(k))).status).toBe(201)
    expect((await k.create(maker(k))).status).toBe(201)
    expect(await used()).toBe(k.base + 2)
  })

  it('no subscription record means no limits', async () => {
    expect(await prisma.subscription.count()).toBe(0)
    expect((await k.create(maker(k))).status).toBe(201)
    const id = k.existing()
    expect((await k.off(id)).status).toBe(200)
    expect((await k.on(id)).status).toBe(200)
    expect(await used()).toBe(k.base + 1)
  })

  it('the limits of the other two things do not get in the way', async () => {
    await subscribe(fx.business.id, { maxBranches: 0, maxStaff: 0, maxProducts: 0, [k.field]: k.base + 1 })
    expect((await k.create(maker(k))).status).toBe(201)
  })

  it('rows of another business never count, and its limit is its own', async () => {
    const ob = await otherBusiness()
    await k.seedOther(ob, 9)
    const otherUsed = k.otherBase + 9
    expect(await k.active(ob.business.id)).toBe(otherUsed)
    await subscribe(ob.business.id, { [k.field]: otherUsed })
    await subscribe(fx.business.id, { [k.field]: k.base + 1 })

    // The first business has one place left whatever the other one holds.
    expect((await k.create(maker(k))).status).toBe(201)
    const full = await k.create(maker(k))
    expect(full.status).toBe(402)
    expect(full.body.error.details).toEqual({ what: k.what, used: k.base + 1, max: k.base + 1 })

    // The other business is at its own limit and sees only its own numbers.
    const o2 = await Client.login('owner2')
    const r = await k.create(o2)
    expect(r.status).toBe(402)
    expect(r.body.error.details).toEqual({ what: k.what, used: otherUsed, max: otherUsed })
    expect(await k.active(ob.business.id)).toBe(otherUsed)

    // And it cannot bring back a row of the first business: that is a 404.
    const id = k.existing()
    expect((await k.off(id)).status).toBe(200)
    expect((await k.on(id, o2)).status).toBe(404)
    expect(await used()).toBe(k.base)
  })

  it('race: two creates with one place left, exactly one wins', async () => {
    await subscribe(fx.business.id, { [k.field]: k.base + 1 })
    const c = maker(k)
    const rs = await Promise.all([k.create(c), k.create(c)])
    expect(rs.map(r => r.status).sort()).toEqual([201, 402])
    expect(rs.find(r => r.status === 402)!.body.error.code).toBe('plan_limit')
    expect(await used()).toBe(k.base + 1)
    expect(await prisma.auditLog.count({ where: { action: k.action } })).toBe(1)
  })

  it('race: two coming back with one place left, exactly one wins', async () => {
    // No subscription yet, so two extra rows can be made and switched off.
    const a = (await k.create(maker(k))).body[k.key].id as string
    const b = (await k.create(maker(k))).body[k.key].id as string
    expect((await k.off(a)).status).toBe(200)
    expect((await k.off(b)).status).toBe(200)
    await subscribe(fx.business.id, { [k.field]: k.base + 1 })
    const rs = await Promise.all([k.on(a), k.on(b)])
    expect(rs.map(r => r.status).sort()).toEqual([200, 402])
    expect(await used()).toBe(k.base + 1)
  })

  it('race: a create and a comeback with one place left, exactly one wins', async () => {
    const id = k.existing()
    expect((await k.off(id)).status).toBe(200)
    await subscribe(fx.business.id, { [k.field]: k.base })
    const rs = await Promise.all([k.create(maker(k)), k.on(id)])
    expect(rs.map(r => r.status).filter(s => s === 402)).toHaveLength(1)
    expect(rs.map(r => r.status).filter(s => s === 200 || s === 201)).toHaveLength(1)
    expect(await used()).toBe(k.base)
  })

  it('race: the same row brought back twice is not refused for counting itself', async () => {
    const id = k.existing()
    expect((await k.off(id)).status).toBe(200)
    await subscribe(fx.business.id, { [k.field]: k.base })
    const rs = await Promise.all([k.on(id), k.on(id)])
    expect(rs.map(r => r.status)).toEqual([200, 200])
    expect(await used()).toBe(k.base)
  })

  it('the role check comes before the limit', async () => {
    await subscribe(fx.business.id, { [k.field]: k.base })
    const cashier = await Client.login('cashier')
    expect((await k.create(cashier)).status).toBe(403)
    expect((await k.on(k.existing(), cashier)).status).toBe(403)
    if (k.what !== 'products') {
      expect((await k.create(m)).status).toBe(403)
      expect((await k.on(k.existing(), m)).status).toBe(403)
    }
  })

  it('a console session is not a shop session: 401', async () => {
    await seedPlatform()
    const con = await consoleLogin('admin@bottlepoint.test')
    expect((await k.create(con)).status).toBe(401)
    expect((await k.on(k.existing(), con)).status).toBe(401)
    expect(await used()).toBe(k.base)
  })

  it('a suspended business gets the suspension answer, not plan_limit', async () => {
    await subscribe(fx.business.id, { [k.field]: k.base + 5 }, 'SUSPENDED')
    const r = await k.create(maker(k))
    expect(r.status).toBe(402)
    expect(r.body.error.code).toBe('subscription_suspended')
    expect(await used()).toBe(k.base)
  })

  it.each(['TRIALING', 'PAST_DUE'] as const)('the limit also holds while %s', async status => {
    await subscribe(fx.business.id, { [k.field]: k.base }, status)
    const r = await k.create(maker(k))
    expect(r.status).toBe(402)
    expect(r.body.error.code).toBe('plan_limit')
  })
})

describe('plan limits next to the other rules of the same calls', () => {
  it('a duplicate name, username or barcode at the limit is still reported as a duplicate', async () => {
    await subscribe(fx.business.id, { maxBranches: 2, maxStaff: 6, maxProducts: 3 })
    expect((await o.post('/api/admin/branches', { name: 'westlands' })).body.error.code).toBe('duplicate_branch')
    const u = await o.post('/api/admin/users', { name: 'X', username: 'cashier', pin: '5678', role: 'OWNER', branchIds: [] })
    expect(u.body.error.code).toBe('duplicate_username')
    const p = await m.post('/api/products', { name: 'X', category: 'Beer', priceCents: 100, barcode: fx.products.gin.barcode })
    expect(p.body.error.code).toBe('duplicate_barcode')
  })

  it('validation errors at the limit are still 400', async () => {
    await subscribe(fx.business.id, { maxBranches: 2, maxStaff: 6, maxProducts: 3 })
    expect((await o.post('/api/admin/branches', { name: 'x' })).status).toBe(400)
    expect((await o.post('/api/admin/users', { name: 'X', username: 'ok.name', pin: '12', role: 'OWNER' })).status).toBe(400)
    expect((await m.post('/api/products', { name: 'X', category: 'Beer', priceCents: -1 })).status).toBe(400)
  })

  it('a refused branch leaves no stock rows behind, an allowed one gets them', async () => {
    await subscribe(fx.business.id, { maxBranches: 3 })
    const ok = await o.post('/api/admin/branches', { name: 'Thika Road' })
    expect(ok.status).toBe(201)
    expect(await prisma.stock.count({ where: { branchId: ok.body.branch.id } })).toBe(3)
    const before = await prisma.stock.count()
    expect((await o.post('/api/admin/branches', { name: 'Ngong Road' })).status).toBe(402)
    expect(await prisma.stock.count()).toBe(before)
    expect(await prisma.branch.count({ where: { name: 'Ngong Road' } })).toBe(0)
  })

  it('a refused staff member leaves no user behind and cannot sign in', async () => {
    await subscribe(fx.business.id, { maxStaff: 6 })
    const r = await o.post('/api/admin/users', { name: 'Mercy', username: 'mercy', pin: '5678', role: 'CASHIER', branchIds: [fx.branches.west.id] })
    expect(r.status).toBe(402)
    expect(await prisma.user.count({ where: { username: 'mercy' } })).toBe(0)
    await expect(Client.login('mercy', '5678')).rejects.toThrow()
  })

  it('role, branch and last owner rules on active people are untouched by the limit', async () => {
    await subscribe(fx.business.id, { maxStaff: 6 })
    const last = await o.patch(`/api/admin/users/${fx.users.owner.id}`, { active: false })
    expect(last.status).toBe(422)
    const promote = await o.patch(`/api/admin/users/${fx.users.manager.id}`, { role: 'OWNER' })
    expect(promote.status).toBe(200)
    const move = await o.patch(`/api/admin/users/${fx.users.cashier.id}`, { branchIds: [fx.branches.kili.id], active: true })
    expect(move.status).toBe(200)
  })

  it('five creates at once with two places left: two win', async () => {
    await subscribe(fx.business.id, { maxProducts: 5 })
    const rs = await Promise.all(
      Array.from({ length: 5 }, (_, i) => m.post('/api/products', { name: `Burst ${i}`, category: 'Beer', priceCents: 10000 }))
    )
    expect(rs.filter(r => r.status === 201)).toHaveLength(2)
    expect(rs.filter(r => r.status === 402)).toHaveLength(3)
    expect(await prisma.product.count({ where: { businessId: fx.business.id, active: true } })).toBe(5)
  })
})
