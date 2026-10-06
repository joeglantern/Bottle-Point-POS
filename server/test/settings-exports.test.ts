import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { createStaff } from '../src/lib/users.js'
import { csvCell, csvRow, exportRange, money } from '../src/rules/exports.js'
import { todayNairobi } from '../src/rules/reports.js'
import { app, Client, consoleLogin, ORIGIN, PIN, resetDb, seedFixture, seedPlatform, type Fixture } from './helpers.js'

let fx: Fixture
let owner: Client

const KINDS = ['sales', 'sale-lines', 'payments', 'stock', 'products'] as const
const HEADERS: Record<(typeof KINDS)[number], string> = {
  sales: 'Sale number,Branch,Date,Time,Status,Label,Customer,Subtotal,Discount,Total,Paid,Paid date,Paid time,Cashier,Paid by,Payment methods,M-Pesa codes',
  'sale-lines': 'Sale number,Branch,Date,Time,Status,Product,Quantity,Unit price,Line total',
  payments: 'Sale number,Branch,Date,Time,Method,Amount,Tendered,M-Pesa code,Phone,Verification,Received by',
  stock: 'Branch,Product,Size ml,Category,Barcode,Quantity,Reorder at,Price,Stock value,Active',
  products: 'Product,Size ml,Category,Barcode,Price,Active,Created'
}

// The raw download: bytes, headers and the text with the byte order mark kept.
async function download(client: Client | null, path: string) {
  const res = await app.request(path, { headers: { origin: ORIGIN, ...(client ? { cookie: client.cookie } : {}) } })
  const bytes = new Uint8Array(await res.arrayBuffer())
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, headers: res.headers, bytes, text, json }
}

// A strict reader of what we wrote: quoted fields, doubled quotes, CRLF rows.
function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\r' && s[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++ }
    else cell += ch
  }
  expect(quoted).toBe(false)
  expect(cell).toBe('')
  expect(row).toEqual([])
  return rows
}

const rowsOf = async (path: string, client = owner) => {
  const r = await download(client, path)
  expect(r.status).toBe(200)
  return parseCsv(r.text)
}

// A paid sale written straight to the tables, at an exact instant.
async function sale(branchId: string, number: number, at: Date, over: Record<string, unknown> = {}) {
  return prisma.sale.create({
    data: {
      number, branchId, createdById: fx.users.cashier.id, status: 'PAID', subtotalCents: 508000, discountCents: 8000, totalCents: 500000,
      paidById: fx.users.manager.id, paidAt: at, createdAt: at, ...over
    }
  })
}

async function secondBusiness() {
  const business = await prisma.business.create({ data: { name: 'Other Spirits' } })
  const branch = await prisma.branch.create({ data: { businessId: business.id, name: 'Karen' } })
  await createStaff(prisma, { businessId: business.id, name: 'other owner', username: 'otherowner', pin: PIN, role: 'OWNER', branchIds: [] })
  const product = await prisma.product.create({ data: { businessId: business.id, name: 'Other Rum', priceCents: 99900, category: 'Rum' } })
  await prisma.stock.create({ data: { branchId: branch.id, productId: product.id, qty: 7 } })
  return { business, branch, product, owner: await Client.login('otherowner') }
}

async function subscribe(businessId: string, features: Record<string, unknown>, status: 'ACTIVE' | 'SUSPENDED' | 'CANCELLED' = 'ACTIVE') {
  const plan = await prisma.plan.create({ data: { code: 'p' + Math.random().toString(36).slice(2, 8), name: 'Starter', model: 'FLAT', priceCents: 250000, features: features as never } })
  return prisma.subscription.create({
    data: { businessId, planId: plan.id, status, currentPeriodStart: new Date('2026-10-01T00:00:00Z'), currentPeriodEnd: new Date('2026-11-01T00:00:00Z') }
  })
}

beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
  owner = await Client.login('owner')
})

describe('CSV building blocks', () => {
  it('writes money from integer cents without float error', () => {
    expect(money(480000).trusted).toBe('4800.00')
    expect(money(5).trusted).toBe('0.05')
    expect(money(0).trusted).toBe('0.00')
    expect(money(-150).trusted).toBe('-1.50')
    expect(money(1999999999).trusted).toBe('19999999.99')
    expect(money(null).trusted).toBe('')
  })

  it('quotes and doubles quotes only where needed', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
    expect(csvCell(null)).toBe('')
    expect(csvCell(12)).toBe('12')
    expect(csvRow(['a', 1, null])).toBe('a,1,\r\n')
  })

  it('neutralises formulas but leaves numbers we generate alone', () => {
    for (const bad of ['=1+1', '+254712345678', '-2+3', '@SUM(A1)', '\tx', '\rx']) expect(csvCell(bad).replace(/^"/, '')[0]).toBe("'")
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe('"\'=HYPERLINK(""http://x"",""y"")"')
    expect(csvCell(money(-150))).toBe('-1.50')
    expect(csvCell(-3)).toBe('-3')
    expect(csvCell('a=b')).toBe('a=b')
  })

  it('works out the range in Nairobi days', () => {
    const now = new Date('2026-02-28T22:30:00Z') // already 1 March in Nairobi
    expect(exportRange({}, now)).toMatchObject({ from: '2026-03-01', to: '2026-03-31' })
    expect(exportRange({}, now).start.toISOString()).toBe('2026-02-28T21:00:00.000Z')
    expect(exportRange({}, now).end.toISOString()).toBe('2026-03-31T21:00:00.000Z')
    expect(exportRange({ from: '2026-01-10' }, now)).toMatchObject({ from: '2026-01-10', to: '2026-03-01' })
    expect(exportRange({ to: '2025-12-20' }, now)).toMatchObject({ from: '2025-12-01', to: '2025-12-20' })
    expect(exportRange({ from: '2025-01-01', to: '2026-01-01' })).toMatchObject({ from: '2025-01-01', to: '2026-01-01' }) // 366 days
    expect(() => exportRange({ from: '2025-01-01', to: '2026-01-02' })).toThrow(/at most 366 days/)
    expect(() => exportRange({ from: '2026-03-02', to: '2026-03-01' })).toThrow(/must not be after/)
    expect(exportRange({ from: '2026-03-01', to: '2026-03-01' })).toMatchObject({ from: '2026-03-01' })
  })
})

describe('GET /api/admin/export/*.csv', () => {
  it('downloads sales with the byte order mark, headers, Nairobi times and escaped hostile text', async () => {
    const evil = await prisma.customer.create({ data: { businessId: fx.business.id, name: '=HYPERLINK("http://evil.test","Click")', phone: '254712345678' } })
    // 21:30 UTC on 30 September is 00:30 on 1 October in Nairobi
    const s1 = await sale(fx.branches.west.id, 1001, new Date('2026-09-30T21:30:05Z'), { customerId: evil.id, label: '+1 table, "VIP"\nback room' })
    await prisma.payment.create({ data: { saleId: s1.id, method: 'CASH', amountCents: 200000, tenderedCents: 200000, verification: 'CASH', receivedById: fx.users.cashier.id } })
    await prisma.payment.create({ data: { saleId: s1.id, method: 'MPESA', amountCents: 300000, mpesaRef: 'SJK4ABCDE1', phone: '254712345678', verification: 'STK_CONFIRMED', receivedById: fx.users.manager.id } })
    await sale(fx.branches.kili.id, 1001, new Date('2026-10-31T20:59:59Z'), { status: 'OPEN', paidAt: null, paidById: null, subtotalCents: 5, discountCents: 0, totalCents: 5 })
    await sale(fx.branches.west.id, 1002, new Date('2026-09-30T20:59:59Z')) // 30 September in Nairobi: outside
    await sale(fx.branches.west.id, 1003, new Date('2026-10-31T21:00:00Z')) // 1 November in Nairobi: outside

    const r = await download(owner, '/api/admin/export/sales.csv?from=2026-10-01&to=2026-10-31')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="sales-2026-10-01-to-2026-10-31.csv"')
    expect([...r.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(r.text.startsWith('﻿' + HEADERS.sales + '\r\n')).toBe(true)
    expect(r.text).toContain('"\'=HYPERLINK(""http://evil.test"",""Click"")"')
    expect(r.text).toContain('"\'+1 table, ""VIP""\nback room"')

    const rows = parseCsv(r.text)
    expect(rows).toHaveLength(3)
    const paid = rows.find(x => x[1] === 'Westlands')!
    expect(paid).toEqual([
      '1001', 'Westlands', '2026-10-01', '00:30:05', 'PAID', '\'+1 table, "VIP"\nback room', '\'=HYPERLINK("http://evil.test","Click")',
      '5080.00', '80.00', '5000.00', '5000.00', '2026-10-01', '00:30:05', 'cashier', 'manager', 'CASH MPESA', 'SJK4ABCDE1'
    ])
    const open = rows.find(x => x[1] === 'Kilimani')!
    expect(open).toEqual(['1001', 'Kilimani', '2026-10-31', '23:59:59', 'OPEN', '', '', '0.05', '0.00', '0.05', '0.00', '', '', 'cashier', '', '', ''])

    const log = await prisma.auditLog.findMany({ where: { action: 'export.created' } })
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ userId: fx.users.owner.id, businessId: fx.business.id, entity: 'Export' })
    expect(log[0]!.data).toEqual({ kind: 'sales', from: '2026-10-01', to: '2026-10-31', branchId: null })
  })

  it('filters by branch and answers 404 for a branch of another business or an unknown one', async () => {
    const other = await secondBusiness()
    await sale(fx.branches.west.id, 1001, new Date('2026-10-05T09:00:00Z'))
    await sale(fx.branches.kili.id, 1001, new Date('2026-10-05T09:00:00Z'))
    const rows = await rowsOf(`/api/admin/export/sales.csv?from=2026-10-01&to=2026-10-31&branchId=${fx.branches.kili.id}`)
    expect(rows.slice(1).map(x => x[1])).toEqual(['Kilimani'])
    for (const kind of KINDS) {
      const r = await download(owner, `/api/admin/export/${kind}.csv?branchId=${other.branch.id}`)
      expect(r.status).toBe(404)
      expect(r.json.error.code).toBe('not_found')
      expect((await download(owner, `/api/admin/export/${kind}.csv?branchId=nope`)).status).toBe(404)
    }
    expect(await prisma.auditLog.count({ where: { action: 'export.created' } })).toBe(1)
  })

  it('validates the range', async () => {
    const bad = async (qs: string) => download(owner, `/api/admin/export/sales.csv?${qs}`)
    expect((await bad('from=2026-10-10&to=2026-10-09')).json.error).toMatchObject({ code: 'invalid_range' })
    expect((await bad('from=2026-10-10&to=2026-10-09')).status).toBe(422)
    const long = await bad('from=2025-01-01&to=2026-01-02')
    expect(long.status).toBe(422)
    expect(long.json.error.code).toBe('range_too_long')
    expect((await bad('from=2025-01-01&to=2026-01-01')).status).toBe(200)
    expect((await bad('from=01/10/2026')).status).toBe(400)
    expect((await bad('to=2026-02-30')).status).toBe(400)
    expect((await bad('from=2026-10-01&to=2026-10-01')).status).toBe(200)
    expect((await bad('branchId=')).status).toBe(400)
  })

  it('defaults to the current Nairobi month', async () => {
    const today = todayNairobi()
    await sale(fx.branches.west.id, 1001, new Date())
    await sale(fx.branches.west.id, 1002, new Date(Date.now() - 62 * 24 * 60 * 60 * 1000))
    const r = await download(owner, '/api/admin/export/sales.csv')
    expect(r.headers.get('content-disposition')).toContain(`filename="sales-${today.slice(0, 8)}01-to-${today.slice(0, 8)}`)
    expect(parseCsv(r.text).slice(1).map(x => x[0])).toEqual(['1001'])
  })

  it('exports sale lines and payments, one row each', async () => {
    const s = await sale(fx.branches.west.id, 1001, new Date('2026-10-05T09:15:00Z'))
    await prisma.saleLine.create({ data: { saleId: s.id, productId: fx.products.whisky.id, name: '@SUM(1+1) "Reserve", 12yr', unitCents: 480000, qty: 1 } })
    await prisma.saleLine.create({ data: { saleId: s.id, productId: fx.products.beer.id, name: 'Tusker Lager', unitCents: 28005, qty: 3 } })
    await prisma.payment.create({ data: { saleId: s.id, method: 'CASH', amountCents: 150000, tenderedCents: 200000, verification: 'CASH', receivedById: fx.users.cashier.id, createdAt: new Date('2026-10-05T09:16:00Z') } })
    await prisma.payment.create({ data: { saleId: s.id, method: 'MPESA', amountCents: 350000, mpesaRef: 'SJK4ABCDE2', phone: '254712345678', verification: 'MANUAL_VERIFIED', receivedById: fx.users.manager.id, createdAt: new Date('2026-09-30T20:00:00Z') } })

    const lines = await rowsOf('/api/admin/export/sale-lines.csv?from=2026-10-01&to=2026-10-31')
    expect(lines[0]!.join(',')).toBe(HEADERS['sale-lines'])
    expect(lines.slice(1).sort((a, b) => a[5]!.localeCompare(b[5]!))).toEqual([
      ['1001', 'Westlands', '2026-10-05', '12:15:00', 'PAID', '\'@SUM(1+1) "Reserve", 12yr', '1', '4800.00', '4800.00'],
      ['1001', 'Westlands', '2026-10-05', '12:15:00', 'PAID', 'Tusker Lager', '3', '280.05', '840.15']
    ])

    // the M-Pesa payment was taken on 30 September, so October has only the cash
    const pays = await rowsOf('/api/admin/export/payments.csv?from=2026-10-01&to=2026-10-31')
    expect(pays[0]!.join(',')).toBe(HEADERS.payments)
    expect(pays.slice(1)).toEqual([['1001', 'Westlands', '2026-10-05', '12:16:00', 'CASH', '1500.00', '2000.00', '', '', 'CASH', 'cashier']])
    const sept = await rowsOf('/api/admin/export/payments.csv?from=2026-09-30&to=2026-09-30')
    expect(sept.slice(1)).toEqual([['1001', 'Westlands', '2026-09-30', '23:00:00', 'MPESA', '3500.00', '', 'SJK4ABCDE2', '254712345678', 'MANUAL_VERIFIED', 'manager']])
    expect((await prisma.auditLog.findMany({ where: { action: 'export.created' } })).map(a => (a.data as any).kind).sort()).toEqual(['payments', 'payments', 'sale-lines'])
  })

  it('exports current stock per branch and the catalogue, with hostile names made safe', async () => {
    const nasty = await prisma.product.create({ data: { businessId: fx.business.id, name: '-2+3 cmd|\' /C calc\'!A0', priceCents: 123456, category: '=Spirits', active: false } })
    await prisma.stock.create({ data: { branchId: fx.branches.west.id, productId: nasty.id, qty: -4, reorderAt: 2 } })
    await prisma.stock.update({ where: { branchId_productId: { branchId: fx.branches.kili.id, productId: fx.products.beer.id } }, data: { qty: 12 } })

    const stock = await download(owner, '/api/admin/export/stock.csv')
    expect(stock.headers.get('content-disposition')).toBe(`attachment; filename="stock-${todayNairobi()}.csv"`)
    const rows = parseCsv(stock.text)
    expect(rows[0]!.join(',')).toBe(HEADERS.stock)
    expect(rows).toHaveLength(1 + 7)
    expect(rows).toContainEqual(['Kilimani', 'Tusker Lager', '750', 'Beer', '6161100010017', '12', '10', '280.00', '3360.00', 'Yes'])
    // the name gains a quote mark, the negative count and value we wrote stay numbers
    expect(rows).toContainEqual(['Westlands', "'-2+3 cmd|' /C calc'!A0", '', "'=Spirits", '', '-4', '2', '1234.56', '-4938.24', 'No'])
    const west = await rowsOf(`/api/admin/export/stock.csv?branchId=${fx.branches.west.id}`)
    expect(new Set(west.slice(1).map(x => x[0]))).toEqual(new Set(['Westlands']))
    expect(west).toHaveLength(1 + 4)

    const products = await download(owner, '/api/admin/export/products.csv')
    expect(products.headers.get('content-disposition')).toBe(`attachment; filename="products-${todayNairobi()}.csv"`)
    const p = parseCsv(products.text)
    expect(p[0]!.join(',')).toBe(HEADERS.products)
    expect(p).toHaveLength(1 + 4)
    expect(p).toContainEqual(['Johnnie Walker Black', '750', 'Whisky', '5000267024004', '4800.00', 'Yes', todayNairobi(fx.products.whisky.createdAt)])
    expect(p).toContainEqual(["'-2+3 cmd|' /C calc'!A0", '', "'=Spirits", '', '1234.56', 'No', todayNairobi(nasty.createdAt)])
  })

  it('pages through more rows than one batch holds without losing or repeating any', async () => {
    const at = new Date('2026-10-05T09:00:00Z')
    const base = { branchId: fx.branches.west.id, createdById: fx.users.cashier.id, status: 'PAID' as const, subtotalCents: 28000, totalCents: 28000, paidAt: at, createdAt: at }
    await prisma.sale.createMany({ data: Array.from({ length: 1203 }, (_, i) => ({ ...base, number: 2000 + i })) })
    const sales = await prisma.sale.findMany({ select: { id: true } })
    await prisma.saleLine.createMany({ data: sales.map(s => ({ saleId: s.id, productId: fx.products.beer.id, name: 'Tusker Lager', unitCents: 28000, qty: 1 })) })
    await prisma.payment.createMany({ data: sales.map(s => ({ saleId: s.id, method: 'CASH' as const, amountCents: 28000, verification: 'CASH' as const, receivedById: fx.users.cashier.id, createdAt: at })) })
    await prisma.product.createMany({ data: Array.from({ length: 520 }, (_, i) => ({ businessId: fx.business.id, name: `Bulk ${i}`, priceCents: 1000, category: 'Bulk' })) })
    const bulk = await prisma.product.findMany({ where: { category: 'Bulk' }, select: { id: true } })
    await prisma.stock.createMany({ data: bulk.map(b => ({ branchId: fx.branches.kili.id, productId: b.id, qty: 1 })) })

    const q = '?from=2026-10-01&to=2026-10-31'
    const rows = await rowsOf('/api/admin/export/sales.csv' + q)
    expect(rows).toHaveLength(1 + 1203)
    expect(new Set(rows.slice(1).map(x => x[0])).size).toBe(1203)
    expect(rows.every(x => x.length === 17)).toBe(true)
    expect(await rowsOf('/api/admin/export/sale-lines.csv' + q)).toHaveLength(1 + 1203)
    expect(await rowsOf('/api/admin/export/payments.csv' + q)).toHaveLength(1 + 1203)
    const products = await rowsOf('/api/admin/export/products.csv')
    expect(new Set(products.slice(1).map(x => x[0])).size).toBe(523)
    expect(await rowsOf('/api/admin/export/stock.csv')).toHaveLength(1 + 6 + 520)
  }, 60_000)

  it('answers 402 plan_feature only when the plan switches exports off', async () => {
    for (const kind of KINDS) expect((await download(owner, `/api/admin/export/${kind}.csv`)).status).toBe(200) // no subscription
    const sub = await subscribe(fx.business.id, {})
    expect((await download(owner, '/api/admin/export/sales.csv')).status).toBe(200) // key missing
    await prisma.plan.update({ where: { id: sub.planId }, data: { features: { exports: true } } })
    expect((await download(owner, '/api/admin/export/sales.csv')).status).toBe(200)
    await prisma.plan.update({ where: { id: sub.planId }, data: { features: { exports: false } } })
    const before = await prisma.auditLog.count({ where: { action: 'export.created' } })
    for (const kind of KINDS) {
      const r = await download(owner, `/api/admin/export/${kind}.csv`)
      expect(r.status).toBe(402)
      expect(r.json.error.code).toBe('plan_feature')
    }
    expect(await prisma.auditLog.count({ where: { action: 'export.created' } })).toBe(before)
  })

  it('is for the owner only, never for a console session or a visitor', async () => {
    const platform = await seedPlatform()
    const consoleUser = await consoleLogin(platform.admin.email!)
    const cashier = await Client.login('cashier')
    const manager = await Client.login('manager')
    for (const kind of KINDS) {
      const path = `/api/admin/export/${kind}.csv`
      expect((await download(cashier, path)).status).toBe(403)
      expect((await download(manager, path)).status).toBe(403)
      expect((await download(consoleUser, path)).status).toBe(401)
      expect((await download(null, path)).status).toBe(401)
      expect((await download(owner, path)).status).toBe(200)
    }
    expect(await prisma.auditLog.count({ where: { action: 'export.created' } })).toBe(KINDS.length)
  })

  it('answers 402 on every export while the business is suspended or cancelled', async () => {
    const sub = await subscribe(fx.business.id, {}, 'SUSPENDED')
    for (const kind of KINDS) {
      const r = await download(owner, `/api/admin/export/${kind}.csv`)
      expect(r.status).toBe(402)
      expect(r.json.error.code).toBe('subscription_suspended')
    }
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'CANCELLED' } })
    expect((await download(owner, '/api/admin/export/sales.csv')).json.error.code).toBe('subscription_cancelled')
  })

  it('never shows another business its rows', async () => {
    const other = await secondBusiness()
    const s = await sale(fx.branches.west.id, 1001, new Date('2026-10-05T09:00:00Z'))
    await prisma.saleLine.create({ data: { saleId: s.id, productId: fx.products.gin.id, name: 'Gilbeys Gin', unitCents: 145000, qty: 1 } })
    await prisma.payment.create({ data: { saleId: s.id, method: 'CASH', amountCents: 145000, verification: 'CASH', receivedById: fx.users.cashier.id, createdAt: new Date('2026-10-05T09:00:00Z') } })
    const q = '?from=2026-10-01&to=2026-10-31'
    for (const kind of ['sales', 'sale-lines', 'payments'] as const) {
      expect(await rowsOf(`/api/admin/export/${kind}.csv${q}`, other.owner)).toHaveLength(1)
      expect(await rowsOf(`/api/admin/export/${kind}.csv${q}`)).toHaveLength(2)
      expect((await download(other.owner, `/api/admin/export/${kind}.csv${q}&branchId=${fx.branches.west.id}`)).status).toBe(404)
    }
    expect((await rowsOf('/api/admin/export/stock.csv', other.owner)).slice(1)).toEqual([['Karen', 'Other Rum', '', 'Rum', '', '7', '10', '999.00', '6993.00', 'Yes']])
    expect((await rowsOf('/api/admin/export/products.csv', other.owner)).slice(1).map(x => x[0])).toEqual(['Other Rum'])
    expect((await download(owner, '/api/admin/export/stock.csv')).text).not.toContain('Other Rum')
    expect((await download(owner, '/api/admin/export/products.csv')).text).not.toContain('Other Rum')
  })
})
