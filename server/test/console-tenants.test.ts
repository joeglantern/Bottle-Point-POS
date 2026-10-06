import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { env } from '../src/env.js'
import { createPlatformUser } from '../src/lib/users.js'
import { priceFor } from '../src/rules/pricing.js'
import { createInvoice, DAY_MS } from '../src/rules/platform.js'
import { Client, CONSOLE_PASSWORD, consoleLogin, resetDb, seedFixture, seedPlatform, type Fixture } from './helpers.js'

let fx: Fixture
let admin: Client
let support: Client
let billing: Client
let starter: { id: string }
let payg: { id: string }
let growth: { id: string }

const STARTER_CENTS = 250_000

beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
  await seedPlatform()
  admin = await consoleLogin('admin@bottlepoint.test')
  support = await consoleLogin('support@bottlepoint.test')
  billing = await consoleLogin('billing@bottlepoint.test')
  starter = await prisma.plan.create({
    data: { code: 'starter', name: 'Starter', model: 'FLAT', interval: 'MONTH', priceCents: STARTER_CENTS, trialDays: 14, maxBranches: 1, maxStaff: 5, maxProducts: 300 }
  })
  growth = await prisma.plan.create({
    data: { code: 'growth', name: 'Growth', model: 'PER_BRANCH', interval: 'MONTH', priceCents: 150_000, perBranchCents: 150_000, trialDays: 14 }
  })
  payg = await prisma.plan.create({
    data: { code: 'payg', name: 'Pay as you sell', model: 'PERCENT_OF_SALES', interval: 'MONTH', percentBps: 150, minimumCents: 100_000, trialDays: 14 }
  })
})

const onboard = (over: Record<string, unknown> = {}, as: Client = support) =>
  as.post('/api/console/tenants', {
    businessName: 'Mama Njeri Wines',
    branchName: 'Ngong Road',
    ownerName: 'Njeri Kamau',
    ownerUsername: 'njeri',
    planId: starter.id,
    ...over
  })

// Gives the fixture business a subscription directly, in a chosen state.
const subscribe = (data: Record<string, unknown> = {}, businessId = fx.business.id) =>
  prisma.subscription.create({
    data: {
      businessId,
      planId: starter.id,
      status: 'ACTIVE',
      currentPeriodStart: new Date(Date.now() - 5 * DAY_MS),
      currentPeriodEnd: new Date(Date.now() + 25 * DAY_MS),
      ...data
    } as never
  })

const paidSale = (branchId: string, number: number, totalCents: number, paidAt = new Date()) =>
  prisma.sale.create({
    data: { branchId, number, createdById: fx.users.cashier.id, paidById: fx.users.cashier.id, status: 'PAID', subtotalCents: totalCents, totalCents, paidAt }
  })

const overdueInvoice = (businessId: string, daysAgo = 30) =>
  prisma.$transaction(tx =>
    createInvoice(tx, {
      businessId,
      periodStart: new Date(Date.now() - daysAgo * DAY_MS),
      periodEnd: new Date(Date.now() - (daysAgo - 30) * DAY_MS),
      priced: priceFor({ name: 'Starter', model: 'FLAT', interval: 'MONTH', priceCents: STARTER_CENTS, perBranchCents: 0, percentBps: 0, minimumCents: 0 }, { discountBps: 0, customPriceCents: null }, { branches: 1, salesCents: 0 }, env.PLATFORM_VAT_BPS),
      issuedAt: new Date(Date.now() - daysAgo * DAY_MS)
    })
  )

describe('console tenants: who may call', () => {
  it('answers 401 without a session and to a shop session', async () => {
    const anon = new Client()
    const owner = await Client.login('owner')
    const id = fx.business.id
    const calls: [string, string][] = [
      ['GET', '/api/console/tenants'],
      ['POST', '/api/console/tenants'],
      ['GET', `/api/console/tenants/${id}`],
      ['PATCH', `/api/console/tenants/${id}`],
      ['POST', `/api/console/tenants/${id}/suspend`],
      ['POST', `/api/console/tenants/${id}/reactivate`],
      ['GET', `/api/console/tenants/${id}/people`],
      ['POST', `/api/console/tenants/${id}/people/${fx.users.owner.id}/reset-pin`],
      ['POST', `/api/console/tenants/${id}/sign-out-all`],
      ['GET', `/api/console/tenants/${id}/notes`],
      ['POST', `/api/console/tenants/${id}/notes`],
      ['DELETE', `/api/console/tenants/${id}/notes/x`],
      ['GET', `/api/console/tenants/${id}/activity`]
    ]
    for (const [method, path] of calls) {
      const json = method === 'GET' || method === 'DELETE' ? undefined : {}
      expect((await anon.req(method, path, json)).status, `anon ${method} ${path}`).toBe(401)
      expect((await owner.req(method, path, json)).status, `shop ${method} ${path}`).toBe(401)
    }
    // the shop session itself is still good
    expect((await owner.get('/api/products')).status).toBe(200)
  })

  it('lets BILLING read everything and change nothing here', async () => {
    const id = fx.business.id
    await subscribe()
    const note = await support.post(`/api/console/tenants/${id}/notes`, { body: 'Called the owner' })
    for (const path of ['', `/${id}`, `/${id}/people`, `/${id}/notes`, `/${id}/activity`]) {
      expect((await billing.get(`/api/console/tenants${path}`)).status, path).toBe(200)
    }
    const writes: [string, string, unknown][] = [
      ['POST', '', { businessName: 'Kwa Otieno Liquor', branchName: 'Main', ownerName: 'Otieno', ownerUsername: 'otieno', planId: starter.id }],
      ['PATCH', `/${id}`, { name: 'Renamed' }],
      ['POST', `/${id}/suspend`, { reason: 'Testing' }],
      ['POST', `/${id}/reactivate`, {}],
      ['POST', `/${id}/people/${fx.users.owner.id}/reset-pin`, {}],
      ['POST', `/${id}/sign-out-all`, {}],
      ['POST', `/${id}/notes`, { body: 'hello' }],
      ['DELETE', `/${id}/notes/${note.body.note.id}`, undefined]
    ]
    for (const [method, path, json] of writes) {
      const res = await billing.req(method, `/api/console/tenants${path}`, json)
      expect(res.status, `${method} ${path}`).toBe(403)
      expect(res.body.error.code).toBe('forbidden')
    }
    expect(await prisma.business.count()).toBe(1)
    expect((await prisma.subscription.findUniqueOrThrow({ where: { businessId: id } })).status).toBe('ACTIVE')
  })
})

describe('console tenants: onboarding', () => {
  it('creates the business, branch, owner and trial, and the owner can use the POS with the PIN shown once', async () => {
    const res = await onboard({ email: 'Njeri@Example.com', phone: '0712 345 678' })
    expect(res.status).toBe(201)
    const { tenant, branch, owner, subscription, invoice, ownerPin } = res.body
    expect(tenant).toMatchObject({ name: 'Mama Njeri Wines', email: 'njeri@example.com', phone: '254712345678' })
    expect(branch.name).toBe('Ngong Road')
    expect(owner).toMatchObject({ name: 'Njeri Kamau', username: 'njeri' })
    expect(ownerPin).toMatch(/^\d{6}$/)
    expect(invoice).toBeNull()
    expect(subscription.status).toBe('TRIALING')
    expect(subscription.plan).toMatchObject({ id: starter.id, code: 'starter', priceText: 'KSh 2,500 a month' })
    const trialMs = new Date(subscription.trialEndsAt).getTime() - Date.now()
    expect(Math.abs(trialMs - 14 * DAY_MS)).toBeLessThan(60_000)
    expect(subscription.currentPeriodEnd).toBe(subscription.trialEndsAt)

    const user = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })
    expect(user).toMatchObject({ role: 'OWNER', businessId: tenant.id, platformRole: null })

    // the shop works for the new owner, and only shows its own data
    const pos = await Client.login('njeri', ownerPin, branch.id)
    const products = await pos.get('/api/products')
    expect(products.status).toBe(200)
    expect(JSON.stringify(products.body)).not.toContain('Johnnie Walker')
    expect((await pos.get('/api/console/tenants')).status).toBe(401)

    // the PIN is nowhere in plain: not in the account, not in the audit trail
    const account = await prisma.account.findFirstOrThrow({ where: { userId: owner.id } })
    expect(account.password).not.toContain(ownerPin)
    const audits = await prisma.auditLog.findMany({ where: { businessId: tenant.id } })
    const created = audits.find(a => a.action === 'console.tenant.created')!
    expect(created.data).toMatchObject({ businessName: 'Mama Njeri Wines', ownerUsername: 'njeri', plan: 'starter', trialDays: 14, pinGenerated: true })
    expect(JSON.stringify(audits.map(a => [a.entityId, a.data]))).not.toContain(ownerPin)
  })

  it('uses the PIN it is given and does not echo it', async () => {
    const res = await onboard({ ownerPin: '482915', trialDays: 30 })
    expect(res.status).toBe(201)
    expect(res.body.ownerPin).toBeNull()
    const trialMs = new Date(res.body.subscription.trialEndsAt).getTime() - Date.now()
    expect(Math.abs(trialMs - 30 * DAY_MS)).toBeLessThan(60_000)
    await Client.login('njeri', '482915', res.body.branch.id)
    expect(JSON.stringify((await prisma.auditLog.findMany()).map(a => [a.entityId, a.data]))).not.toContain('482915')
  })

  it('with no trial starts ACTIVE and bills the first period at once on in advance plans', async () => {
    const res = await onboard({ trialDays: 0 }, admin)
    expect(res.status).toBe(201)
    expect(res.body.subscription).toMatchObject({ status: 'ACTIVE', trialEndsAt: null })
    const priced = priceFor(await prisma.plan.findUniqueOrThrow({ where: { id: starter.id } }), { discountBps: 0, customPriceCents: null }, { branches: 1, salesCents: 0 }, env.PLATFORM_VAT_BPS)
    expect(priced.totalCents).toBe(290_000)
    expect(res.body.invoice).toMatchObject({ totalCents: 290_000, status: 'OPEN' })
    expect(res.body.invoice.number).toMatch(/^INV-\d{4}-000001$/)
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: res.body.invoice.id } })
    expect(inv).toMatchObject({ businessId: res.body.tenant.id, subscriptionId: res.body.subscription.id, subtotalCents: 250_000, taxCents: 40_000 })
    expect(inv.periodStart.toISOString()).toBe(res.body.subscription.currentPeriodStart)
    expect(inv.periodEnd.toISOString()).toBe(res.body.subscription.currentPeriodEnd)
  })

  it('counts the first branch on a per branch plan and bills share of sales plans later', async () => {
    const perBranch = await onboard({ planId: growth.id, trialDays: 0 })
    expect(perBranch.body.invoice.totalCents).toBe(Math.round(300_000 * (1 + env.PLATFORM_VAT_BPS / 10000)))
    const arrears = await onboard({ planId: payg.id, trialDays: 0, ownerUsername: 'wanjiru', businessName: 'Wanjiru Spirits' })
    expect(arrears.status).toBe(201)
    expect(arrears.body.subscription.status).toBe('ACTIVE')
    expect(arrears.body.invoice).toBeNull()
  })

  it('rolls back completely when the username is taken', async () => {
    const before = [await prisma.business.count(), await prisma.branch.count(), await prisma.user.count(), await prisma.subscription.count(), await prisma.auditLog.count()]
    for (const ownerUsername of ['owner', 'OWNER']) {
      const res = await onboard({ ownerUsername, trialDays: 0 })
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('duplicate_username')
    }
    const after = [await prisma.business.count(), await prisma.branch.count(), await prisma.user.count(), await prisma.subscription.count(), await prisma.auditLog.count()]
    expect(after).toEqual(before)
    expect(await prisma.invoice.count()).toBe(0)
    expect(await prisma.invoiceCounter.count()).toBe(0)
  })

  it('two requests for the same username: exactly one client is created', async () => {
    const [a, b] = await Promise.all([onboard(), onboard({ businessName: 'Second Shop' }, admin)])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    expect(await prisma.business.count()).toBe(2)
    expect(await prisma.subscription.count()).toBe(1)
  })

  it('validates the request', async () => {
    const bad: Record<string, unknown>[] = [
      { businessName: '' },
      { branchName: '' },
      { ownerName: '' },
      { ownerUsername: 'a b' },
      { ownerUsername: 'x' },
      { ownerPin: '12' },
      { ownerPin: 'abcdef' },
      { trialDays: 91 },
      { trialDays: -1 },
      { trialDays: 1.5 },
      { email: 'not an email' },
      { phone: '12345' },
      { planId: undefined }
    ]
    for (const over of bad) {
      const res = await onboard(over)
      expect(res.status, JSON.stringify(over)).toBe(400)
    }
    expect((await onboard({ planId: 'nope' })).status).toBe(404)
    await prisma.plan.update({ where: { id: starter.id }, data: { active: false } })
    const archived = await onboard()
    expect(archived.status).toBe(422)
    expect(archived.body.error.code).toBe('plan_archived')
    expect(await prisma.business.count()).toBe(1)
  })
})

describe('console tenants: list and client page', () => {
  it('lists clients with figures, counts, filters, sorting and paging', async () => {
    // Test Wines: ACTIVE on growth with two branches and sales
    await subscribe({ planId: growth.id, discountBps: 1000 })
    await paidSale(fx.branches.west.id, 1, 1_000_000)
    await paidSale(fx.branches.kili.id, 1, 500_000)
    await paidSale(fx.branches.kili.id, 2, 900_000, new Date(Date.now() - 40 * DAY_MS))
    const njeri = (await onboard()).body
    const otieno = (await onboard({ businessName: 'Kwa Otieno Liquor', ownerUsername: 'otieno', trialDays: 0 })).body
    const bare = await prisma.business.create({ data: { name: 'Bare Bottles' } })

    const all = await billing.get('/api/console/tenants')
    expect(all.status).toBe(200)
    expect(all.body.total).toBe(4)
    expect(all.body.counts).toEqual({ ALL: 4, TRIALING: 1, ACTIVE: 2, PAST_DUE: 0, SUSPENDED: 0, CANCELLED: 0, NONE: 1 })
    expect(all.body.tenants.map((t: any) => t.name)).toEqual(['Bare Bottles', 'Kwa Otieno Liquor', 'Mama Njeri Wines', 'Test Wines'])
    const row = (name: string) => all.body.tenants.find((t: any) => t.name === name)
    // (1,500 base + 2 x 1,500) less 10%
    expect(row('Test Wines')).toMatchObject({ status: 'ACTIVE', plan: { id: growth.id, name: 'Growth' }, branches: 2, staff: 6, sales30dCents: 1_500_000, mrrCents: 405_000 })
    expect(row('Kwa Otieno Liquor')).toMatchObject({ status: 'ACTIVE', branches: 1, staff: 1, sales30dCents: 0, mrrCents: 250_000, trialEndsAt: null })
    expect(row('Mama Njeri Wines')).toMatchObject({ id: njeri.tenant.id, status: 'TRIALING', mrrCents: 0 })
    expect(row('Mama Njeri Wines').trialEndsAt).toBe(njeri.subscription.trialEndsAt)
    expect(row('Bare Bottles')).toMatchObject({ id: bare.id, status: 'NONE', plan: null, branches: 0, staff: 0, mrrCents: 0 })

    const names = async (qs: string) => (await support.get(`/api/console/tenants?${qs}`)).body.tenants.map((t: any) => t.name)
    expect((await names('sort=mrr')).slice(0, 2)).toEqual(['Test Wines', 'Kwa Otieno Liquor'])
    expect((await names('sort=mrr&dir=asc')).slice(-2)).toEqual(['Kwa Otieno Liquor', 'Test Wines'])
    expect((await names('sort=sales'))[0]).toBe('Test Wines')
    expect(await names('sort=name&dir=desc')).toEqual(['Test Wines', 'Mama Njeri Wines', 'Kwa Otieno Liquor', 'Bare Bottles'])
    expect((await names('sort=joined'))[0]).toBe('Bare Bottles')
    expect((await names('sort=joined&dir=asc'))[0]).toBe('Test Wines')

    const active = await support.get('/api/console/tenants?status=ACTIVE')
    expect(active.body.total).toBe(2)
    expect(active.body.counts.ALL).toBe(4)
    expect((await support.get('/api/console/tenants?status=NONE')).body.tenants.map((t: any) => t.name)).toEqual(['Bare Bottles'])

    expect(await names('q=njeri')).toEqual(['Mama Njeri Wines'])
    expect(await names('q=OTIENO')).toEqual(['Kwa Otieno Liquor'])
    expect(await names(`q=${otieno.tenant.id}`)).toEqual(['Kwa Otieno Liquor'])
    // an owner username that is not in the shop name
    expect(await names('q=owner')).toEqual(['Test Wines'])
    expect(await names('q=%25')).toEqual([])
    const byPlan = await support.get(`/api/console/tenants?planId=${starter.id}`)
    expect(byPlan.body.total).toBe(2)
    expect(byPlan.body.counts).toMatchObject({ ALL: 2, TRIALING: 1, ACTIVE: 1, NONE: 0 })

    const page = await support.get('/api/console/tenants?limit=2&offset=2')
    expect(page.body.total).toBe(4)
    expect(page.body.tenants.map((t: any) => t.name)).toEqual(['Mama Njeri Wines', 'Test Wines'])

    for (const qs of ['status=OPEN', 'sort=price', 'dir=up', 'limit=0', 'limit=201', 'offset=-1']) {
      expect((await support.get(`/api/console/tenants?${qs}`)).status, qs).toBe(400)
    }
  })

  it('prices a share of sales client from its last 30 days of sales', async () => {
    await subscribe({ planId: payg.id })
    await paidSale(fx.branches.west.id, 1, 20_000_000)
    const res = await admin.get('/api/console/tenants?sort=sales')
    // 1.5% of KSh 200,000
    expect(res.body.tenants[0]).toMatchObject({ name: 'Test Wines', sales30dCents: 20_000_000, mrrCents: 300_000 })
    const detail = await admin.get(`/api/console/tenants/${fx.business.id}`)
    expect(detail.body.tenant).toMatchObject({ sales30dCents: 20_000_000, mrrCents: 300_000 })
  })

  it('shows everything the client page needs', async () => {
    const sub = await subscribe()
    await paidSale(fx.branches.west.id, 1, 480_000)
    await overdueInvoice(fx.business.id, 10)
    const owner = await Client.login('owner')
    const res = await billing.get(`/api/console/tenants/${fx.business.id}`)
    expect(res.status).toBe(200)
    const t = res.body.tenant
    expect(t).toMatchObject({
      id: fx.business.id,
      name: 'Test Wines',
      legalName: null,
      status: 'ACTIVE',
      usage: { branches: 2, staff: 6, products: 3 },
      limits: { maxBranches: 1, maxStaff: 5, maxProducts: 300 },
      sales30dCents: 480_000,
      mrrCents: 250_000,
      openInvoiceCents: 290_000,
      openInvoiceCount: 1,
      overdueInvoiceCount: 1
    })
    expect(t.subscription).toMatchObject({ id: sub.id, status: 'ACTIVE', discountBps: 0, customPriceCents: null, cancelAtPeriodEnd: false })
    expect(t.subscription.plan).toMatchObject({ code: 'starter', name: 'Starter', model: 'FLAT', interval: 'MONTH' })
    expect(t.owners).toEqual([{ id: fx.users.owner.id, name: 'owner', username: 'owner', active: true }])
    expect(t.lastSaleAt).not.toBeNull()
    expect(t.lastSignInAt).not.toBeNull()
    // the next period of a flat plan, raised when this one ends
    expect(t.nextInvoice).toMatchObject({ subtotalCents: 250_000, taxCents: 40_000, totalCents: 290_000 })
    expect(t.nextInvoice.periodStart).toBe(sub.currentPeriodEnd.toISOString())
    expect(t.nextInvoice.issueAt).toBe(sub.currentPeriodEnd.toISOString())
    expect(t.nextInvoice.lines).toHaveLength(1)
    expect(JSON.stringify(res.body)).not.toMatch(/password|token/i)
    expect(owner.cookie).not.toBe('')

    expect((await billing.get('/api/console/tenants/nope')).status).toBe(404)
  })

  it('shows a business with no subscription as NONE with nothing limited', async () => {
    const res = await support.get(`/api/console/tenants/${fx.business.id}`)
    expect(res.body.tenant).toMatchObject({ status: 'NONE', subscription: null, limits: null, nextInvoice: null, mrrCents: 0, openInvoiceCents: 0, lastSaleAt: null, lastSignInAt: null })
  })

  it('edits client details', async () => {
    const res = await support.patch(`/api/console/tenants/${fx.business.id}`, {
      name: 'Test Wines and Spirits',
      legalName: 'Test Wines Limited',
      email: 'Accounts@TestWines.co.ke',
      phone: '0722000111',
      address: 'Waiyaki Way, Westlands',
      kraPin: 'p051234567x'
    })
    expect(res.status).toBe(200)
    expect(res.body.tenant).toEqual({
      id: fx.business.id,
      name: 'Test Wines and Spirits',
      legalName: 'Test Wines Limited',
      email: 'accounts@testwines.co.ke',
      phone: '254722000111',
      address: 'Waiyaki Way, Westlands',
      kraPin: 'P051234567X'
    })
    const cleared = await admin.patch(`/api/console/tenants/${fx.business.id}`, { legalName: '', email: null, kraPin: '' })
    expect(cleared.body.tenant).toMatchObject({ name: 'Test Wines and Spirits', legalName: null, email: null, kraPin: null, phone: '254722000111' })
    const log = await prisma.auditLog.findMany({ where: { action: 'console.tenant.updated' }, orderBy: { id: 'asc' } })
    expect(log).toHaveLength(2)
    expect(log[0]!.businessId).toBe(fx.business.id)
    expect((log[0]!.data as any).changed.name).toEqual({ from: 'Test Wines', to: 'Test Wines and Spirits' })

    for (const bad of [{}, { name: '' }, { email: 'nope' }, { phone: '123' }, { kraPin: '12345' }, { address: 'x'.repeat(301) }]) {
      expect((await support.patch(`/api/console/tenants/${fx.business.id}`, bad)).status, JSON.stringify(bad)).toBe(400)
    }
    expect((await support.patch('/api/console/tenants/nope', { name: 'Ghost' })).status).toBe(404)
  })
})

describe('console tenants: suspend and reactivate', () => {
  it('suspends at once (shop API answers 402) and reactivates', async () => {
    await subscribe()
    const owner = await Client.login('owner')
    expect((await owner.get('/api/products')).status).toBe(200)

    const res = await support.post(`/api/console/tenants/${fx.business.id}/suspend`, { reason: 'Chargeback under review' })
    expect(res.status).toBe(200)
    expect(res.body.subscription).toMatchObject({ status: 'SUSPENDED', suspendedReason: 'Chargeback under review' })
    expect(res.body.subscription.suspendedAt).not.toBeNull()
    expect((await owner.get('/api/products')).status).toBe(402)

    const again = await support.post(`/api/console/tenants/${fx.business.id}/suspend`, { reason: 'Twice' })
    expect(again.status).toBe(422)

    const back = await support.post(`/api/console/tenants/${fx.business.id}/reactivate`)
    expect(back.status).toBe(200)
    expect(back.body.subscription).toMatchObject({ status: 'ACTIVE', suspendedReason: null, suspendedAt: null })
    expect((await owner.get('/api/products')).status).toBe(200)
    expect((await support.post(`/api/console/tenants/${fx.business.id}/reactivate`)).status).toBe(422)

    const log = await prisma.auditLog.findMany({ where: { businessId: fx.business.id, action: { startsWith: 'console.tenant.' } }, orderBy: { id: 'asc' } })
    expect(log.map(l => l.action)).toEqual(['console.tenant.suspended', 'console.tenant.reactivated'])
    expect(log[0]!.data).toMatchObject({ businessName: 'Test Wines', reason: 'Chargeback under review', from: 'ACTIVE' })
    expect(log[1]!.data).toMatchObject({ to: 'ACTIVE', wasReason: 'Chargeback under review' })
  })

  it('needs a reason, a known client and a subscription record', async () => {
    const none = await support.post(`/api/console/tenants/${fx.business.id}/suspend`, { reason: 'No plan yet' })
    expect(none.status).toBe(422)
    expect(none.body.error.code).toBe('no_subscription')
    expect((await support.post(`/api/console/tenants/${fx.business.id}/reactivate`)).status).toBe(422)
    await subscribe()
    expect((await support.post(`/api/console/tenants/${fx.business.id}/suspend`, {})).status).toBe(400)
    expect((await support.post(`/api/console/tenants/${fx.business.id}/suspend`, { reason: ' ' })).status).toBe(400)
    expect((await support.post('/api/console/tenants/nope/suspend', { reason: 'Unknown client' })).status).toBe(404)
    expect((await support.post('/api/console/tenants/nope/reactivate')).status).toBe(404)
    await prisma.subscription.update({ where: { businessId: fx.business.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } })
    expect((await support.post(`/api/console/tenants/${fx.business.id}/suspend`, { reason: 'Already gone' })).status).toBe(422)
  })

  it('returns to PAST_DUE while an invoice is overdue, and to TRIALING inside a trial', async () => {
    await subscribe({ status: 'PAST_DUE' })
    await overdueInvoice(fx.business.id, 10)
    await support.post(`/api/console/tenants/${fx.business.id}/suspend`, { reason: 'Owner asked for a pause' })
    const owing = await support.post(`/api/console/tenants/${fx.business.id}/reactivate`)
    expect(owing.body.subscription.status).toBe('PAST_DUE')

    const trial = (await onboard()).body
    const sus = await admin.post(`/api/console/tenants/${trial.tenant.id}/suspend`, { reason: 'Duplicate sign up' })
    expect(sus.body.subscription.status).toBe('SUSPENDED')
    const back = await admin.post(`/api/console/tenants/${trial.tenant.id}/reactivate`)
    expect(back.body.subscription).toMatchObject({ status: 'TRIALING', trialEndsAt: trial.subscription.trialEndsAt })
  })

  it('two suspensions at once: exactly one wins', async () => {
    await subscribe()
    const [a, b] = await Promise.all([
      support.post(`/api/console/tenants/${fx.business.id}/suspend`, { reason: 'First' }),
      admin.post(`/api/console/tenants/${fx.business.id}/suspend`, { reason: 'Second' })
    ])
    expect([a.status, b.status].sort()).toEqual([200, 422])
    expect(await prisma.auditLog.count({ where: { action: 'console.tenant.suspended' } })).toBe(1)
  })
})

describe('console tenants: people', () => {
  it('lists staff with role, branches, lock state and last sign in', async () => {
    await prisma.user.update({ where: { id: fx.users.cashier2.id }, data: { lockedUntil: new Date(Date.now() + 600_000), active: false } })
    await Client.login('manager')
    const res = await billing.get(`/api/console/tenants/${fx.business.id}/people`)
    expect(res.status).toBe(200)
    expect(res.body.people).toHaveLength(6)
    const by = (u: string) => res.body.people.find((p: any) => p.username === u)
    expect(by('manager')).toMatchObject({ role: 'MANAGER', active: true, locked: false, branches: [{ id: fx.branches.west.id, name: 'Westlands' }] })
    expect(by('manager').lastSignInAt).not.toBeNull()
    expect(by('owner')).toMatchObject({ role: 'OWNER', branches: [], lastSignInAt: null })
    expect(by('cashier2')).toMatchObject({ active: false, locked: true })
    expect(JSON.stringify(res.body)).not.toMatch(/password|failedPins|email/)
    expect((await billing.get('/api/console/tenants/nope/people')).status).toBe(404)
  })

  it('resets an owner PIN: shown once, old sessions and lockout gone, never audited', async () => {
    const before = await Client.login('owner')
    await prisma.user.update({ where: { id: fx.users.owner.id }, data: { failedPins: 3, lockedUntil: new Date(Date.now() + 600_000) } })
    const res = await support.post(`/api/console/tenants/${fx.business.id}/people/${fx.users.owner.id}/reset-pin`)
    expect(res.status).toBe(200)
    expect(res.body.ownerPin).toMatch(/^\d{6}$/)
    expect(res.body.user).toEqual({ id: fx.users.owner.id, name: 'owner', username: 'owner' })
    expect(res.body.sessionsEnded).toBe(1)
    expect((await before.get('/api/products')).status).toBe(401)
    const user = await prisma.user.findUniqueOrThrow({ where: { id: fx.users.owner.id } })
    expect(user).toMatchObject({ failedPins: 0, lockedUntil: null })
    const after = await Client.login('owner', res.body.ownerPin)
    expect((await after.get('/api/products')).status).toBe(200)
    if (res.body.ownerPin !== '1234') await expect(Client.login('owner', '1234')).rejects.toThrow()
    const log = await prisma.auditLog.findMany({ where: { action: 'console.tenant.pin_reset' } })
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ businessId: fx.business.id, entityId: fx.users.owner.id })
    expect(log[0]!.data).toMatchObject({ businessName: 'Test Wines', username: 'owner', sessionsEnded: 1 })
    expect(JSON.stringify(log.map(a => [a.entityId, a.data]))).not.toContain(res.body.ownerPin)
  })

  it('only resets owners, and only inside that client', async () => {
    const staff = await support.post(`/api/console/tenants/${fx.business.id}/people/${fx.users.manager.id}/reset-pin`)
    expect(staff.status).toBe(422)
    expect(staff.body.error.code).toBe('not_owner')
    const other = (await onboard()).body
    const cross = await support.post(`/api/console/tenants/${other.tenant.id}/people/${fx.users.owner.id}/reset-pin`)
    expect(cross.status).toBe(404)
    const platformUser = await prisma.user.findFirstOrThrow({ where: { platformRole: 'SUPER_ADMIN' } })
    expect((await support.post(`/api/console/tenants/${fx.business.id}/people/${platformUser.id}/reset-pin`)).status).toBe(404)
    expect((await support.post(`/api/console/tenants/nope/people/${fx.users.owner.id}/reset-pin`)).status).toBe(404)
    await Client.login('owner')
    await Client.login('manager')
  })

  it('signs out every user of one client and nobody else', async () => {
    const other = (await onboard()).body
    const theirs = await Client.login('njeri', other.ownerPin, other.branch.id)
    const owner = await Client.login('owner')
    const cashier = await Client.login('cashier', undefined, fx.branches.west.id)
    const res = await support.post(`/api/console/tenants/${fx.business.id}/sign-out-all`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ sessionsEnded: 2 })
    expect((await owner.get('/api/products')).status).toBe(401)
    expect((await cashier.get('/api/products')).status).toBe(401)
    expect((await theirs.get('/api/products')).status).toBe(200)
    expect((await support.get('/api/console/tenants')).status).toBe(200)
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'console.tenant.signed_out' } })
    expect(log.data).toMatchObject({ businessName: 'Test Wines', sessionsEnded: 2 })
    expect((await support.post('/api/console/tenants/nope/sign-out-all')).status).toBe(404)
  })
})

describe('console tenants: notes and history', () => {
  it('adds, lists and deletes notes with author names', async () => {
    const base = `/api/console/tenants/${fx.business.id}/notes`
    const first = await support.post(base, { body: '  Owner wants a second branch in March  ' })
    expect(first.status).toBe(201)
    expect(first.body.note).toMatchObject({ body: 'Owner wants a second branch in March', author: { name: 'support' } })
    const second = await admin.post(base, { body: 'x'.repeat(2000) })
    expect(second.status).toBe(201)
    for (const bad of [{}, { body: '' }, { body: '   ' }, { body: 'x'.repeat(2001) }]) {
      expect((await support.post(base, bad)).status).toBe(400)
    }
    expect((await support.post('/api/console/tenants/nope/notes', { body: 'hi' })).status).toBe(404)

    const list = await billing.get(base)
    expect(list.body.notes.map((n: any) => n.author.name)).toEqual(['admin', 'support'])
    expect(Object.keys(list.body.notes[0]).sort()).toEqual(['author', 'body', 'createdAt', 'id'])

    // another support user cannot delete it, the author and a super admin can
    await createPlatformUser(prisma, { name: 'support2', email: 'support2@bottlepoint.test', password: CONSOLE_PASSWORD, role: 'SUPPORT' })
    const support2 = await consoleLogin('support2@bottlepoint.test')
    expect((await support2.del(`${base}/${first.body.note.id}`)).status).toBe(403)
    expect((await support.del(`${base}/${second.body.note.id}`)).status).toBe(403)
    const other = (await onboard()).body
    expect((await admin.del(`/api/console/tenants/${other.tenant.id}/notes/${first.body.note.id}`)).status).toBe(404)
    expect((await support.del(`${base}/${first.body.note.id}`)).body).toEqual({ ok: true })
    expect((await support.del(`${base}/${first.body.note.id}`)).status).toBe(404)
    const mine = await support.post(base, { body: 'Follow up next week' })
    expect((await admin.del(`${base}/${mine.body.note.id}`)).status).toBe(200)
    expect((await billing.get(base)).body.notes).toHaveLength(1)
    const actions = (await prisma.auditLog.findMany({ where: { businessId: fx.business.id, action: { startsWith: 'console.note.' } }, orderBy: { id: 'asc' } })).map(a => a.action)
    expect(actions).toEqual(['console.note.added', 'console.note.added', 'console.note.deleted', 'console.note.added', 'console.note.deleted'])
  })

  it('shows the history of one client, newest first, with who did it', async () => {
    const other = (await onboard()).body
    await subscribe()
    const id = fx.business.id
    await support.patch(`/api/console/tenants/${id}`, { address: 'Westlands' })
    await prisma.auditLog.create({ data: { userId: fx.users.owner.id, businessId: id, action: 'settings.updated', entity: 'Business', entityId: id } })
    await prisma.auditLog.create({ data: { userId: null, businessId: id, action: 'billing.invoice_created', entity: 'Invoice', entityId: 'x', data: { number: 'INV-2026-000001' } } })
    await admin.post(`/api/console/tenants/${id}/suspend`, { reason: 'Review' })

    const res = await billing.get(`/api/console/tenants/${id}/activity`)
    expect(res.status).toBe(200)
    expect(res.body.activity.map((a: any) => a.action)).toEqual(['console.tenant.suspended', 'billing.invoice_created', 'settings.updated', 'console.tenant.updated'])
    expect(res.body.nextBefore).toBeNull()
    const [suspended, system, shop, updated] = res.body.activity
    expect(typeof suspended.id).toBe('string')
    expect(suspended.actor).toMatchObject({ name: 'admin', kind: 'platform' })
    expect(suspended.data).toMatchObject({ reason: 'Review' })
    expect(system.actor).toEqual({ id: null, name: 'Bottle Point', kind: 'system' })
    expect(shop.actor).toEqual({ id: fx.users.owner.id, name: 'owner', kind: 'shop' })
    expect(updated.actor).toMatchObject({ name: 'support', kind: 'platform' })

    const page1 = await billing.get(`/api/console/tenants/${id}/activity?limit=3`)
    expect(page1.body.activity).toHaveLength(3)
    expect(page1.body.nextBefore).toBe(page1.body.activity[2].id)
    const page2 = await billing.get(`/api/console/tenants/${id}/activity?limit=3&before=${page1.body.nextBefore}`)
    expect(page2.body.activity.map((a: any) => a.action)).toEqual(['console.tenant.updated'])
    expect(page2.body.nextBefore).toBeNull()

    const theirs = await billing.get(`/api/console/tenants/${other.tenant.id}/activity`)
    expect(theirs.body.activity.map((a: any) => a.action)).toEqual(['console.tenant.created'])
    expect((await billing.get(`/api/console/tenants/${id}/activity?before=abc`)).status).toBe(400)
    expect((await billing.get(`/api/console/tenants/${id}/activity?limit=500`)).status).toBe(400)
    expect((await billing.get('/api/console/tenants/nope/activity')).status).toBe(404)
  })
})
