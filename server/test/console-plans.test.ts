import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { Client, consoleLogin, resetDb, seedFixture, seedPlatform, type Fixture } from './helpers.js'

let fx: Fixture
let admin: Client
let support: Client
let billing: Client

beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
  await seedPlatform()
  admin = await consoleLogin('admin@bottlepoint.test')
  support = await consoleLogin('support@bottlepoint.test')
  billing = await consoleLogin('billing@bottlepoint.test')
})

const flat = { code: 'starter', name: 'Starter', model: 'FLAT', priceCents: 250000, maxBranches: 1, maxStaff: 5, maxProducts: 300 }

const fieldErrors = (res: { body: any }) => Object.keys(res.body.error.details.fieldErrors)

describe('creating plans', () => {
  it('creates a flat monthly plan with defaults and describes its price', async () => {
    const res = await billing.post('/api/console/plans', flat)
    expect(res.status).toBe(201)
    expect(res.body.plan).toMatchObject({
      code: 'starter',
      name: 'Starter',
      model: 'FLAT',
      interval: 'MONTH',
      priceCents: 250000,
      perBranchCents: 0,
      percentBps: 0,
      minimumCents: 0,
      trialDays: 14,
      maxBranches: 1,
      maxStaff: 5,
      maxProducts: 300,
      active: true,
      public: true,
      sortOrder: 0,
      clients: 0,
      priceText: 'KSh 2,500 a month'
    })
    const row = await prisma.auditLog.findFirst({ where: { action: 'console.plan.created' } })
    expect(row?.entityId).toBe(res.body.plan.id)
    expect(row?.businessId).toBeNull()
    expect(row?.data).toMatchObject({ code: 'starter', name: 'Starter' })
  })

  it('creates each pricing model', async () => {
    const yearly = await admin.post('/api/console/plans', { code: 'annual', name: 'Growth yearly', model: 'FLAT', interval: 'YEAR', priceCents: 3900000 })
    expect(yearly.body.plan.priceText).toBe('KSh 39,000 a year')
    const free = await admin.post('/api/console/plans', { code: 'free', name: 'Free', model: 'FLAT', priceCents: 0 })
    expect(free.status).toBe(201)
    const branch = await admin.post('/api/console/plans', {
      code: 'growth',
      name: 'Growth',
      model: 'PER_BRANCH',
      priceCents: 150000,
      perBranchCents: 150000
    })
    expect(branch.body.plan.priceText).toBe('KSh 1,500 a month plus KSh 1,500 per branch a month')
    const share = await admin.post('/api/console/plans', {
      code: 'payg',
      name: 'Pay as you sell',
      model: 'PERCENT_OF_SALES',
      percentBps: 150,
      minimumCents: 100000
    })
    expect(share.body.plan.priceText).toBe('1.5% of sales, minimum KSh 1,000 a month')
    const once = await admin.post('/api/console/plans', {
      code: 'licence',
      name: 'Lifetime licence',
      model: 'ONE_TIME',
      priceCents: 8500000,
      trialDays: 0,
      public: false
    })
    expect(once.body.plan).toMatchObject({ interval: 'ONCE', public: false, trialDays: 0, priceText: 'KSh 85,000 once' })
  })

  it('validates each model', async () => {
    const post = (extra: object) => admin.post('/api/console/plans', { code: 'x-plan', name: 'X', ...extra })
    let res = await post({ model: 'FLAT', priceCents: 1000, interval: 'ONCE' })
    expect(res.status).toBe(400)
    expect(fieldErrors(res)).toEqual(['interval'])
    res = await post({ model: 'FLAT', priceCents: -1 })
    expect(res.status).toBe(400)
    res = await post({ model: 'FLAT', priceCents: 10.5 })
    expect(res.status).toBe(400)
    res = await post({ model: 'PER_BRANCH', priceCents: 1000 })
    expect(res.status).toBe(400)
    expect(fieldErrors(res)).toEqual(['perBranchCents'])
    res = await post({ model: 'PER_BRANCH', perBranchCents: 1000, interval: 'ONCE' })
    expect(fieldErrors(res)).toEqual(['interval'])
    res = await post({ model: 'PERCENT_OF_SALES' })
    expect(fieldErrors(res)).toEqual(['percentBps'])
    res = await post({ model: 'PERCENT_OF_SALES', percentBps: 5001 })
    expect(fieldErrors(res)).toEqual(['percentBps'])
    res = await post({ model: 'PERCENT_OF_SALES', percentBps: 150, interval: 'YEAR' })
    expect(fieldErrors(res)).toEqual(['interval'])
    res = await post({ model: 'ONE_TIME', priceCents: 1000, interval: 'MONTH' })
    expect(fieldErrors(res)).toEqual(['interval'])
    res = await post({ model: 'WEEKLY', priceCents: 1000 })
    expect(res.status).toBe(400)
    res = await post({ model: 'FLAT', priceCents: 1000, trialDays: -1 })
    expect(res.status).toBe(400)
    res = await post({ model: 'FLAT', priceCents: 1000, maxStaff: 0 })
    expect(res.status).toBe(400)
    res = await post({ model: 'FLAT', priceCents: 1000, name: '' })
    expect(res.status).toBe(400)
    expect(await prisma.plan.count()).toBe(0)
  })

  it('accepts only lowercase letters, digits and dashes in the code, and keeps it unique', async () => {
    for (const code of ['Starter', 'my plan', 'plan_1', '-lead', 'x', 'a--b']) {
      const res = await admin.post('/api/console/plans', { ...flat, code })
      expect(res.status, code).toBe(400)
    }
    expect((await admin.post('/api/console/plans', { ...flat, code: 'starter-2' })).status).toBe(201)
    expect((await admin.post('/api/console/plans', flat)).status).toBe(201)
    const dup = await admin.post('/api/console/plans', { ...flat, name: 'Another' })
    expect(dup.status).toBe(409)
    expect(dup.body.error.code).toBe('duplicate_code')
    expect(await prisma.plan.count()).toBe(2)
  })
})

describe('editing plans', () => {
  it('changes fields, records what changed and never the code', async () => {
    const { plan } = (await admin.post('/api/console/plans', flat)).body
    const res = await billing.patch(`/api/console/plans/${plan.id}`, { name: 'Starter plus', priceCents: 300000, maxStaff: null, description: 'One shop' })
    expect(res.status).toBe(200)
    expect(res.body.plan).toMatchObject({
      code: 'starter',
      name: 'Starter plus',
      priceCents: 300000,
      maxStaff: null,
      maxBranches: 1,
      description: 'One shop',
      priceText: 'KSh 3,000 a month'
    })
    const row = await prisma.auditLog.findFirst({ where: { action: 'console.plan.updated' } })
    expect((row?.data as any).changes.priceCents).toEqual({ from: 250000, to: 300000 })
    expect((row?.data as any).changes.maxBranches).toBeUndefined()

    const code = await admin.patch(`/api/console/plans/${plan.id}`, { code: 'renamed' })
    expect(code.status).toBe(400)
    expect(fieldErrors(code)).toEqual(['code'])
    // sending the same code back (a form that posts every field) is not a change
    expect((await admin.patch(`/api/console/plans/${plan.id}`, { code: 'starter', sortOrder: 3 })).status).toBe(200)
    expect((await prisma.plan.findUnique({ where: { id: plan.id } }))?.code).toBe('starter')
  })

  it('validates the plan as it would be saved', async () => {
    const { plan } = (await admin.post('/api/console/plans', flat)).body
    // switching the model without giving the new model its numbers
    let res = await admin.patch(`/api/console/plans/${plan.id}`, { model: 'PER_BRANCH' })
    expect(res.status).toBe(400)
    expect(fieldErrors(res)).toEqual(['perBranchCents'])
    res = await admin.patch(`/api/console/plans/${plan.id}`, { interval: 'ONCE' })
    expect(res.status).toBe(400)
    res = await admin.patch(`/api/console/plans/${plan.id}`, { priceCents: -5 })
    expect(res.status).toBe(400)
    res = await admin.patch(`/api/console/plans/${plan.id}`, { model: 'PER_BRANCH', perBranchCents: 90000 })
    expect(res.status).toBe(200)
    expect(res.body.plan.model).toBe('PER_BRANCH')
    expect((await admin.patch('/api/console/plans/nope', { name: 'X' })).status).toBe(404)
  })

  it('an edit that changes nothing writes no audit row', async () => {
    const { plan } = (await admin.post('/api/console/plans', flat)).body
    expect((await admin.patch(`/api/console/plans/${plan.id}`, { name: 'Starter', priceCents: 250000 })).status).toBe(200)
    expect(await prisma.auditLog.count({ where: { action: 'console.plan.updated' } })).toBe(0)
  })

  it('a new price leaves issued invoices alone', async () => {
    const { plan } = (await admin.post('/api/console/plans', flat)).body
    const changed = await admin.post(`/api/console/tenants/${fx.business.id}/subscription/plan`, { planId: plan.id, force: true })
    expect(changed.status).toBe(200)
    const before = await prisma.invoice.findFirstOrThrow({ where: { businessId: fx.business.id } })
    expect(before.subtotalCents).toBe(250000)
    await admin.patch(`/api/console/plans/${plan.id}`, { priceCents: 990000 })
    const after = await prisma.invoice.findFirstOrThrow({ where: { id: before.id } })
    expect(after).toEqual(before)
    // the estimate for the next invoice uses the new price
    const list = await admin.get('/api/console/subscriptions')
    expect(list.body.subscriptions[0].nextAmountCents).toBe(990000 + Math.round((990000 * 1600) / 10000))
  })
})

describe('archiving plans', () => {
  it('archives and unarchives, hides archived plans by default and keeps existing clients', async () => {
    const { plan } = (await admin.post('/api/console/plans', flat)).body
    const { plan: other } = (await admin.post('/api/console/plans', { ...flat, code: 'other', name: 'Other', sortOrder: 5 })).body
    await admin.post(`/api/console/tenants/${fx.business.id}/subscription/plan`, { planId: plan.id, force: true })

    const archived = await billing.post(`/api/console/plans/${plan.id}/archive`)
    expect(archived.status).toBe(200)
    expect(archived.body.plan).toMatchObject({ active: false, clients: 1 })
    // again is harmless and not logged twice
    expect((await billing.post(`/api/console/plans/${plan.id}/archive`)).status).toBe(200)
    expect(await prisma.auditLog.count({ where: { action: 'console.plan.archived' } })).toBe(1)

    let list = await support.get('/api/console/plans')
    expect(list.body.plans.map((p: any) => p.code)).toEqual(['other'])
    list = await support.get('/api/console/plans?includeArchived=true')
    expect(list.body.plans.map((p: any) => [p.code, p.active, p.clients])).toEqual([
      ['starter', false, 1],
      ['other', true, 0]
    ])
    expect((await admin.get('/api/console/plans?includeArchived=maybe')).status).toBe(400)

    // the client on it keeps it
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { businessId: fx.business.id } })
    expect(sub.planId).toBe(plan.id)
    expect(sub.status).toBe('ACTIVE')

    // but it cannot be handed out any more
    await admin.post(`/api/console/tenants/${fx.business.id}/subscription/plan`, { planId: other.id, force: true })
    const back = await admin.post(`/api/console/tenants/${fx.business.id}/subscription/plan`, { planId: plan.id, force: true })
    expect(back.status).toBe(422)
    expect(back.body.error.code).toBe('plan_archived')

    const un = await billing.post(`/api/console/plans/${plan.id}/unarchive`)
    expect(un.body.plan.active).toBe(true)
    expect(await prisma.auditLog.count({ where: { action: 'console.plan.unarchived' } })).toBe(1)
    expect((await admin.post('/api/console/plans/nope/archive')).status).toBe(404)
  })

  it('a plan cannot be deleted', async () => {
    const { plan } = (await admin.post('/api/console/plans', flat)).body
    const res = await admin.del(`/api/console/plans/${plan.id}`)
    // no such route: the request falls through to the shop API, which does not know console users
    expect([401, 404, 405]).toContain(res.status)
    expect(await prisma.plan.count()).toBe(1)
  })

  it('reads one plan', async () => {
    const { plan } = (await admin.post('/api/console/plans', flat)).body
    const res = await support.get(`/api/console/plans/${plan.id}`)
    expect(res.body.plan).toMatchObject({ id: plan.id, code: 'starter', clients: 0 })
    expect((await support.get('/api/console/plans/nope')).status).toBe(404)
  })
})

describe('who may manage plans', () => {
  it('support reads but cannot create, edit or archive', async () => {
    const { plan } = (await admin.post('/api/console/plans', flat)).body
    expect((await support.get('/api/console/plans')).status).toBe(200)
    expect((await support.post('/api/console/plans', { ...flat, code: 'two' })).status).toBe(403)
    expect((await support.patch(`/api/console/plans/${plan.id}`, { priceCents: 1 })).status).toBe(403)
    expect((await support.post(`/api/console/plans/${plan.id}/archive`)).status).toBe(403)
    expect((await support.post(`/api/console/plans/${plan.id}/unarchive`)).status).toBe(403)
    const row = await prisma.plan.findUniqueOrThrow({ where: { id: plan.id } })
    expect(row).toMatchObject({ priceCents: 250000, active: true })
    expect(await prisma.plan.count()).toBe(1)
  })

  it('a shop owner session and no session get 401', async () => {
    const { plan } = (await admin.post('/api/console/plans', flat)).body
    const owner = await Client.login('owner')
    const nobody = new Client()
    for (const who of [owner, nobody]) {
      expect((await who.get('/api/console/plans')).status).toBe(401)
      expect((await who.get(`/api/console/plans/${plan.id}`)).status).toBe(401)
      expect((await who.post('/api/console/plans', { ...flat, code: 'two' })).status).toBe(401)
      expect((await who.patch(`/api/console/plans/${plan.id}`, { priceCents: 1 })).status).toBe(401)
      expect((await who.post(`/api/console/plans/${plan.id}/archive`)).status).toBe(401)
    }
    expect((await prisma.plan.findUniqueOrThrow({ where: { id: plan.id } })).priceCents).toBe(250000)
  })
})
