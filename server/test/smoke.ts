// End to end smoke test against a RUNNING server and the seeded demo data.
//   npm run db:seed && npm run dev      (in one terminal)
//   npm run smoke                       (in another)
// Talks real HTTP and real WebSockets, like the till does.

import { io, type Socket } from 'socket.io-client'

const BASE = process.env.SMOKE_URL ?? 'http://localhost:3000'
const ORIGIN = process.env.SMOKE_ORIGIN ?? 'http://localhost:5173'

let failures = 0
const ok = (msg: string) => console.log('  ok   ' + msg)
function check(cond: unknown, msg: string) {
  if (cond) ok(msg)
  else {
    failures++
    console.log('  FAIL ' + msg)
  }
}

class User {
  cookie = ''
  constructor(public username: string) {}
  async login() {
    const r = await fetch(BASE + '/api/session/pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ username: this.username, pin: '1234' })
    })
    if (r.status !== 200) throw new Error(`${this.username} could not sign in: ${r.status} ${await r.text()}`)
    this.cookie = r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    return this
  }
  async call(method: string, path: string, body?: unknown) {
    const r = await fetch(BASE + path, {
      method,
      headers: { origin: ORIGIN, cookie: this.cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    })
    const text = await r.text()
    let json: any = null
    try { json = JSON.parse(text) } catch {}
    return { status: r.status, body: json }
  }
  get(p: string) { return this.call('GET', p) }
  post(p: string, b: unknown = {}) { return this.call('POST', p, b) }
  socket() {
    return new Promise<Socket>((resolve, reject) => {
      const s = io(BASE, { path: '/socket.io', transports: ['websocket'], extraHeaders: { cookie: this.cookie, origin: ORIGIN }, reconnection: false })
      s.on('ready', () => resolve(s))
      s.on('connect_error', reject)
    })
  }
}

const waitFor = <T>(s: Socket, event: string, pred: (p: any) => boolean, ms = 10000) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => { s.off(event, h); reject(new Error(`timed out waiting for ${event}`)) }, ms)
    const h = (p: any) => { if (pred(p)) { clearTimeout(t); s.off(event, h); resolve(p) } }
    s.on(event, h)
  })

async function main() {
  console.log(`Smoke test against ${BASE}\n`)

  console.log('Health and auth')
  const health = await fetch(BASE + '/api/health')
  check(health.status === 200, 'API and database are up')
  const anon = await fetch(BASE + '/api/sales')
  check(anon.status === 401, 'API refuses requests without a session')
  const bad = await fetch(BASE + '/api/session/pin', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ username: 'wanjiru', pin: '9999' }) })
  check(bad.status === 401, 'wrong PIN is refused')

  const cashier = await new User('wanjiru').login()
  const cashier2 = await new User('brian').login()
  const manager = await new User('otieno').login()
  const owner = await new User('achieng').login()
  const me = await cashier.get('/api/session/me')
  check(me.status === 200 && me.body.user.role === 'CASHIER', 'cashier signs in with PIN')

  console.log('\nRealtime')
  const tillA = await cashier.socket()
  const tillB = await cashier2.socket()
  ok('two tills connected over WebSocket')

  console.log('\nShift')
  let shift = (await cashier.get('/api/shifts/current')).body.shift
  if (!shift) shift = (await cashier.post('/api/shifts/open', { openingFloatCents: 500000 })).body.shift
  check(shift && shift.open, 'cashier has an open shift')

  console.log('\nScan and sell, cash')
  const scan = await cashier.get('/api/products/barcode/5000267024004')
  check(scan.status === 200 && scan.body.product.name.includes('Johnnie'), 'barcode lookup finds Johnnie Walker')
  const beer = (await cashier.get('/api/products/barcode/6161100010017')).body.product
  const seenByOtherTill = waitFor(tillB, 'sale:updated', p => p.sale.label === 'Smoke cash')
  const created = await cashier.post('/api/sales', { lines: [{ productId: scan.body.product.id, qty: 1 }, { productId: beer.id, qty: 2 }], label: 'Smoke cash' })
  check(created.status === 201 && created.body.sale.status === 'SAVED', 'sale is saved the moment it is recorded')
  const sale = created.body.sale
  await seenByOtherTill
  ok('the other till saw the new sale live')
  check(sale.totalCents === 480000 + 2 * 28000, 'total is right (4,800 + 2 x 280)')

  const stockBefore = (await cashier.get('/api/products?q=Tusker')).body.products?.[0]?.qty
  const paid = await cashier.post(`/api/sales/${sale.id}/pay`, { payments: [{ method: 'CASH', amountCents: sale.totalCents, tenderedCents: 550000 }] })
  check(paid.status === 200 && paid.body.sale.status === 'PAID', 'cash payment confirmed, sale PAID')
  check(paid.body.changeCents === 550000 - sale.totalCents, 'change is right')
  const stockAfter = (await cashier.get('/api/products?q=Tusker')).body.products?.[0]?.qty
  check(stockBefore - stockAfter === 2, 'stock went down by 2 Tuskers')
  const again = await cashier.post(`/api/sales/${sale.id}/pay`, { payments: [{ method: 'CASH', amountCents: 100 }] })
  check(again.status === 422, 'a paid sale is locked')
  const receipt = await cashier.get(`/api/sales/${sale.id}/receipt`)
  check(receipt.status === 200 && receipt.body.receipt, 'receipt data is available')

  console.log('\nM-Pesa STK push (mock mode)')
  const tab = (await cashier.post('/api/sales', { lines: [{ productId: beer.id, qty: 3 }], label: 'Smoke STK' })).body.sale
  const stkDone = waitFor<any>(tillA, 'mpesa:updated', p => p.request.status !== 'PENDING' && p.request.amountCents === tab.totalCents, 15000)
  const salePaidLive = waitFor<any>(tillB, 'sale:updated', p => p.sale.id === tab.id && p.sale.status === 'PAID', 15000)
  const stk = await cashier.post('/api/mpesa/stk', { saleId: tab.id, phone: '0712345678' })
  check(stk.status === 200 || stk.status === 201, 'STK push sent to the phone')
  const second = await cashier.post('/api/mpesa/stk', { saleId: tab.id, phone: '0712345678' })
  check(second.status === 409, 'a second push while one is waiting is refused')
  const result = await stkDone
  check(result.request.status === 'SUCCESS', 'Safaricom confirmed the payment (mock callback)')
  const live = await salePaidLive
  check(live.sale.payments.some((p: any) => p.verification === 'STK_CONFIRMED'), 'other till saw the sale turn PAID live, STK confirmed')

  console.log('\nTyped M-Pesa code fallback')
  const typed = (await cashier.post('/api/sales', { lines: [{ productId: beer.id, qty: 1 }] })).body.sale
  const code = 'SM' + Math.random().toString(36).slice(2, 10).toUpperCase().padEnd(8, '0')
  const t1 = await cashier.post(`/api/sales/${typed.id}/pay`, { payments: [{ method: 'MPESA', amountCents: typed.totalCents, mpesaRef: code }] })
  check(t1.status === 200 && t1.body.sale.payments[0].verification === 'MANUAL_UNVERIFIED', 'typed code accepted, marked unverified')
  const other = (await cashier.post('/api/sales', { lines: [{ productId: beer.id, qty: 1 }] })).body.sale
  const t2 = await cashier.post(`/api/sales/${other.id}/pay`, { payments: [{ method: 'MPESA', amountCents: other.totalCents, mpesaRef: code }] })
  check(t2.status === 409, 'the same code on another sale is refused')
  const unverified = await manager.get('/api/mpesa/unverified')
  const pay = unverified.body.payments?.find((p: any) => p.mpesaRef === code)
  check(!!pay, 'manager sees the typed code to check')
  const v = await manager.post(`/api/mpesa/payments/${pay.id}/verify`, { ok: true })
  check(v.status === 200, 'manager verified it')

  console.log('\nRefund with approval')
  const req = await cashier.post('/api/approvals', { saleId: sale.id, kind: 'REFUND', reason: 'Smoke test refund', refundMethod: 'CASH' })
  check(req.status === 201, 'cashier asked for a refund')
  const selfApprove = await cashier.post(`/api/approvals/${req.body.approval.id}/approve`)
  check(selfApprove.status === 403, 'a cashier cannot approve')
  const approveLive = waitFor<any>(tillA, 'approval:updated', p => p.approval.id === req.body.approval.id && p.approval.status === 'APPROVED')
  const approved = await manager.post(`/api/approvals/${req.body.approval.id}/approve`)
  check(approved.status === 200 && approved.body.sale.status === 'REFUNDED', 'manager approved, sale REFUNDED')
  await approveLive
  ok('the till saw the approval live')

  console.log('\nReports')
  const daily = await manager.get('/api/reports/daily')
  check(daily.status === 200, 'manager daily report')
  const cashierReport = await cashier.get('/api/reports/daily')
  check(cashierReport.status === 403, 'cashier cannot see reports')
  const branches = await owner.get('/api/reports/branches')
  check(branches.status === 200, 'owner sees all branches')

  console.log('\nTill count')
  const current = (await cashier.get('/api/shifts/current')).body.shift
  check(current.expectedCashCents === current.openingFloatCents + current.cashTakenCents - current.cashRefundsCents, 'expected cash = float + cash taken - cash refunds')

  tillA.close()
  tillB.close()
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll smoke checks passed')
  process.exit(failures ? 1 : 0)
}

main().catch(err => {
  console.error('\nSmoke test crashed:', err.message)
  process.exit(1)
})
