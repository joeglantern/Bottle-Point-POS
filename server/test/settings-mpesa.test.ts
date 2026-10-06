import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { createStaff } from '../src/lib/users.js'
import { decryptSecret } from '../src/lib/secrets.js'
import { DarajaClient, getDaraja, resetDarajaCache, setDaraja, setDarajaFetch, stkPassword, type FetchLike } from '../src/lib/daraja.js'
import { mpesaSettings, runMockCallback } from '../src/rules/mpesa.js'
import { resetMpesaTestLimit } from '../src/routes/settings/mpesa.js'
import { Client, PIN, consoleLogin, resetDb, seedFixture, seedPlatform, type Fixture } from './helpers.js'

let fx: Fixture

// secrets of shop A and shop B: none of these may ever leave the server
const A = { consumerKey: 'keyA-0123456789abcd', consumerSecret: 'secretA-zyxwvu9876', passkey: 'passkeyA-bfb279f9aa9b' }
const B = { consumerKey: 'keyB-9876543210wxyz', consumerSecret: 'secretB-abcdef1234', passkey: 'passkeyB-11aa22bb33cc' }
const ALL_SECRETS = [...Object.values(A), ...Object.values(B)]

const sandboxA = { enabled: true, mode: 'SANDBOX', shortcode: '111111', transactionType: 'CustomerPayBillOnline', ...A }
const productionB = { enabled: true, mode: 'PRODUCTION', shortcode: '222222', partyB: '5123456', transactionType: 'CustomerBuyGoodsOnline', ...B }
const mockOn = { enabled: true, mode: 'MOCK', transactionType: 'CustomerPayBillOnline' }

const PHONE = '0712345678'

// everything the API answered in a test, scanned for secrets at the end
let seen: string[] = []
const note = <T>(r: T) => {
  seen.push(JSON.stringify(r))
  return r
}

beforeAll(() => {
  mpesaSettings.mockDelayMs = 0
})

beforeEach(async () => {
  setDaraja(null)
  setDarajaFetch(null)
  resetMpesaTestLimit()
  seen = []
  await resetDb()
  fx = await seedFixture()
})

afterEach(async () => {
  // no secret in any response, and none in the audit trail
  const rows = await prisma.auditLog.findMany()
  const audit = JSON.stringify(rows.map(r => ({ action: r.action, entity: r.entity, entityId: r.entityId, data: r.data })))
  for (const s of ALL_SECRETS) {
    expect(audit).not.toContain(s)
    for (const body of seen) expect(body).not.toContain(s)
  }
  setDaraja(null)
  setDarajaFetch(null)
  resetDarajaCache()
})

// A second, unrelated shop.
async function secondBusiness() {
  const business = await prisma.business.create({ data: { name: 'Other Spirits' } })
  const branch = await prisma.branch.create({ data: { businessId: business.id, name: 'Karen' } })
  const mk = (username: string, role: 'CASHIER' | 'MANAGER' | 'OWNER', branchIds: string[]) =>
    createStaff(prisma, { businessId: business.id, name: username, username, pin: PIN, role, branchIds })
  const owner = await mk('otherowner', 'OWNER', [])
  const manager = await mk('othermanager', 'MANAGER', [branch.id])
  const cashier = await mk('othercashier', 'CASHIER', [branch.id])
  const product = await prisma.product.create({ data: { businessId: business.id, name: 'Konyagi', barcode: '6009000000011', priceCents: 90000, category: 'Gin', sizeMl: 750 } })
  await prisma.stock.create({ data: { branchId: branch.id, productId: product.id, qty: 20 } })
  return { business, branch, owner, manager, cashier, product }
}

async function makeSale(branchId: string, createdById: string, product: { id: string; name: string; priceCents: number }) {
  const b = await prisma.branch.update({ where: { id: branchId }, data: { nextSaleNo: { increment: 1 } } })
  return prisma.sale.create({
    data: {
      number: b.nextSaleNo - 1,
      branchId,
      createdById,
      status: 'SAVED',
      subtotalCents: product.priceCents,
      totalCents: product.priceCents,
      lines: { create: [{ productId: product.id, name: product.name, unitCents: product.priceCents, qty: 1 }] }
    }
  })
}
const saleA = () => makeSale(fx.branches.west.id, fx.users.cashier.id, fx.products.whisky)

// A pretend Safaricom that answers every call and remembers what it was sent.
function fakeSafaricom(opts: { oauthStatus?: number; offline?: boolean } = {}) {
  const calls: { url: string; auth: string; body: any }[] = []
  let n = 0
  const fn: FetchLike = async (url, init) => {
    const auth = String((init.headers as Record<string, string> | undefined)?.authorization ?? '')
    calls.push({ url, auth, body: init.body ? JSON.parse(String(init.body)) : null })
    if (opts.offline) throw new Error('offline')
    if (url.includes('/oauth/')) {
      if (opts.oauthStatus && opts.oauthStatus !== 200) return new Response('{}', { status: opts.oauthStatus })
      const key = Buffer.from(auth.replace('Basic ', ''), 'base64').toString().split(':')[0]
      return new Response(JSON.stringify({ access_token: `AT-${key}`, expires_in: '3599' }), { status: 200 })
    }
    if (url.includes('/stkpushquery/')) {
      return new Response(JSON.stringify({ ResponseCode: '0', ResultCode: '1032', ResultDesc: 'Request cancelled by user.' }), { status: 200 })
    }
    n += 1
    return new Response(JSON.stringify({ MerchantRequestID: `MR${n}`, CheckoutRequestID: `ws_CO_live_${n}`, ResponseCode: '0', CustomerMessage: 'ok' }), { status: 200 })
  }
  const oauth = () => calls.filter(c => c.url.includes('/oauth/'))
  const pushes = () => calls.filter(c => c.url.includes('/stkpush/'))
  const queries = () => calls.filter(c => c.url.includes('/stkpushquery/'))
  return { fn, calls, oauth, pushes, queries }
}
const basic = (s: { consumerKey: string; consumerSecret: string }) => 'Basic ' + Buffer.from(`${s.consumerKey}:${s.consumerSecret}`).toString('base64')

const ROUTES: [string, string, unknown?][] = [
  ['GET', '/api/admin/mpesa'],
  ['PUT', '/api/admin/mpesa', mockOn],
  ['DELETE', '/api/admin/mpesa/secrets'],
  ['POST', '/api/admin/mpesa/test', {}]
]

describe('M-Pesa settings: read and save', () => {
  it('a shop with nothing saved uses the platform settings', async () => {
    const owner = await Client.login('owner')
    const r = note(await owner.get('/api/admin/mpesa'))
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      config: {
        enabled: false, mode: 'MOCK', shortcode: null, partyB: null, transactionType: 'CustomerPayBillOnline',
        consumerKeyHint: null, consumerSecretHint: null, passkeyHint: null, updatedAt: null, usingPlatformDefault: true
      }
    })
  })

  it('saves settings, stores the keys encrypted and shows only hints', async () => {
    const owner = await Client.login('owner')
    const r = note(await owner.put('/api/admin/mpesa', sandboxA))
    expect(r.status).toBe(200)
    expect(r.body.config).toMatchObject({
      enabled: true, mode: 'SANDBOX', shortcode: '111111', partyB: null, transactionType: 'CustomerPayBillOnline',
      consumerKeyHint: '••••abcd', consumerSecretHint: '••••9876', passkeyHint: '••••aa9b', usingPlatformDefault: false
    })
    expect(Object.keys(r.body.config).sort()).toEqual([
      'consumerKeyHint', 'consumerSecretHint', 'enabled', 'mode', 'partyB', 'passkeyHint', 'shortcode', 'transactionType', 'updatedAt', 'usingPlatformDefault'
    ])
    expect(typeof r.body.config.updatedAt).toBe('string')
    expect(note(await owner.get('/api/admin/mpesa')).body).toEqual(r.body)

    const row = await prisma.mpesaConfig.findUniqueOrThrow({ where: { businessId: fx.business.id } })
    expect(row.updatedById).toBe(fx.users.owner.id)
    for (const [enc, plain] of [[row.consumerKeyEnc, A.consumerKey], [row.consumerSecretEnc, A.consumerSecret], [row.passkeyEnc, A.passkey]] as const) {
      expect(enc!.startsWith('v1.')).toBe(true)
      expect(enc).not.toContain(plain)
      expect(decryptSecret(enc!)).toBe(plain)
    }

    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'mpesa.config_updated' } })
    expect([log.businessId, log.userId, log.entity, log.entityId]).toEqual([fx.business.id, fx.users.owner.id, 'MpesaConfig', fx.business.id])
    expect(log.data).toEqual({ changed: ['enabled', 'mode', 'shortcode', 'consumerKey', 'consumerSecret', 'passkey'] })
  })

  it('secrets left out (or sent empty) keep the stored ones', async () => {
    const owner = await Client.login('owner')
    note(await owner.put('/api/admin/mpesa', sandboxA))
    const before = await prisma.mpesaConfig.findUniqueOrThrow({ where: { businessId: fx.business.id } })
    const r = note(await owner.put('/api/admin/mpesa', {
      enabled: true, mode: 'PRODUCTION', shortcode: '333333', transactionType: 'CustomerPayBillOnline', consumerKey: '', consumerSecret: null
    }))
    expect(r.status).toBe(200)
    expect(r.body.config).toMatchObject({ mode: 'PRODUCTION', shortcode: '333333', consumerKeyHint: '••••abcd', passkeyHint: '••••aa9b' })
    const after = await prisma.mpesaConfig.findUniqueOrThrow({ where: { businessId: fx.business.id } })
    expect([after.consumerKeyEnc, after.consumerSecretEnc, after.passkeyEnc]).toEqual([before.consumerKeyEnc, before.consumerSecretEnc, before.passkeyEnc])
    const logs = await prisma.auditLog.findMany({ where: { action: 'mpesa.config_updated' }, orderBy: { id: 'asc' } })
    expect(logs[1]!.data).toEqual({ changed: ['mode', 'shortcode'] })

    // one new secret replaces only that one
    note(await owner.put('/api/admin/mpesa', { ...r.body.config, passkey: 'a-new-passkey-7777' }))
    const last = await prisma.mpesaConfig.findUniqueOrThrow({ where: { businessId: fx.business.id } })
    expect(decryptSecret(last.passkeyEnc!)).toBe('a-new-passkey-7777')
    expect(last.consumerKeyEnc).toBe(before.consumerKeyEnc)
  })

  it('rejects bad input with 400', async () => {
    const owner = await Client.login('owner')
    const ok = { enabled: false, mode: 'MOCK', shortcode: '174379', transactionType: 'CustomerPayBillOnline' }
    const bad: Record<string, unknown>[] = [
      { ...ok, enabled: 'yes' },
      { mode: 'MOCK', transactionType: 'CustomerPayBillOnline' },
      { ...ok, mode: 'LIVE' },
      { ...ok, mode: 'sandbox' },
      { enabled: false, transactionType: 'CustomerPayBillOnline' },
      { ...ok, shortcode: '1234' },
      { ...ok, shortcode: '12345678' },
      { ...ok, shortcode: '12a456' },
      { ...ok, shortcode: 174379 },
      { ...ok, partyB: '12' },
      { ...ok, partyB: 'till-one' },
      { ...ok, transactionType: 'CustomerPayBill' },
      { enabled: false, mode: 'MOCK' },
      { ...ok, consumerKey: 'x'.repeat(501) },
      { ...ok, passkey: 42 }
    ]
    for (const b of bad) {
      const r = note(await owner.put('/api/admin/mpesa', b))
      expect([JSON.stringify(b), r.status]).toEqual([JSON.stringify(b), 400])
    }
    expect(await prisma.mpesaConfig.count()).toBe(0)
    // the edges that are allowed
    for (const shortcode of ['12345', '1234567']) {
      expect(note(await owner.put('/api/admin/mpesa', { ...ok, shortcode })).status).toBe(200)
    }
  })

  it('a live mode cannot be turned on until everything it needs is there', async () => {
    const owner = await Client.login('owner')
    const base = { enabled: true, mode: 'SANDBOX', transactionType: 'CustomerPayBillOnline' }
    const none = note(await owner.put('/api/admin/mpesa', base))
    expect([none.status, none.body.error.code]).toEqual([422, 'mpesa_incomplete'])
    expect(none.body.error.details).toEqual({ missing: ['shortcode', 'consumerKey', 'consumerSecret', 'passkey'] })
    expect(none.body.error.message).toContain('passkey')

    const some = note(await owner.put('/api/admin/mpesa', { ...base, mode: 'PRODUCTION', shortcode: '111111', consumerKey: A.consumerKey }))
    expect(some.body.error.details).toEqual({ missing: ['consumerSecret', 'passkey'] })
    expect(await prisma.mpesaConfig.count()).toBe(0)

    // saved while off, then turned on with the stored secrets
    expect(note(await owner.put('/api/admin/mpesa', { ...sandboxA, enabled: false })).status).toBe(200)
    const on = note(await owner.put('/api/admin/mpesa', { ...base, shortcode: '111111' }))
    expect([on.status, on.body.config.enabled]).toEqual([200, true])
    // but not without the shortcode
    const noCode = note(await owner.put('/api/admin/mpesa', base))
    expect(noCode.body.error.details).toEqual({ missing: ['shortcode'] })

    // a simulation needs nothing
    expect(note(await owner.put('/api/admin/mpesa', mockOn)).status).toBe(200)
  })

  it('Buy Goods needs the till number', async () => {
    const owner = await Client.login('owner')
    const r = note(await owner.put('/api/admin/mpesa', { ...productionB, partyB: undefined }))
    expect([r.status, r.body.error.code]).toEqual([422, 'party_b_required'])
    const ok = note(await owner.put('/api/admin/mpesa', productionB))
    expect([ok.status, ok.body.config.partyB, ok.body.config.transactionType]).toEqual([200, '5123456', 'CustomerBuyGoodsOnline'])
  })

  it('two first saves at once both land on one row', async () => {
    const owner = await Client.login('owner')
    const [r1, r2] = await Promise.all([
      owner.put('/api/admin/mpesa', { ...sandboxA, shortcode: '111111' }),
      owner.put('/api/admin/mpesa', { ...sandboxA, shortcode: '444444' })
    ])
    note([r1, r2])
    expect([r1.status, r2.status]).toEqual([200, 200])
    expect(await prisma.mpesaConfig.count()).toBe(1)
    expect(await prisma.auditLog.count({ where: { action: 'mpesa.config_updated' } })).toBe(2)
    const row = await prisma.mpesaConfig.findUniqueOrThrow({ where: { businessId: fx.business.id } })
    expect(['111111', '444444']).toContain(row.shortcode)
  })

  it('deleting the secrets wipes them and turns the settings off', async () => {
    const owner = await Client.login('owner')
    // nothing saved: still fine
    expect(note(await owner.del('/api/admin/mpesa/secrets')).body.config.usingPlatformDefault).toBe(true)
    expect(await prisma.mpesaConfig.count()).toBe(0)

    note(await owner.put('/api/admin/mpesa', sandboxA))
    const r = note(await owner.del('/api/admin/mpesa/secrets'))
    expect(r.status).toBe(200)
    expect(r.body.config).toMatchObject({
      enabled: false, mode: 'SANDBOX', shortcode: '111111', consumerKeyHint: null, consumerSecretHint: null, passkeyHint: null, usingPlatformDefault: true
    })
    const row = await prisma.mpesaConfig.findUniqueOrThrow({ where: { businessId: fx.business.id } })
    expect([row.enabled, row.consumerKeyEnc, row.consumerSecretEnc, row.passkeyEnc]).toEqual([false, null, null, null])
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'mpesa.secrets_deleted' } })
    expect([log.businessId, log.entityId, log.data]).toEqual([fx.business.id, fx.business.id, { wasEnabled: true }])
    // and it cannot be turned back on without new keys
    expect(note(await owner.put('/api/admin/mpesa', { enabled: true, mode: 'SANDBOX', shortcode: '111111', transactionType: 'CustomerPayBillOnline' })).status).toBe(422)
  })
})

describe('M-Pesa settings: who may call', () => {
  it('owner only', async () => {
    for (const who of ['cashier', 'manager']) {
      const c = await Client.login(who)
      for (const [method, path, json] of ROUTES) {
        expect([who, method, path, (await c.req(method, path, json)).status]).toEqual([who, method, path, 403])
      }
    }
    const owner = await Client.login('owner')
    for (const [method, path, json] of ROUTES) expect((await owner.req(method, path, json)).status).toBe(200)
  })

  it('no session and a console session get 401', async () => {
    const p = await seedPlatform()
    const admin = await consoleLogin(p.admin.email)
    for (const [method, path, json] of ROUTES) {
      expect((await new Client().req(method, path, json)).status).toBe(401)
      expect((await admin.req(method, path, json)).status).toBe(401)
    }
  })

  it('a suspended shop gets 402', async () => {
    const owner = await Client.login('owner')
    const plan = await prisma.plan.create({ data: { code: 'test', name: 'Test', model: 'FLAT', priceCents: 250000 } })
    const now = new Date()
    await prisma.subscription.create({
      data: { businessId: fx.business.id, planId: plan.id, status: 'SUSPENDED', currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * 86400000) }
    })
    for (const [method, path, json] of ROUTES) expect((await owner.req(method, path, json)).status).toBe(402)
  })

  it('one shop never sees or changes another shop settings', async () => {
    const other = await secondBusiness()
    const ownerA = await Client.login('owner')
    const ownerB = await Client.login('otherowner')
    note(await ownerA.put('/api/admin/mpesa', sandboxA))
    const rowA = await prisma.mpesaConfig.findUniqueOrThrow({ where: { businessId: fx.business.id } })

    const seenByB = note(await ownerB.get('/api/admin/mpesa'))
    expect(seenByB.body.config).toMatchObject({ enabled: false, shortcode: null, consumerKeyHint: null, usingPlatformDefault: true })

    note(await ownerB.put('/api/admin/mpesa', productionB))
    note(await ownerB.del('/api/admin/mpesa/secrets'))
    expect(await prisma.mpesaConfig.findUniqueOrThrow({ where: { businessId: fx.business.id } })).toEqual(rowA)
    const rowB = await prisma.mpesaConfig.findUniqueOrThrow({ where: { businessId: other.business.id } })
    expect([rowB.enabled, rowB.shortcode, rowB.consumerKeyEnc]).toEqual([false, '222222', null])
    expect(note(await ownerA.get('/api/admin/mpesa')).body.config).toMatchObject({ enabled: true, shortcode: '111111', consumerKeyHint: '••••abcd' })

    // each audit row belongs to the shop that acted
    const logs = await prisma.auditLog.findMany({ where: { action: { startsWith: 'mpesa.' } } })
    expect(logs.filter(l => l.businessId === fx.business.id).map(l => l.action)).toEqual(['mpesa.config_updated'])
    expect(logs.filter(l => l.businessId === other.business.id).map(l => l.action).sort()).toEqual(['mpesa.config_updated', 'mpesa.secrets_deleted'])
  })
})

describe('M-Pesa settings: connection test', () => {
  it('nothing saved, and simulation', async () => {
    const owner = await Client.login('owner')
    const f = fakeSafaricom()
    setDarajaFetch(f.fn)
    const none = note(await owner.post('/api/admin/mpesa/test'))
    expect([none.status, none.body.ok]).toEqual([200, false])
    note(await owner.put('/api/admin/mpesa', mockOn))
    const mock = note(await owner.post('/api/admin/mpesa/test'))
    expect([mock.status, mock.body.ok]).toEqual([200, true])
    expect(mock.body.message).toContain('simulation')
    expect(f.calls).toHaveLength(0)
  })

  it('good keys pass, in the stored mode, even while the settings are off', async () => {
    const owner = await Client.login('owner')
    const f = fakeSafaricom()
    setDarajaFetch(f.fn)
    note(await owner.put('/api/admin/mpesa', { ...sandboxA, enabled: false }))
    const r = note(await owner.post('/api/admin/mpesa/test'))
    expect(r.body).toEqual({ ok: true, message: expect.stringContaining('sandbox') })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.url).toBe('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials')
    expect(f.calls[0]!.auth).toBe(basic(A))

    note(await owner.put('/api/admin/mpesa', { ...sandboxA, mode: 'PRODUCTION' }))
    expect(note(await owner.post('/api/admin/mpesa/test')).body.ok).toBe(true)
    expect(f.calls[1]!.url.startsWith('https://api.safaricom.co.ke/oauth/')).toBe(true)
  })

  it('refused keys, a dead network, missing and unreadable keys are failed tests, not errors', async () => {
    const owner = await Client.login('owner')
    note(await owner.put('/api/admin/mpesa', sandboxA))

    setDarajaFetch(fakeSafaricom({ oauthStatus: 400 }).fn)
    const refused = note(await owner.post('/api/admin/mpesa/test'))
    expect([refused.status, refused.body.ok]).toEqual([200, false])
    expect(refused.body.message).toContain('refused')

    setDarajaFetch(fakeSafaricom({ offline: true }).fn)
    const offline = note(await owner.post('/api/admin/mpesa/test'))
    expect([offline.status, offline.body.ok]).toEqual([200, false])
    expect(offline.body.message).toContain('Could not reach M-Pesa')

    const f = fakeSafaricom()
    setDarajaFetch(f.fn)
    await prisma.mpesaConfig.update({ where: { businessId: fx.business.id }, data: { consumerSecretEnc: 'v1.AAAA.BBBB.CCCC' } })
    const broken = note(await owner.post('/api/admin/mpesa/test'))
    expect([broken.status, broken.body.ok]).toEqual([200, false])
    expect(broken.body.message).toContain('not set up correctly')

    note(await owner.del('/api/admin/mpesa/secrets'))
    const missing = note(await owner.post('/api/admin/mpesa/test'))
    expect([missing.status, missing.body.ok]).toEqual([200, false])
    expect(missing.body.message).toContain('consumerKey')
    expect(f.calls).toHaveLength(0)
  })

  it('five tests a minute per shop, then 429', async () => {
    await secondBusiness()
    const owner = await Client.login('owner')
    const ownerB = await Client.login('otherowner')
    note(await owner.put('/api/admin/mpesa', mockOn))
    for (let i = 0; i < 5; i++) expect((await owner.post('/api/admin/mpesa/test')).status).toBe(200)
    const r = note(await owner.post('/api/admin/mpesa/test'))
    expect([r.status, r.body.error.code]).toEqual([429, 'rate_limited'])
    // the other shop has its own allowance
    expect((await ownerB.post('/api/admin/mpesa/test')).status).toBe(200)
  })
})

describe('the till uses the M-Pesa settings of its own shop', () => {
  it('each shop is sent with its own keys, shortcode and token', async () => {
    const other = await secondBusiness()
    const f = fakeSafaricom()
    setDarajaFetch(f.fn)
    note(await (await Client.login('owner')).put('/api/admin/mpesa', sandboxA))
    note(await (await Client.login('otherowner')).put('/api/admin/mpesa', productionB))
    const cashierA = await Client.login('cashier')
    const cashierB = await Client.login('othercashier')

    const a1 = note(await cashierA.post('/api/mpesa/stk', { saleId: (await saleA()).id, phone: PHONE }))
    const b1 = note(await cashierB.post('/api/mpesa/stk', { saleId: (await makeSale(other.branch.id, other.cashier.id, other.product)).id, phone: PHONE }))
    expect([a1.status, b1.status]).toEqual([200, 200])

    expect(f.oauth().map(c => [new URL(c.url).host, c.auth])).toEqual([
      ['sandbox.safaricom.co.ke', basic(A)],
      ['api.safaricom.co.ke', basic(B)]
    ])
    const [pa, pb] = f.pushes()
    expect([new URL(pa!.url).host, pa!.auth]).toEqual(['sandbox.safaricom.co.ke', `Bearer AT-${A.consumerKey}`])
    expect(pa!.body).toMatchObject({ BusinessShortCode: '111111', PartyB: '111111', TransactionType: 'CustomerPayBillOnline', Amount: 4800 })
    expect(pa!.body.Password).toBe(stkPassword('111111', A.passkey, pa!.body.Timestamp))
    expect([new URL(pb!.url).host, pb!.auth]).toEqual(['api.safaricom.co.ke', `Bearer AT-${B.consumerKey}`])
    expect(pb!.body).toMatchObject({ BusinessShortCode: '222222', PartyB: '5123456', TransactionType: 'CustomerBuyGoodsOnline', Amount: 900 })
    expect(pb!.body.Password).toBe(stkPassword('222222', B.passkey, pb!.body.Timestamp))
    // nothing of A went out with B, and the reverse
    const sentForB = JSON.stringify(f.calls.filter(c => c.url.includes('api.safaricom')))
    const sentForA = JSON.stringify(f.calls.filter(c => c.url.includes('sandbox.safaricom')))
    expect(sentForB).not.toContain('111111')
    expect(sentForB).not.toContain(Buffer.from(A.consumerKey).toString('base64').slice(0, 12))
    expect(sentForA).not.toContain('222222')

    // the status question goes out with the same shop's settings
    const q = note(await cashierA.post(`/api/mpesa/requests/${a1.body.request.id}/query`))
    expect([q.status, q.body.request.status]).toEqual([200, 'CANCELLED'])
    expect(f.queries()).toHaveLength(1)
    expect(f.queries()[0]!.auth).toBe(`Bearer AT-${A.consumerKey}`)
    expect(f.queries()[0]!.body).toMatchObject({ BusinessShortCode: '111111', CheckoutRequestID: a1.body.request.checkoutRequestId })
    // the token was reused: still one sign in per shop
    expect(f.oauth()).toHaveLength(2)
  })

  it('new keys are never served a token from the old ones', async () => {
    const f = fakeSafaricom()
    setDarajaFetch(f.fn)
    const owner = await Client.login('owner')
    const cashier = await Client.login('cashier')
    note(await owner.put('/api/admin/mpesa', sandboxA))
    expect((await cashier.post('/api/mpesa/stk', { saleId: (await saleA()).id, phone: PHONE })).status).toBe(200)
    expect((await cashier.post('/api/mpesa/stk', { saleId: (await saleA()).id, phone: PHONE })).status).toBe(200)
    expect(f.oauth()).toHaveLength(1)

    note(await owner.put('/api/admin/mpesa', { ...sandboxA, consumerKey: 'rotated-key-5555', consumerSecret: undefined, passkey: undefined }))
    expect((await cashier.post('/api/mpesa/stk', { saleId: (await saleA()).id, phone: PHONE })).status).toBe(200)
    expect(f.oauth()).toHaveLength(2)
    expect(f.oauth()[1]!.auth).toBe(basic({ consumerKey: 'rotated-key-5555', consumerSecret: A.consumerSecret }))
    expect(f.pushes()[2]!.auth).toBe('Bearer AT-rotated-key-5555')

    // a mode change signs in again too
    note(await owner.put('/api/admin/mpesa', { ...sandboxA, mode: 'PRODUCTION', consumerKey: undefined, consumerSecret: undefined, passkey: undefined }))
    expect((await cashier.post('/api/mpesa/stk', { saleId: (await saleA()).id, phone: PHONE })).status).toBe(200)
    expect(new URL(f.oauth()[2]!.url).host).toBe('api.safaricom.co.ke')
  })

  it('no settings, or settings turned off, fall back to the server wide client', async () => {
    const f = fakeSafaricom()
    setDarajaFetch(f.fn)
    const owner = await Client.login('owner')
    const cashier = await Client.login('cashier')
    const r1 = await cashier.post('/api/mpesa/stk', { saleId: (await saleA()).id, phone: PHONE })
    expect(r1.body.request.checkoutRequestId).toMatch(/^ws_CO_mock_/)
    expect(getDaraja().mockState.has(r1.body.request.checkoutRequestId)).toBe(true)

    note(await owner.put('/api/admin/mpesa', { ...sandboxA, enabled: false }))
    const r2 = await cashier.post('/api/mpesa/stk', { saleId: (await saleA()).id, phone: PHONE })
    expect(r2.body.request.checkoutRequestId).toMatch(/^ws_CO_mock_/)
    expect(f.calls).toHaveLength(0)

    // and the swapped in server wide client is the one used
    const env = fakeSafaricom()
    setDaraja(new DarajaClient({ ...getDaraja().cfg, mode: 'sandbox', consumerKey: 'envkey', consumerSecret: 'envsecret', passkey: 'envpass', shortcode: '174379' }, env.fn))
    const r3 = await cashier.post('/api/mpesa/stk', { saleId: (await saleA()).id, phone: PHONE })
    expect(r3.status).toBe(200)
    expect(env.oauth()[0]!.auth).toBe(basic({ consumerKey: 'envkey', consumerSecret: 'envsecret' }))
    expect(env.pushes()[0]!.body.BusinessShortCode).toBe('174379')
    expect(f.calls).toHaveLength(0)
  })

  it('one shop can run a simulation while the server is live', async () => {
    const other = await secondBusiness()
    const env = fakeSafaricom()
    setDaraja(new DarajaClient({ ...getDaraja().cfg, mode: 'sandbox', consumerKey: 'envkey', consumerSecret: 'envsecret', passkey: 'envpass' }, env.fn))
    note(await (await Client.login('owner')).put('/api/admin/mpesa', mockOn))
    const cashier = await Client.login('cashier')
    const manager = await Client.login('manager')

    const sale = await saleA()
    const r = await cashier.post('/api/mpesa/stk', { saleId: sale.id, phone: PHONE })
    expect(r.body.request.checkoutRequestId).toMatch(/^ws_CO_mock_/)
    expect(env.calls).toHaveLength(0)
    // the planned mock answer arrives and pays the sale
    await runMockCallback(r.body.request.checkoutRequestId)
    expect((await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PAID')

    // the demo button works for this shop only
    const r2 = await cashier.post('/api/mpesa/stk', { saleId: (await saleA()).id, phone: '0712345222' })
    const sim = await manager.post(`/api/mpesa/requests/${r2.body.request.id}/simulate`, { outcome: 'cancelled' })
    expect([sim.status, sim.body.request.status]).toEqual([200, 'CANCELLED'])

    const rb = await (await Client.login('othercashier')).post('/api/mpesa/stk', { saleId: (await makeSale(other.branch.id, other.cashier.id, other.product)).id, phone: PHONE })
    expect(rb.body.request.checkoutRequestId).toMatch(/^ws_CO_live_/)
    const simB = await (await Client.login('othermanager')).post(`/api/mpesa/requests/${rb.body.request.id}/simulate`, { outcome: 'success' })
    expect(simB.status).toBe(404)
  })

  it('unreadable keys give the cashier a clear 502, never a crash', async () => {
    const f = fakeSafaricom()
    setDarajaFetch(f.fn)
    const owner = await Client.login('owner')
    const cashier = await Client.login('cashier')
    note(await owner.put('/api/admin/mpesa', sandboxA))
    const good = await cashier.post('/api/mpesa/stk', { saleId: (await saleA()).id, phone: PHONE })
    expect(good.status).toBe(200)

    await prisma.mpesaConfig.update({ where: { businessId: fx.business.id }, data: { passkeyEnc: 'not-a-secret' } })
    const sale = await saleA()
    const r = note(await cashier.post('/api/mpesa/stk', { saleId: sale.id, phone: PHONE }))
    expect([r.status, r.body.error.code]).toEqual([502, 'mpesa_misconfigured'])
    expect(r.body.error.message).toBe('M-Pesa is not set up correctly, ask the owner to check the settings.')
    const req = await prisma.mpesaRequest.findFirstOrThrow({ where: { saleId: sale.id } })
    expect([req.status, req.resultDesc]).toEqual(['FAILED', r.body.error.message])
    expect(f.pushes()).toHaveLength(1)

    // the owner can still open the settings and fix them
    const g = note(await owner.get('/api/admin/mpesa'))
    expect([g.status, g.body.config.passkeyHint, g.body.config.consumerKeyHint]).toEqual([200, null, '••••abcd'])
    note(await owner.put('/api/admin/mpesa', { ...sandboxA, consumerKey: undefined, consumerSecret: undefined }))
    expect((await cashier.post('/api/mpesa/stk', { saleId: sale.id, phone: PHONE })).status).toBe(200)
  })
})
