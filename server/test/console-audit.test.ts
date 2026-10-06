import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { auditSummary, groupOf } from '../src/routes/console/audit.js'
import { Client, consoleLogin, resetDb, seedFixture, seedPlatform, type Fixture } from './helpers.js'

let fx: Fixture
let team: Awaited<ReturnType<typeof seedPlatform>>
let admin: Client
let otherBusinessId: string

type RowInput = { at: string; userId?: string | null; businessId?: string | null; data?: Record<string, unknown>; entity?: string; entityId?: string | null }

const row = (action: string, r: RowInput) =>
  prisma.auditLog.create({
    data: {
      action,
      at: new Date(r.at),
      userId: r.userId ?? null,
      businessId: r.businessId ?? null,
      entity: r.entity ?? 'thing',
      entityId: r.entityId ?? null,
      data: (r.data ?? undefined) as never
    }
  })

const actions = (r: { body: { entries: { action: string }[] } }) => r.body.entries.map(e => e.action)

// Ten rows over three Nairobi days, one of every kind. Signing in below adds
// console.login rows dated "now", far after these.
async function history() {
  const biz = fx.business.id
  await row('sale.completed', { at: '2026-03-30T09:00:00Z', userId: fx.users.cashier.id, businessId: biz, data: { totalCents: 480000 } })
  await row('console.tenant.created', { at: '2026-03-30T10:00:00Z', userId: team.support.id, businessId: otherBusinessId, data: { businessName: 'Old Name', planName: 'Starter' } })
  await row('console.note.added', { at: '2026-03-30T11:00:00Z', userId: team.support.id, businessId: biz })
  await row('console.plan.created', { at: '2026-03-31T08:00:00Z', userId: team.billing.id, data: { name: 'Growth', code: 'growth' } })
  await row('billing.invoice_created', { at: '2026-03-31T20:59:59Z', businessId: biz, data: { number: 'INV-2026-000012', totalCents: 290000 } })
  // 00:30 on 1 April in Nairobi, still 31 March in UTC
  await row('billing.past_due', { at: '2026-03-31T21:30:00Z', businessId: biz, data: { number: 'INV-2026-000012' } })
  await row('console.invoice.payment_recorded', { at: '2026-04-01T07:00:00Z', userId: team.billing.id, businessId: biz, data: { number: 'INV-2026-000012', amountCents: 100050 } })
  await row('console.tenant.suspended', { at: '2026-04-01T08:00:00Z', userId: team.support.id, businessId: biz, data: { reason: 'Unpaid invoice INV-2026-000012' } })
  await row('console.team.created', { at: '2026-04-01T09:00:00Z', userId: team.admin.id, entity: 'user', entityId: team.support.id, data: { name: 'support', role: 'SUPPORT' } })
  await row('console.login_failed', { at: '2026-04-01T10:00:00Z', entity: 'user', entityId: team.billing.id, data: { tries: 2 } })
}

beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
  team = await seedPlatform()
  otherBusinessId = (await prisma.business.create({ data: { name: 'Mama Njeri Wines' } })).id
  admin = await consoleLogin('admin@bottlepoint.test')
})

describe('GET /audit: access', () => {
  it('is open to every console role and closed to everyone else', async () => {
    await history()
    for (const name of ['support', 'billing']) {
      const c = await consoleLogin(`${name}@bottlepoint.test`)
      const r = await c.get('/api/console/audit?group=shop')
      expect(r.status).toBe(200)
      expect(r.body.entries).toHaveLength(1)
    }
    expect((await new Client().get('/api/console/audit')).status).toBe(401)
    const owner = await Client.login('owner')
    expect((await owner.get('/api/console/audit')).status).toBe(401)
    expect((await owner.get(`/api/console/audit?businessId=${fx.business.id}`)).status).toBe(401)
  })
})

describe('GET /audit: rows', () => {
  it('returns newest first with string ids, actors, clients and plain summaries', async () => {
    await history()
    const r = await admin.get('/api/console/audit?to=2026-04-30')
    expect(r.status).toBe(200)
    expect(r.body.nextBefore).toBeNull()
    const e = r.body.entries
    expect(e).toHaveLength(10)
    expect(actions(r)[0]).toBe('console.login_failed')
    expect(actions(r)[9]).toBe('sale.completed')
    for (const x of e) {
      expect(typeof x.id).toBe('string')
      expect(x.id).toMatch(/^\d+$/)
      expect(Object.keys(x).sort()).toEqual(['action', 'actor', 'at', 'business', 'data', 'entity', 'entityId', 'group', 'id', 'summary'])
    }
    const ids = e.map((x: any) => Number(x.id))
    expect(ids).toEqual([...ids].sort((a, b) => b - a))

    const by = (action: string) => e.find((x: any) => x.action === action)
    expect(by('console.tenant.suspended')).toMatchObject({
      at: '2026-04-01T08:00:00.000Z',
      group: 'clients',
      summary: 'Suspended Test Wines: unpaid invoice INV-2026-000012',
      actor: { id: team.support.id, name: 'support', kind: 'platform' },
      business: { id: fx.business.id, name: 'Test Wines' },
      data: { reason: 'Unpaid invoice INV-2026-000012' }
    })
    expect(by('sale.completed')).toMatchObject({
      group: 'shop',
      summary: 'Sale completed at Test Wines',
      actor: { id: fx.users.cashier.id, name: 'cashier', kind: 'shop' },
      business: { id: fx.business.id, name: 'Test Wines' }
    })
    expect(by('billing.invoice_created')).toMatchObject({
      group: 'billing',
      summary: 'Billed Test Wines: invoice INV-2026-000012 for KSh 2,900',
      actor: { id: null, name: 'System', kind: 'system' }
    })
    expect(by('billing.past_due').summary).toBe('Marked Test Wines past due: unpaid invoice INV-2026-000012')
    expect(by('console.invoice.payment_recorded').summary).toBe('Recorded a payment of KSh 1,000.50 on invoice INV-2026-000012 from Test Wines')
    // the current name of the client wins over a name stored in the row
    expect(by('console.tenant.created').summary).toBe('Onboarded Mama Njeri Wines on Starter')
    expect(by('console.plan.created')).toMatchObject({ summary: 'Created the plan Growth', business: null, data: { name: 'Growth', code: 'growth' } })
    expect(by('console.team.created')).toMatchObject({ group: 'team', summary: 'Added support to the team as support' })
    expect(by('console.login_failed')).toMatchObject({
      group: 'signin',
      summary: 'Wrong password at console sign in for billing',
      actor: { kind: 'system' },
      entityId: team.billing.id
    })
    expect(by('console.note.added').data).toBeNull()
  })

  it('names a removed actor without failing', async () => {
    await row('console.plan.archived', { at: '2026-04-02T00:00:00Z', userId: 'gone-user', data: { name: 'Starter' } })
    const r = await admin.get('/api/console/audit?group=billing')
    expect(r.body.entries[0]).toMatchObject({ summary: 'Archived the plan Starter', actor: { id: 'gone-user', name: 'Removed user', kind: 'shop' } })
  })
})

describe('GET /audit: filters', () => {
  beforeEach(history)

  it('filters by group', async () => {
    const get = async (group: string) => actions(await admin.get(`/api/console/audit?group=${group}&to=2026-04-30`))
    expect(await get('billing')).toEqual(['console.invoice.payment_recorded', 'billing.past_due', 'billing.invoice_created', 'console.plan.created'])
    expect(await get('clients')).toEqual(['console.tenant.suspended', 'console.note.added', 'console.tenant.created'])
    expect(await get('team')).toEqual(['console.team.created'])
    expect(await get('signin')).toEqual(['console.login_failed'])
    expect(await get('shop')).toEqual(['sale.completed'])
    // without a date limit the sign in made for this test shows up too. Order
    // follows the id (the order rows were written), and it was written first.
    expect(actions(await admin.get('/api/console/audit?group=signin'))).toEqual(['console.login_failed', 'console.login'])
  })

  it('filters by user, including what the system did by itself', async () => {
    expect(actions(await admin.get(`/api/console/audit?userId=${team.support.id}`))).toEqual([
      'console.tenant.suspended',
      'console.note.added',
      'console.tenant.created'
    ])
    expect(actions(await admin.get(`/api/console/audit?userId=${fx.users.cashier.id}`))).toEqual(['sale.completed'])
    expect(actions(await admin.get('/api/console/audit?userId=system'))).toEqual(['console.login_failed', 'billing.past_due', 'billing.invoice_created'])
    expect(actions(await admin.get('/api/console/audit?userId=nobody'))).toEqual([])
  })

  it('filters by client and combines filters', async () => {
    const mine = await admin.get(`/api/console/audit?businessId=${fx.business.id}`)
    expect(mine.body.entries).toHaveLength(6)
    expect(mine.body.entries.every((e: any) => e.business.id === fx.business.id)).toBe(true)
    expect(actions(await admin.get(`/api/console/audit?businessId=${otherBusinessId}`))).toEqual(['console.tenant.created'])
    expect(actions(await admin.get(`/api/console/audit?businessId=${fx.business.id}&group=billing&userId=${team.billing.id}`))).toEqual([
      'console.invoice.payment_recorded'
    ])
    // empty values from a form mean "no filter"
    const blank = await admin.get('/api/console/audit?from=&to=2026-04-30&userId=&businessId=&group=&before=')
    expect(blank.status).toBe(200)
    expect(blank.body.entries).toHaveLength(10)
  })

  it('treats dates as Nairobi days, both ends included', async () => {
    const get = async (qs: string) => actions(await admin.get(`/api/console/audit?${qs}`))
    // 21:30 UTC on 31 March is already 1 April in Nairobi
    expect(await get('from=2026-04-01&to=2026-04-01')).toEqual([
      'console.login_failed',
      'console.team.created',
      'console.tenant.suspended',
      'console.invoice.payment_recorded',
      'billing.past_due'
    ])
    expect(await get('from=2026-03-31&to=2026-03-31')).toEqual(['billing.invoice_created', 'console.plan.created'])
    expect(await get('to=2026-03-30')).toEqual(['console.note.added', 'console.tenant.created', 'sale.completed'])
    const since = await get('from=2026-03-31')
    expect(since).toHaveLength(8)
    expect(since).toContain('console.plan.created')
    expect(since).not.toContain('console.note.added')
    expect(await get('from=2026-04-02&to=2026-04-03')).toEqual([])
    // full timestamps are taken as given
    expect(await get('from=2026-03-31T21:30:00Z&to=2026-04-01T07:00:00Z')).toEqual(['console.invoice.payment_recorded', 'billing.past_due'])
  })

  it('pages with a cursor and never repeats or skips a row', async () => {
    const seen: string[] = []
    let before = ''
    let pages = 0
    for (;;) {
      const r = await admin.get(`/api/console/audit?to=2026-04-30&limit=4${before ? `&before=${before}` : ''}`)
      expect(r.status).toBe(200)
      seen.push(...r.body.entries.map((e: any) => e.id))
      pages++
      if (!r.body.nextBefore) break
      expect(r.body.entries).toHaveLength(4)
      expect(r.body.nextBefore).toBe(r.body.entries[3].id)
      before = r.body.nextBefore
    }
    expect(pages).toBe(3)
    expect(seen).toHaveLength(10)
    expect(new Set(seen).size).toBe(10)
    expect(seen.map(Number)).toEqual([...seen.map(Number)].sort((a, b) => b - a))

    // exactly one page: no cursor handed back
    const exact = await admin.get('/api/console/audit?to=2026-04-30&limit=10')
    expect(exact.body.entries).toHaveLength(10)
    expect(exact.body.nextBefore).toBeNull()
  })

  it('defaults to 50 rows and validates every parameter', async () => {
    for (let i = 0; i < 55; i++) await row('sale.completed', { at: '2026-02-01T00:00:00Z', businessId: fx.business.id })
    const r = await admin.get('/api/console/audit')
    expect(r.body.entries).toHaveLength(50)
    expect(r.body.nextBefore).toBe(r.body.entries[49].id)
    expect((await admin.get('/api/console/audit?limit=200')).body.entries).toHaveLength(66)

    for (const qs of ['group=bogus', 'limit=0', 'limit=201', 'limit=abc', 'before=abc', 'before=-1', 'from=yesterday', 'to=2026-13-45']) {
      const bad = await admin.get(`/api/console/audit?${qs}`)
      expect(bad.status, qs).toBe(400)
      expect(bad.body.error.code).toBe('bad_request')
    }
  })
})

describe('GET /audit: what the console itself writes', () => {
  it('shows team changes and sign ins with the right actor', async () => {
    const made = await admin.post('/api/console/team', { name: 'Jane Doe', email: 'jane@x.test', role: 'BILLING' })
    await admin.patch(`/api/console/team/${made.body.member.id}`, { role: 'SUPPORT', active: false })
    await admin.post(`/api/console/team/${made.body.member.id}/reset-password`)

    const r = await admin.get('/api/console/audit?group=team')
    expect(r.body.entries.map((e: any) => e.summary)).toEqual([
      'Reset the console password of Jane Doe',
      'Updated Jane Doe: role changed to support, switched off',
      'Added Jane Doe to the team as billing'
    ])
    expect(r.body.entries.every((e: any) => e.actor.id === team.admin.id && e.actor.kind === 'platform' && e.business === null)).toBe(true)
    expect(JSON.stringify(r.body)).not.toContain(made.body.temporaryPassword)

    const signin = await admin.get(`/api/console/audit?group=signin&userId=${team.admin.id}`)
    expect(signin.body.entries).toHaveLength(1)
    expect(signin.body.entries[0]).toMatchObject({ action: 'console.login', summary: 'Signed in to the console', actor: { name: 'admin', kind: 'platform' } })
  })
})

describe('auditSummary', () => {
  it('puts every console and billing action in plain words', () => {
    const s = (action: string, data: Record<string, unknown> = {}, biz: string | null = 'Kwa Otieno Liquor') => auditSummary(action, data, biz)
    expect(s('billing.suspended', { number: 'INV-2026-000003', reason: 'Unpaid invoice INV-2026-000003' })).toBe('Suspended Kwa Otieno Liquor: unpaid invoice INV-2026-000003')
    expect(s('console.tenant.reactivated')).toBe('Reactivated Kwa Otieno Liquor')
    expect(s('console.tenant.updated')).toBe('Edited the details of Kwa Otieno Liquor')
    expect(s('console.tenant.pin_reset', { username: 'otieno' })).toBe('Reset the owner PIN of otieno at Kwa Otieno Liquor')
    expect(s('console.tenant.signed_out')).toBe('Signed out all staff of Kwa Otieno Liquor')
    expect(s('console.note.deleted')).toBe('Deleted a note on Kwa Otieno Liquor')
    expect(s('console.subscription.plan_changed', { planName: 'Growth' })).toBe('Moved Kwa Otieno Liquor to the Growth plan')
    expect(s('console.subscription.terms_changed', { discountBps: 1250, customPriceCents: null })).toBe('Changed the terms of Kwa Otieno Liquor: discount 12.5%, no agreed price')
    expect(s('console.subscription.terms_changed', { customPriceCents: 200000 })).toBe('Changed the terms of Kwa Otieno Liquor: agreed price KSh 2,000')
    expect(s('console.subscription.trial_extended', { days: 7 })).toBe('Extended the trial of Kwa Otieno Liquor by 7 days')
    expect(s('console.subscription.cancelled', { reason: 'Closed the shop' })).toBe('Cancelled the subscription of Kwa Otieno Liquor: closed the shop')
    expect(s('console.subscription.cancel_scheduled')).toBe('Set Kwa Otieno Liquor to cancel at the end of the period')
    expect(s('console.subscription.resumed')).toBe('Resumed the subscription of Kwa Otieno Liquor')
    expect(s('console.invoice.created', { number: 'INV-2026-000004', totalCents: 116000 })).toBe('Raised invoice INV-2026-000004 for KSh 1,160 to Kwa Otieno Liquor')
    expect(s('console.invoice.voided', { number: 'INV-2026-000004', reason: 'Raised twice' })).toBe('Voided invoice INV-2026-000004 of Kwa Otieno Liquor: raised twice')
    expect(s('console.billing.run', { invoicesCreated: 1 }, null)).toBe('Ran billing: 1 invoice raised')
    expect(s('billing.trial_converted')).toBe('Trial ended for Kwa Otieno Liquor, now a paying client')
    expect(s('billing.period_advanced')).toBe('Started a new billing period for Kwa Otieno Liquor')
    expect(s('billing.cancelled')).toBe('Cancelled the subscription of Kwa Otieno Liquor')
    expect(s('console.plan.unarchived', { name: 'Starter' }, null)).toBe('Brought back the plan Starter')
    expect(s('console.password_changed', {}, null)).toBe('Changed their console password')
  })

  it('falls back to readable words and survives odd data', () => {
    expect(auditSummary('stock.count_adjusted', null, null)).toBe('Stock count adjusted')
    expect(auditSummary('console.something_new', ['x'], undefined)).toBe('Something new')
    expect(auditSummary('console.tenant.suspended', 'text', null)).toBe('Suspended a client')
    expect(auditSummary('console.invoice.voided', { number: 7 }, null)).toBe('Voided an invoice of a client')
    expect(groupOf('billing.suspended')).toBe('billing')
    expect(groupOf('console.subscription.resumed')).toBe('billing')
    expect(groupOf('console.note.added')).toBe('clients')
    expect(groupOf('console.team.updated')).toBe('team')
    expect(groupOf('console.password_changed')).toBe('signin')
    expect(groupOf('pin.reset')).toBe('shop')
  })
})
