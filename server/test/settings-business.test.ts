import { beforeEach, describe, expect, it } from 'vitest'
import { app, Client, consoleLogin, ORIGIN, PIN, resetDb, seedFixture, seedPlatform, type Fixture } from './helpers.js'
import { prisma } from '../src/db.js'
import { createStaff } from '../src/lib/users.js'
import { vatIncludedCents } from '../src/routes/sales.js'

let fx: Fixture
let owner: Client
let manager: Client
let cashier: Client

beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
  owner = await Client.login('owner', PIN, fx.branches.west.id)
  manager = await Client.login('manager')
  cashier = await Client.login('cashier')
})

const PATH = '/api/admin/business'
const KEYS = ['address', 'email', 'id', 'kraPin', 'legalName', 'name', 'phone', 'receiptFooter', 'vatRateBps']

const FULL = {
  name: 'Bottle Point Westlands',
  legalName: 'Bottle Point Limited',
  email: 'hello@bottlepoint.co.ke',
  phone: '020 765 4321',
  address: 'Woodvale Grove, Westlands, Nairobi',
  kraPin: 'P051234567X',
  receiptFooter: 'Asante. Drink responsibly.',
  vatRateBps: 1600
}

const dbBusiness = (id = fx.business.id) => prisma.business.findUniqueOrThrow({ where: { id } })
const audits = (businessId = fx.business.id) =>
  prisma.auditLog.findMany({ where: { action: 'business.updated', businessId }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })

// A second, unrelated shop with its own details, owner, product and stock.
async function secondBusiness() {
  const business = await prisma.business.create({
    data: {
      name: 'Other Spirits',
      legalName: 'Other Spirits Limited',
      email: 'other@spirits.test',
      phone: '0733 000 111',
      address: 'Moi Avenue, Mombasa',
      kraPin: 'B999999999B',
      receiptFooter: 'Karibu tena',
      vatRateBps: 800
    }
  })
  const branch = await prisma.branch.create({ data: { businessId: business.id, name: 'Mombasa' } })
  await createStaff(prisma, { businessId: business.id, name: 'owner2', username: 'owner2', pin: PIN, role: 'OWNER', branchIds: [] })
  const product = await prisma.product.create({ data: { businessId: business.id, name: 'Kenya Cane', priceCents: 108000, category: 'Spirit', sizeMl: 750 } })
  await prisma.stock.create({ data: { branchId: branch.id, productId: product.id, qty: 50 } })
  return { business, branch, product, owner: await Client.login('owner2') }
}

async function setSubscription(businessId: string, status: 'SUSPENDED' | 'CANCELLED' | 'ACTIVE') {
  const plan = await prisma.plan.create({ data: { code: `test-${status}`, name: 'Test', model: 'FLAT', priceCents: 250000 } })
  await prisma.subscription.create({
    data: { businessId, planId: plan.id, status, currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) }
  })
}

let refNo = 0
// Sell one unit of a product and pay it in full by M-Pesa (no shift needed).
async function paidSale(c: Client, productId: string) {
  const s = await c.post('/api/sales', { lines: [{ productId, qty: 1 }] })
  expect(s.status).toBe(201)
  const sale = s.body.sale
  const ref = `VAT${String(++refNo).padStart(7, '0')}`
  const p = await c.post(`/api/sales/${sale.id}/pay`, { payments: [{ method: 'MPESA', amountCents: sale.totalCents, mpesaRef: ref }] })
  expect(p.status).toBe(200)
  return sale
}

async function productAt(priceCents: number) {
  const p = await prisma.product.create({ data: { businessId: fx.business.id, name: `Bottle ${priceCents}`, priceCents, category: 'Wine', sizeMl: 750 } })
  await prisma.stock.create({ data: { branchId: fx.branches.west.id, productId: p.id, qty: 50 } })
  return p
}

describe('GET /api/admin/business', () => {
  it('returns the business with defaults and nothing else', async () => {
    const r = await owner.get(PATH)
    expect(r.status).toBe(200)
    expect(Object.keys(r.body)).toEqual(['business'])
    expect(Object.keys(r.body.business).sort()).toEqual(KEYS)
    expect(r.body.business).toEqual({
      id: fx.business.id,
      name: 'Test Wines',
      legalName: null,
      email: null,
      phone: null,
      address: null,
      kraPin: null,
      receiptFooter: null,
      vatRateBps: 1600
    })
  })

  it('managers and owners may read, cashiers may not', async () => {
    expect((await manager.get(PATH)).status).toBe(200)
    expect((await owner.get(PATH)).status).toBe(200)
    const r = await cashier.get(PATH)
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('forbidden')
  })

  it('needs a shop session: nobody and console staff get 401', async () => {
    expect((await new Client().get(PATH)).status).toBe(401)
    await seedPlatform()
    const admin = await consoleLogin('admin@bottlepoint.test')
    expect((await admin.get(PATH)).status).toBe(401)
    expect((await admin.patch(PATH, { name: 'Taken Over' })).status).toBe(401)
    expect((await dbBusiness()).name).toBe('Test Wines')
  })

  it('each owner only ever sees their own business', async () => {
    const other = await secondBusiness()
    const r = await other.owner.get(PATH)
    expect(r.status).toBe(200)
    expect(r.body.business).toMatchObject({ id: other.business.id, name: 'Other Spirits', kraPin: 'B999999999B', vatRateBps: 800 })
    expect((await owner.get(PATH)).body.business).toMatchObject({ id: fx.business.id, name: 'Test Wines', kraPin: null, vatRateBps: 1600 })
  })
})

describe('PATCH /api/admin/business', () => {
  it('saves every field, trimmed, with the KRA PIN upper cased', async () => {
    const r = await owner.patch(PATH, {
      name: '  Bottle Point Westlands ',
      legalName: ' Bottle Point Limited ',
      email: ' hello@bottlepoint.co.ke ',
      phone: ' 020 765 4321 ',
      address: ' Woodvale Grove, Westlands, Nairobi ',
      kraPin: ' p051234567x ',
      receiptFooter: ' Asante. Drink responsibly. ',
      vatRateBps: 0
    })
    expect(r.status).toBe(200)
    expect(Object.keys(r.body.business).sort()).toEqual(KEYS)
    expect(r.body.business).toEqual({ id: fx.business.id, ...FULL, vatRateBps: 0 })
    expect((await owner.get(PATH)).body.business).toEqual(r.body.business)
    expect(await dbBusiness()).toMatchObject({ ...FULL, vatRateBps: 0, currency: 'KES' })

    const log = await audits()
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ userId: fx.users.owner.id, entity: 'business', entityId: fx.business.id })
    const data = log[0]!.data as any
    expect([...data.fields].sort()).toEqual(['address', 'email', 'kraPin', 'legalName', 'name', 'phone', 'receiptFooter', 'vatRateBps'])
    expect(data.from).toMatchObject({ name: 'Test Wines', kraPin: null, vatRateBps: 1600 })
    expect(data.to).toMatchObject({ name: 'Bottle Point Westlands', kraPin: 'P051234567X', vatRateBps: 0 })
  })

  it('changes only what was sent', async () => {
    await owner.patch(PATH, FULL)
    const r = await owner.patch(PATH, { phone: '0712 345 678' })
    expect(r.status).toBe(200)
    expect(r.body.business).toEqual({ id: fx.business.id, ...FULL, phone: '0712 345 678' })
    const log = await audits()
    expect(log).toHaveLength(2)
    expect(log[1]!.data).toEqual({ fields: ['phone'], from: { phone: '020 765 4321' }, to: { phone: '0712 345 678' } })
  })

  it('empty strings (and null) clear a field, but never the name', async () => {
    await owner.patch(PATH, FULL)
    const r = await owner.patch(PATH, { legalName: '', email: '  ', phone: '', address: '', kraPin: '', receiptFooter: null })
    expect(r.status).toBe(200)
    expect(r.body.business).toEqual({
      id: fx.business.id,
      name: FULL.name,
      legalName: null,
      email: null,
      phone: null,
      address: null,
      kraPin: null,
      receiptFooter: null,
      vatRateBps: 1600
    })
    expect(await dbBusiness()).toMatchObject({ legalName: null, email: null, phone: null, address: null, kraPin: null, receiptFooter: null })
    for (const name of ['', '   ', null]) {
      const bad = await owner.patch(PATH, { name })
      expect(bad.status).toBe(400)
    }
    expect((await dbBusiness()).name).toBe(FULL.name)
  })

  it('accepts the edges of every range', async () => {
    const edge = {
      name: 'AB',
      legalName: 'L'.repeat(120),
      email: 'a@b.ke',
      phone: '1'.repeat(40),
      address: 'A'.repeat(200),
      kraPin: 'A000000000A',
      receiptFooter: 'F'.repeat(200),
      vatRateBps: 5000
    }
    const r = await owner.patch(PATH, edge)
    expect(r.status).toBe(200)
    expect(r.body.business).toEqual({ id: fx.business.id, ...edge })
    const top = await owner.patch(PATH, { name: 'N'.repeat(80), vatRateBps: 0 })
    expect(top.status).toBe(200)
    expect(top.body.business).toMatchObject({ name: 'N'.repeat(80), vatRateBps: 0 })
  })

  const invalid: [string, unknown][] = [
    ['name too short', { name: 'A' }],
    ['name too short once trimmed', { name: ' A ' }],
    ['name too long', { name: 'N'.repeat(81) }],
    ['name not text', { name: 12 }],
    ['legal name too long', { legalName: 'L'.repeat(121) }],
    ['legal name not text', { legalName: 5 }],
    ['email without a domain', { email: 'nope' }],
    ['email with a space', { email: 'a b@c.ke' }],
    ['email too long', { email: 'a'.repeat(116) + '@b.ke' }],
    ['phone too long', { phone: '1'.repeat(41) }],
    ['phone not text', { phone: 712345678 }],
    ['address too long', { address: 'A'.repeat(201) }],
    ['KRA PIN one digit short', { kraPin: 'A12345678Z' }],
    ['KRA PIN one digit long', { kraPin: 'A1234567890Z' }],
    ['KRA PIN starting with a digit', { kraPin: '1234567890A' }],
    ['KRA PIN ending with a digit', { kraPin: 'A1234567890' }],
    ['KRA PIN with two leading letters', { kraPin: 'AB23456789Z' }],
    ['KRA PIN with a gap', { kraPin: 'A1234 56789Z' }],
    ['receipt footer too long', { receiptFooter: 'F'.repeat(201) }],
    ['VAT below zero', { vatRateBps: -1 }],
    ['VAT above 50%', { vatRateBps: 5001 }],
    ['VAT with a fraction', { vatRateBps: 1600.5 }],
    ['VAT as text', { vatRateBps: '1600' }],
    ['VAT null', { vatRateBps: null }],
    ['nothing to change', {}],
    ['only unknown fields', { currency: 'USD', id: 'x' }],
    ['one bad field among good ones', { name: 'Good Name', vatRateBps: 9999 }],
    ['not an object', ['name']]
  ]
  it.each(invalid)('rejects %s', async (_what, payload) => {
    const r = await owner.patch(PATH, payload)
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('bad_request')
    expect(await dbBusiness()).toMatchObject({ name: 'Test Wines', legalName: null, kraPin: null, vatRateBps: 1600, currency: 'KES' })
    expect(await audits()).toHaveLength(0)
  })

  it('rejects a body that is not JSON', async () => {
    const res = await app.request(PATH, { method: 'PATCH', headers: { origin: ORIGIN, cookie: owner.cookie, 'content-type': 'application/json' }, body: 'name=x' })
    expect(res.status).toBe(400)
  })

  it('never lets the id or currency be changed', async () => {
    const r = await owner.patch(PATH, { name: 'Renamed', id: 'hijack', currency: 'USD', createdAt: '2000-01-01T00:00:00Z' })
    expect(r.status).toBe(200)
    expect(r.body.business.id).toBe(fx.business.id)
    expect(await dbBusiness()).toMatchObject({ id: fx.business.id, name: 'Renamed', currency: 'KES', createdAt: fx.business.createdAt })
  })

  it('is for owners only', async () => {
    for (const c of [cashier, manager]) {
      const r = await c.patch(PATH, { name: 'Not Allowed' })
      expect(r.status).toBe(403)
      expect(r.body.error.code).toBe('forbidden')
    }
    expect((await new Client().patch(PATH, { name: 'Not Allowed' })).status).toBe(401)
    expect((await dbBusiness()).name).toBe('Test Wines')
    expect(await audits()).toHaveLength(0)
    expect((await owner.patch(PATH, { name: 'Allowed' })).status).toBe(200)
  })

  it('writes no audit row when nothing actually changed', async () => {
    await owner.patch(PATH, FULL)
    expect(await audits()).toHaveLength(1)
    const stamp = (await dbBusiness()).updatedAt
    const same = await owner.patch(PATH, { ...FULL, kraPin: ' p051234567x ', name: ` ${FULL.name} ` })
    expect(same.status).toBe(200)
    expect(same.body.business).toEqual({ id: fx.business.id, ...FULL })
    expect(await audits()).toHaveLength(1)
    expect((await dbBusiness()).updatedAt).toEqual(stamp)
    // clearing something that is already empty is not a change either
    await owner.patch(PATH, { legalName: '' })
    expect((await owner.patch(PATH, { legalName: '' })).status).toBe(200)
    expect(await audits()).toHaveLength(2)
  })

  it('names only the fields that changed', async () => {
    await owner.patch(PATH, FULL)
    await owner.patch(PATH, { ...FULL, vatRateBps: 0, receiptFooter: 'Karibu' })
    const log = await audits()
    expect(log).toHaveLength(2)
    expect(log[1]!.data).toEqual({
      fields: ['receiptFooter', 'vatRateBps'],
      from: { receiptFooter: FULL.receiptFooter, vatRateBps: 1600 },
      to: { receiptFooter: 'Karibu', vatRateBps: 0 }
    })
  })

  it('two saves at once: the same change is recorded once, different changes both land', async () => {
    const owner2 = await Client.login('owner')
    const same = await Promise.all([owner.patch(PATH, { name: 'Same Name' }), owner2.patch(PATH, { name: 'Same Name' })])
    expect(same.map(r => r.status)).toEqual([200, 200])
    expect(await audits()).toHaveLength(1)

    const mixed = await Promise.all([owner.patch(PATH, { phone: '020 111 2222' }), owner2.patch(PATH, { address: 'Ngong Road' })])
    expect(mixed.map(r => r.status)).toEqual([200, 200])
    expect(await dbBusiness()).toMatchObject({ name: 'Same Name', phone: '020 111 2222', address: 'Ngong Road' })
    const log = await audits()
    expect(log).toHaveLength(3)
    expect(log.slice(1).map(l => (l.data as any).fields[0]).sort()).toEqual(['address', 'phone'])
  })

  it('an owner of another business changes only their own', async () => {
    const other = await secondBusiness()
    const r = await other.owner.patch(PATH, { name: 'Other Renamed', kraPin: 'C111111111C', vatRateBps: 0 })
    expect(r.status).toBe(200)
    expect(r.body.business).toMatchObject({ id: other.business.id, name: 'Other Renamed', kraPin: 'C111111111C', vatRateBps: 0 })
    expect(await dbBusiness()).toMatchObject({ name: 'Test Wines', kraPin: null, vatRateBps: 1600 })
    expect(await audits()).toHaveLength(0)
    expect(await audits(other.business.id)).toHaveLength(1)

    await owner.patch(PATH, FULL)
    expect(await dbBusiness(other.business.id)).toMatchObject({ name: 'Other Renamed', legalName: 'Other Spirits Limited', kraPin: 'C111111111C', vatRateBps: 0 })
    expect(await audits(other.business.id)).toHaveLength(1)
  })
})

describe('subscription', () => {
  it.each(['SUSPENDED', 'CANCELLED'] as const)('a %s business gets 402 on both', async status => {
    await setSubscription(fx.business.id, status)
    const get = await owner.get(PATH)
    expect(get.status).toBe(402)
    expect(get.body.error.code).toBe(`subscription_${status.toLowerCase()}`)
    expect((await manager.get(PATH)).status).toBe(402)
    const patch = await owner.patch(PATH, { name: 'While Suspended' })
    expect(patch.status).toBe(402)
    expect((await dbBusiness()).name).toBe('Test Wines')
    expect(await audits()).toHaveLength(0)
  })

  it('an active subscription changes nothing', async () => {
    await setSubscription(fx.business.id, 'ACTIVE')
    expect((await owner.get(PATH)).status).toBe(200)
    expect((await owner.patch(PATH, { name: 'Paid Up' })).status).toBe(200)
  })

  it('a suspended neighbour does not block this business', async () => {
    const other = await secondBusiness()
    await setSubscription(other.business.id, 'SUSPENDED')
    expect((await other.owner.get(PATH)).status).toBe(402)
    expect((await owner.get(PATH)).status).toBe(200)
  })
})

describe('VAT contained in a total', () => {
  it('matches figures worked by hand', () => {
    const cases: [number, number, number][] = [
      // total, rate, VAT
      [11600, 1600, 1600],
      [536000, 1600, 73931],
      [100, 1600, 14],
      [1, 1600, 0],
      [4, 1600, 1],
      [28000, 800, 2074],
      [536000, 5000, 178667],
      [3, 5000, 1],
      [10001, 1, 1],
      [20001, 1, 2],
      [536000, 0, 0],
      [0, 1600, 0],
      [1_000_000_000, 1600, 137931034]
    ]
    for (const [total, bps, vat] of cases) expect([total, bps, vatIncludedCents(total, bps)]).toEqual([total, bps, vat])
  })

  it('is exact to the cent for many totals and rates', () => {
    // the same sum in arbitrary precision integers: net = round half up(total * 10000 / (10000 + bps))
    const exact = (total: number, bps: number) => {
      const d = 10000n + BigInt(bps)
      return total - Number((BigInt(total) * 20000n + d) / (2n * d))
    }
    const rates = [0, 1, 50, 800, 1200, 1400, 1600, 1650, 2000, 3333, 4999, 5000]
    const totals = [1, 2, 3, 7, 29, 58, 99, 100, 101, 116, 999, 1160, 28000, 145000, 480000, 536000, 999999, 123456789, 999999999, 1000000000]
    for (let t = 1; t <= 1500; t++) totals.push(t * 37 + (t % 11))
    let wrong = 0
    for (const bps of rates) {
      for (const total of totals) {
        const vat = vatIncludedCents(total, bps)
        const ok = vat === exact(total, bps) && Number.isInteger(vat) && vat >= 0 && vat < total && (bps !== 0 || vat === 0)
        if (!ok) {
          wrong++
          expect([total, bps, vat]).toEqual([total, bps, exact(total, bps)])
        }
      }
    }
    expect(wrong).toBe(0)
  })
})

describe('receipt uses the business details', () => {
  it('prints what the owner saved, and keeps every earlier field', async () => {
    await owner.patch(PATH, FULL)
    const sale = await paidSale(cashier, fx.products.whisky.id)
    const r = await cashier.get(`/api/sales/${sale.id}/receipt`)
    expect(r.status).toBe(200)
    const rc = r.body.receipt
    expect(rc.business).toEqual({
      name: FULL.name,
      legalName: FULL.legalName,
      address: FULL.address,
      phone: FULL.phone,
      email: FULL.email,
      kraPin: FULL.kraPin,
      receiptFooter: FULL.receiptFooter,
      vatRateBps: 1600
    })
    expect(rc.businessName).toBe(FULL.name)
    expect(rc.totalCents).toBe(480000)
    expect(rc.vatCents).toBe(66207)
    for (const k of ['businessName', 'branchName', 'saleId', 'number', 'status', 'label', 'customer', 'createdAt', 'paidAt', 'refundedAt', 'createdBy', 'paidBy', 'lines', 'subtotalCents', 'discountCents', 'totalCents', 'paidCents', 'payments', 'changeCents']) {
      expect(rc).toHaveProperty(k)
    }
  })

  it('follows the rate: later changes show on the receipt, and 0 means no VAT', async () => {
    const sale = await paidSale(cashier, fx.products.beer.id)
    const vatAt = async (bps: number) => {
      expect((await owner.patch(PATH, { vatRateBps: bps })).status).toBe(200)
      const rc = (await cashier.get(`/api/sales/${sale.id}/receipt`)).body.receipt
      expect(rc.business.vatRateBps).toBe(bps)
      return rc.vatCents
    }
    expect(await vatAt(800)).toBe(2074)
    expect(await vatAt(5000)).toBe(9333)
    expect(await vatAt(0)).toBe(0)
    expect(await vatAt(1600)).toBe(3862)
  })

  it.each([
    [100, 1600, 14],
    [9999, 1600, 1379],
    [123457, 1600, 17029],
    [35050, 800, 2596],
    [1, 1600, 0],
    [250000, 0, 0]
  ])('a sale of %i cents at %i bps holds %i cents of VAT', async (priceCents, bps, vatCents) => {
    await prisma.business.update({ where: { id: fx.business.id }, data: { vatRateBps: bps } })
    const p = await productAt(priceCents)
    const sale = await paidSale(cashier, p.id)
    const rc = (await cashier.get(`/api/sales/${sale.id}/receipt`)).body.receipt
    expect(rc.totalCents).toBe(priceCents)
    expect(rc.vatCents).toBe(vatCents)
    expect(rc.business.vatRateBps).toBe(bps)
  })

  it('a receipt of one business never shows another business', async () => {
    const other = await secondBusiness()
    await owner.patch(PATH, FULL)
    const mine = await paidSale(cashier, fx.products.gin.id)
    const theirs = await paidSale(other.owner, other.product.id)

    const a = (await cashier.get(`/api/sales/${mine.id}/receipt`)).body.receipt
    expect(a.business).toEqual(FULL)
    expect(a.vatCents).toBe(20000)
    expect(JSON.stringify(a)).not.toMatch(/Other Spirits|B999999999B|Karibu tena|Mombasa|other@spirits/)

    const b = (await other.owner.get(`/api/sales/${theirs.id}/receipt`)).body.receipt
    expect(b.business).toEqual({
      name: 'Other Spirits',
      legalName: 'Other Spirits Limited',
      address: 'Moi Avenue, Mombasa',
      phone: '0733 000 111',
      email: 'other@spirits.test',
      kraPin: 'B999999999B',
      receiptFooter: 'Karibu tena',
      vatRateBps: 800
    })
    expect(b.vatCents).toBe(8000)
    expect(JSON.stringify(b)).not.toMatch(/Bottle Point|P051234567X|Asante|Westlands|Test Wines/)

    // and neither side can open the other's receipt at all
    expect((await other.owner.get(`/api/sales/${mine.id}/receipt`)).status).toBe(404)
    expect((await owner.get(`/api/sales/${theirs.id}/receipt`)).status).toBe(404)
    expect((await cashier.get(`/api/sales/${theirs.id}/receipt`)).status).toBe(404)
  })
})
