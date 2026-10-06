import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { createPlatformUser, createStaff } from '../src/lib/users.js'
import { cleanData, groupOf, ksh, looksSecret, summarize } from '../src/rules/settings.js'
import { app, Client, CONSOLE_PASSWORD, consoleLogin, ORIGIN, PIN, resetDb, seedFixture, seedPlatform, type Fixture } from './helpers.js'

let fx: Fixture
beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
})

// A second, unrelated business with its own branch, owner and cashier.
async function secondBusiness() {
  const business = await prisma.business.create({ data: { name: 'Other Wines' } })
  const branch = await prisma.branch.create({ data: { businessId: business.id, name: 'Karen' } })
  const owner = await createStaff(prisma, { businessId: business.id, name: 'Other Owner', username: 'owner2', pin: PIN, role: 'OWNER', branchIds: [] })
  const cashier = await createStaff(prisma, { businessId: business.id, name: 'Other Cashier', username: 'othercashier', pin: PIN, role: 'CASHIER', branchIds: [branch.id] })
  return { business, branch, owner, cashier }
}

type RowInput = { action: string; userId?: string | null; businessId?: string | null; branchId?: string | null; entity?: string; entityId?: string | null; data?: unknown; at?: Date }
const row = (r: RowInput) =>
  prisma.auditLog.create({
    data: {
      action: r.action,
      userId: r.userId ?? null,
      businessId: r.businessId === undefined ? fx.business.id : r.businessId,
      branchId: r.branchId ?? null,
      entity: r.entity ?? 'thing',
      entityId: r.entityId ?? null,
      data: (r.data ?? undefined) as never,
      at: r.at
    }
  })

const actions = (body: any) => body.entries.map((e: any) => e.action)

async function suspend(businessId: string) {
  const plan = await prisma.plan.create({ data: { code: 'test', name: 'Test', model: 'FLAT', priceCents: 250000 } })
  const now = new Date()
  await prisma.subscription.create({
    data: { businessId, planId: plan.id, status: 'SUSPENDED', currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * 86400000) }
  })
}

describe('helpers', () => {
  it('puts every known action in a group', () => {
    expect(groupOf('sale.create')).toBe('sales')
    expect(groupOf('shift.close')).toBe('sales')
    expect(groupOf('approval.approve')).toBe('sales')
    expect(groupOf('customer.created')).toBe('sales')
    expect(groupOf('sale.pay')).toBe('payments')
    expect(groupOf('sale.refund')).toBe('payments')
    expect(groupOf('mpesa.paid')).toBe('payments')
    expect(groupOf('stock.adjusted')).toBe('stock')
    expect(groupOf('product.price_changed')).toBe('stock')
    expect(groupOf('user.pin_reset')).toBe('staff')
    expect(groupOf('user.signed_out')).toBe('signin')
    expect(groupOf('session.revoked')).toBe('signin')
    expect(groupOf('auth.pin_failed')).toBe('signin')
    expect(groupOf('branch.updated')).toBe('settings')
    expect(groupOf('business.updated')).toBe('settings')
    expect(groupOf('mpesa.config_updated')).toBe('settings')
    expect(groupOf('mpesa.secrets_deleted')).toBe('settings')
    expect(groupOf('export.created')).toBe('settings')
    expect(summarize({ action: 'console.tenant.suspended', data: {}, who: 'Bottle Point support' })).toBe('Bottle Point support suspended this account')
    expect(summarize({ action: 'console.invoice.payment_recorded', data: { number: 'INV-0002', amountCents: 250000 }, who: 'Bottle Point support' })).toBe(
      'Bottle Point support recorded a payment of KSh 2,500 on invoice INV-0002'
    )
    expect(summarize({ action: 'export.created', data: { kind: 'SALES' }, who: 'Amina' })).toBe('Amina downloaded an export (sales)')
    expect(groupOf('billing.invoice_created')).toBe('settings')
    expect(groupOf('console.subscription_suspended')).toBe('settings')
    expect(groupOf('something.else')).toBeNull()
  })

  it('knows which keys look like secrets', () => {
    for (const k of ['pin', 'PIN', 'newPin', 'failedPins', 'password', 'passwordHash', 'token', 'callbackToken', 'secret', 'consumerSecret', 'key', 'consumerKey', 'api_key', 'apikey', 'passkey', 'hash', 'cookie']) {
      expect(looksSecret(k), k).toBe(true)
    }
    for (const k of ['shipping', 'openingFloatCents', 'name', 'amountCents', 'receipt', 'saleId', 'reason']) {
      expect(looksSecret(k), k).toBe(false)
    }
  })

  it('formats money', () => {
    expect(ksh(480000)).toBe('KSh 4,800')
    expect(ksh(123456789)).toBe('KSh 1,234,567.89')
    expect(ksh(50)).toBe('KSh 0.50')
    expect(ksh(0)).toBe('KSh 0')
    expect(ksh(-28000)).toBe('-KSh 280')
    expect(ksh(undefined)).toBe('KSh 0')
  })

  it('writes plain sentences', () => {
    expect(summarize({ action: 'sale.refund', data: { amountCents: 480000 }, who: 'Otieno J.', saleNumber: 1049 })).toBe('Otieno J. approved a refund of KSh 4,800 on sale #1049')
    expect(summarize({ action: 'sale.pay', data: { payments: [{ method: 'CASH', amountCents: 20000 }, { method: 'MPESA', amountCents: 8000 }] }, who: 'Amina', saleNumber: 1001 })).toBe(
      'Amina took a payment of KSh 280 on sale #1001'
    )
    expect(summarize({ action: 'mpesa.paid', data: { saleNumber: 1002, amountCents: 145000, receipt: 'SJK4ABCDEF' }, who: null })).toBe('M-Pesa payment of KSh 1,450 received for sale #1002 (SJK4ABCDEF)')
    expect(summarize({ action: 'product.price_changed', data: { name: 'Tusker Lager', oldPriceCents: 28000, newPriceCents: 30000 }, who: 'Amina' })).toBe(
      'Amina changed the price of Tusker Lager from KSh 280 to KSh 300'
    )
    expect(summarize({ action: 'approval.request', data: { kind: 'DISCOUNT', amountCents: 10000 }, who: 'Amina', saleNumber: 1003 })).toBe('Amina asked for a discount of KSh 100 on sale #1003')
    expect(summarize({ action: 'user.signed_out', data: { sessionsEnded: 1 }, who: 'Amina', subjectName: 'Brian' })).toBe('Amina signed Brian out of 1 device')
    expect(summarize({ action: 'shift.open', data: { openingFloatCents: 200000 }, who: 'Amina' })).toBe('Amina opened a shift with a float of KSh 2,000')
    // unknown actions still read as a sentence
    expect(summarize({ action: 'business.vat_updated', data: null, who: 'Amina' })).toBe('Amina recorded an activity (business: vat updated)')
    expect(summarize({ action: 'odd', data: 7, who: null })).toBe('The system recorded an activity (odd)')
  })

  it('cleans data without touching the original', () => {
    const data = { pin: '1', keep: { token: 't', list: [{ secret: 's', a: 1 }] } }
    expect(cleanData(data)).toEqual({ keep: { list: [{ a: 1 }] } })
    expect(data.keep.token).toBe('t')
    expect(cleanData(null)).toBeNull()
    expect(cleanData({ note: 'Seen by Wanjiru', staffId: 'x', reason: 'unpaid' }, { staff: true, needles: ['wanjiru'] })).toEqual({ reason: 'unpaid' })
  })
})

describe('GET /api/admin/audit', () => {
  it('lists a row with actor, branch, summary and the sale number', async () => {
    await prisma.user.update({ where: { id: fx.users.manager.id }, data: { name: 'Otieno J.' } })
    const sale = await prisma.sale.create({ data: { number: 1049, branchId: fx.branches.west.id, createdById: fx.users.cashier.id } })
    const created = await row({
      action: 'sale.refund',
      userId: fx.users.manager.id,
      branchId: fx.branches.west.id,
      entity: 'sale',
      entityId: sale.id,
      data: { approvalId: 'a1', refundId: 'r1', amountCents: 480000, method: 'CASH' }
    })
    const owner = await Client.login('owner')
    const r = await owner.get('/api/admin/audit')
    expect(r.status).toBe(200)
    expect(r.body.nextBefore).toBeNull()
    expect(r.body.entries).toHaveLength(1)
    const e = r.body.entries[0]
    expect(e).toEqual({
      id: created.id.toString(),
      at: created.at.toISOString(),
      action: 'sale.refund',
      group: 'payments',
      summary: 'Otieno J. approved a refund of KSh 4,800 on sale #1049',
      actor: { id: fx.users.manager.id, name: 'Otieno J.' },
      branch: { id: fx.branches.west.id, name: 'Westlands' },
      data: { approvalId: 'a1', refundId: 'r1', amountCents: 480000, method: 'CASH' }
    })
    expect(typeof e.id).toBe('string')
  })

  it('shows system rows with no actor and falls back to a generic sentence', async () => {
    await row({ action: 'mystery.thing_happened', data: { a: 1 } })
    await row({ action: 'nodata.at_all', userId: fx.users.owner.id })
    const owner = await Client.login('owner')
    const r = await owner.get('/api/admin/audit')
    const [second, first] = r.body.entries
    expect(first.actor).toBeNull()
    expect(first.branch).toBeNull()
    expect(first.group).toBeNull()
    expect(first.summary).toBe('The system recorded an activity (mystery: thing happened)')
    expect(second.summary).toBe('owner recorded an activity (nodata: at all)')
    expect(second.data).toBeNull()
  })

  it('strips anything that looks like a secret, at any depth', async () => {
    await row({
      action: 'settings.changed',
      userId: fx.users.owner.id,
      data: { pin: '1234', shipping: 'kept', nested: { consumerKey: 'CK', passwordHash: 'PH', ok: 1, list: [{ token: 'TT', keep: 'k' }, { cookie: 'CC' }] }, passkey: 'PK', secret: 'SS' }
    })
    const owner = await Client.login('owner')
    const r = await owner.get('/api/admin/audit')
    expect(r.body.entries[0].data).toEqual({ shipping: 'kept', nested: { ok: 1, list: [{ keep: 'k' }, {}] } })
    const text = JSON.stringify(r.body)
    for (const s of ['1234', 'CK', 'PH', 'TT', 'CC', 'PK', 'SS']) expect(text).not.toContain(`"${s}"`)
  })

  it('never shows rows of another business', async () => {
    const other = await secondBusiness()
    const otherSale = await prisma.sale.create({ data: { number: 7777, branchId: other.branch.id, createdById: other.cashier.id } })
    await row({ action: 'sale.create', userId: fx.users.cashier.id, branchId: fx.branches.west.id })
    // written by the system for a branch: no business on the row
    await row({ action: 'mpesa.paid', businessId: null, branchId: fx.branches.kili.id, data: { saleNumber: 1002, amountCents: 28000, receipt: 'SJK4ABCDEF' } })
    // points at a sale of the other business: its number must not be looked up
    await row({ action: 'sale.update', userId: fx.users.cashier.id, data: { saleId: otherSale.id } })
    await row({ action: 'sale.create', userId: other.cashier.id, businessId: other.business.id, branchId: other.branch.id })
    await row({ action: 'mpesa.paid', businessId: null, branchId: other.branch.id, data: { saleNumber: 7777 } })
    // belongs to nobody: a console sign in problem
    await row({ action: 'console.login_failed', businessId: null, entity: 'user', entityId: 'staff-1', data: { tries: 2 } })

    const owner = await Client.login('owner')
    const mine = await owner.get('/api/admin/audit')
    expect(actions(mine.body)).toEqual(['sale.update', 'mpesa.paid', 'sale.create'])
    expect(mine.body.entries[0].summary).toBe('cashier updated the details of a sale')
    expect(mine.body.entries[1].summary).toBe('M-Pesa payment of KSh 280 received for sale #1002 (SJK4ABCDEF)')
    expect(mine.body.entries[1].branch).toEqual({ id: fx.branches.kili.id, name: 'Kilimani' })
    expect(JSON.stringify(mine.body)).not.toContain('7777')

    const owner2 = await Client.login('owner2')
    const theirs = await owner2.get('/api/admin/audit')
    expect(actions(theirs.body)).toEqual(['mpesa.paid', 'sale.create'])
    expect(theirs.body.entries.every((e: any) => e.branch.id === other.branch.id)).toBe(true)

    // ids of the first business match nothing for the second, and the reverse
    expect((await owner2.get(`/api/admin/audit?userId=${fx.users.cashier.id}`)).body).toEqual({ entries: [], nextBefore: null })
    expect((await owner2.get(`/api/admin/audit?branchId=${fx.branches.west.id}`)).body).toEqual({ entries: [], nextBefore: null })
    expect((await owner.get(`/api/admin/audit?userId=${other.cashier.id}`)).body).toEqual({ entries: [], nextBefore: null })
    expect((await owner.get(`/api/admin/audit?branchId=${other.branch.id}`)).body).toEqual({ entries: [], nextBefore: null })
    expect((await owner.get('/api/admin/audit?userId=nobody')).body).toEqual({ entries: [], nextBefore: null })
  })

  it('filters by user, branch and group', async () => {
    await row({ action: 'sale.create', userId: fx.users.cashier.id, branchId: fx.branches.west.id })
    await row({ action: 'sale.pay', userId: fx.users.cashier.id, branchId: fx.branches.west.id })
    await row({ action: 'mpesa.paid', businessId: null, branchId: fx.branches.west.id })
    await row({ action: 'stock.adjusted', userId: fx.users.kiliManager.id, branchId: fx.branches.kili.id })
    await row({ action: 'product.created', userId: fx.users.owner.id })
    await row({ action: 'user.pin_reset', userId: fx.users.owner.id, entity: 'user', entityId: fx.users.cashier.id })
    await row({ action: 'user.signed_out', userId: fx.users.owner.id, entity: 'user', entityId: fx.users.cashier.id, data: { sessionsEnded: 2 } })
    await row({ action: 'branch.updated', userId: fx.users.owner.id })
    await row({ action: 'shift.open', userId: fx.users.kiliCashier.id, branchId: fx.branches.kili.id })

    const owner = await Client.login('owner')
    const get = async (qs: string) => actions((await owner.get(`/api/admin/audit?${qs}`)).body)
    expect(await get(`userId=${fx.users.cashier.id}`)).toEqual(['sale.pay', 'sale.create'])
    expect(await get(`branchId=${fx.branches.kili.id}`)).toEqual(['shift.open', 'stock.adjusted'])
    expect(await get(`branchId=${fx.branches.kili.id}&userId=${fx.users.kiliCashier.id}`)).toEqual(['shift.open'])
    expect(await get('group=sales')).toEqual(['shift.open', 'sale.create'])
    expect(await get('group=payments')).toEqual(['mpesa.paid', 'sale.pay'])
    expect(await get('group=stock')).toEqual(['product.created', 'stock.adjusted'])
    expect(await get('group=staff')).toEqual(['user.pin_reset'])
    expect(await get('group=settings')).toEqual(['branch.updated'])
    expect(await get('group=signin')).toEqual(['user.signed_out'])
    expect(await get(`group=payments&userId=${fx.users.cashier.id}`)).toEqual(['sale.pay'])
    const r = await owner.get('/api/admin/audit?group=signin')
    expect(r.body.entries[0].summary).toBe('owner signed cashier out of 2 devices')
  })

  it('treats from and to as whole Nairobi days', async () => {
    // 00:30 on 10 March in Nairobi is still 9 March in UTC
    await row({ action: 'a.early', at: new Date('2026-03-09T20:59:59.000Z') })
    await row({ action: 'a.midnight', at: new Date('2026-03-09T21:00:00.000Z') })
    await row({ action: 'a.late', at: new Date('2026-03-10T20:59:59.999Z') })
    await row({ action: 'a.next', at: new Date('2026-03-10T21:00:00.000Z') })
    const owner = await Client.login('owner')
    const get = async (qs: string) => actions((await owner.get(`/api/admin/audit?${qs}`)).body)
    expect(await get('from=2026-03-10&to=2026-03-10')).toEqual(['a.late', 'a.midnight'])
    expect(await get('from=2026-03-10')).toEqual(['a.next', 'a.late', 'a.midnight'])
    expect(await get('to=2026-03-09')).toEqual(['a.early'])
    expect(await get('from=2026-03-09&to=2026-03-11')).toHaveLength(4)
    expect(await get('from=2026-03-12')).toEqual([])
  })

  it('pages newest first with a cursor on the id', async () => {
    for (let i = 1; i <= 5; i++) await row({ action: `n.${i}`, userId: fx.users.owner.id })
    const owner = await Client.login('owner')
    const p1 = await owner.get('/api/admin/audit?limit=2')
    expect(actions(p1.body)).toEqual(['n.5', 'n.4'])
    expect(p1.body.nextBefore).toBe(p1.body.entries[1].id)
    const p2 = await owner.get(`/api/admin/audit?limit=2&before=${p1.body.nextBefore}`)
    expect(actions(p2.body)).toEqual(['n.3', 'n.2'])
    const p3 = await owner.get(`/api/admin/audit?limit=2&before=${p2.body.nextBefore}`)
    expect(actions(p3.body)).toEqual(['n.1'])
    expect(p3.body.nextBefore).toBeNull()
    // exactly one full page: no phantom next page
    const exact = await owner.get('/api/admin/audit?limit=5')
    expect(exact.body.entries).toHaveLength(5)
    expect(exact.body.nextBefore).toBeNull()
    expect(actions((await owner.get('/api/admin/audit?limit=200')).body)).toHaveLength(5)
  })

  it('defaults to 50 rows', async () => {
    await prisma.auditLog.createMany({ data: Array.from({ length: 55 }, (_, i) => ({ action: `n.${i}`, entity: 'thing', businessId: fx.business.id })) })
    const owner = await Client.login('owner')
    const r = await owner.get('/api/admin/audit')
    expect(r.body.entries).toHaveLength(50)
    expect(r.body.nextBefore).toBe(r.body.entries[49].id)
  })

  it('rejects bad input', async () => {
    const owner = await Client.login('owner')
    for (const qs of [
      'from=10-03-2026',
      'from=2026-02-31',
      'to=yesterday',
      'to=2026-13-01',
      'from=2026-03-11&to=2026-03-10',
      'group=bogus',
      'limit=0',
      'limit=201',
      'limit=abc',
      'limit=1.5',
      'before=abc',
      'before=-1',
      `userId=${'x'.repeat(65)}`
    ]) {
      const r = await owner.get(`/api/admin/audit?${qs}`)
      expect(r.status, qs).toBe(400)
      expect(r.body.error.code).toBe('bad_request')
    }
  })

  it('is for owners only', async () => {
    expect((await (await Client.login('cashier')).get('/api/admin/audit')).status).toBe(403)
    expect((await (await Client.login('manager')).get('/api/admin/audit')).status).toBe(403)
    expect((await (await Client.login('owner')).get('/api/admin/audit')).status).toBe(200)
    const anon = await app.request('/api/admin/audit', { headers: { origin: ORIGIN } })
    expect(anon.status).toBe(401)
  })

  it('refuses a console session', async () => {
    await seedPlatform()
    const staff = await consoleLogin('admin@bottlepoint.test')
    expect((await staff.get('/api/admin/audit')).status).toBe(401)
  })

  it('answers 402 when the business is suspended', async () => {
    await suspend(fx.business.id)
    const r = await (await Client.login('owner')).get('/api/admin/audit')
    expect(r.status).toBe(402)
    expect(r.body.error.code).toBe('subscription_suspended')
  })

  it('shows platform rows as Bottle Point support, with nothing about the staff member', async () => {
    const staff = await createPlatformUser(prisma, { name: 'Wanjiru Kamau', email: 'wanjiru@bottlepoint.test', password: CONSOLE_PASSWORD, role: 'SUPPORT' })
    await row({
      action: 'console.subscription_suspended',
      userId: staff.id,
      entity: 'Subscription',
      entityId: 'sub1',
      data: {
        reason: 'Invoice unpaid',
        staffName: 'Wanjiru Kamau',
        by: { id: staff.id, email: 'wanjiru@bottlepoint.test' },
        updatedBy: staff.id,
        note: 'Agreed on a call with wanjiru kamau',
        contactEmail: 'someone@example.com',
        history: ['first', staff.id],
        days: 3
      }
    })
    await row({ action: 'billing.invoice_created', entity: 'Invoice', entityId: 'inv1', data: { number: 'INV-0001', totalCents: 250000, plan: 'test' } })
    // an action name we did not expect, but written by a staff member
    await row({ action: 'business.renamed', userId: staff.id, data: { to: 'Test Wines Ltd' } })
    // notes the staff keep about a client stay inside the console
    await row({ action: 'console.note.added', userId: staff.id, entity: 'TenantNote', entityId: 'n1', data: { body: 'Slow payer, be firm' } })
    await row({ action: 'console.note.deleted', userId: staff.id, entity: 'TenantNote', entityId: 'n1' })

    const owner = await Client.login('owner')
    const r = await owner.get('/api/admin/audit')
    expect(r.body.entries).toHaveLength(3)
    for (const e of r.body.entries) expect(e.actor).toEqual({ id: null, name: 'Bottle Point support' })
    const [renamed, invoice, suspended] = r.body.entries
    expect(suspended.data).toEqual({ reason: 'Invoice unpaid', history: ['first'], days: 3 })
    expect(suspended.summary).toBe('Bottle Point support recorded an activity (console: subscription suspended)')
    expect(invoice.summary).toBe('Bottle Point support issued invoice INV-0001 for KSh 2,500')
    expect(invoice.data).toEqual({ number: 'INV-0001', totalCents: 250000, plan: 'test' })
    expect(renamed.summary).toBe('Bottle Point support recorded an activity (business: renamed)')
    const text = JSON.stringify(r.body).toLowerCase()
    for (const s of [staff.id.toLowerCase(), 'wanjiru', 'kamau', 'example.com', 'slow payer', 'console.note']) expect(text).not.toContain(s)
    expect((await owner.get('/api/admin/audit?group=settings')).body.entries).toHaveLength(3)

    // a billing row written by the owner themself keeps their name
    await row({ action: 'billing.plan_requested', userId: fx.users.owner.id })
    const own = (await owner.get('/api/admin/audit?limit=1')).body.entries[0]
    expect(own.actor).toEqual({ id: fx.users.owner.id, name: 'owner' })
    // the staff id is not a way to find their rows either
    expect((await owner.get(`/api/admin/audit?userId=${staff.id}`)).body).toEqual({ entries: [], nextBefore: null })
  })

  it('shows failed PIN attempts on its own staff only', async () => {
    await secondBusiness()
    await expect(Client.login('cashier', '9999')).rejects.toThrow()
    await expect(Client.login('othercashier', '9999')).rejects.toThrow()
    const owner = await Client.login('owner')
    const r = await owner.get('/api/admin/audit?group=signin')
    expect(actions(r.body)).toEqual(['auth.pin_failed'])
    expect(r.body.entries[0].summary).toBe('Wrong PIN entered for cashier (try 1)')
    expect(r.body.entries[0].actor).toBeNull()
    const r2 = await (await Client.login('owner2')).get('/api/admin/audit')
    expect(r2.body.entries.map((e: any) => e.summary)).toEqual(['Wrong PIN entered for Other Cashier (try 1)'])
  })
})
