import { ApiError } from '../apierror.js'
import { done, getOne, kvGet, kvSet, tx } from './db.js'
import { getBusiness, nextOfflineRef } from './device.js'
import { queue, unqueue } from './outbox.js'
import { serverIdFor } from './ids.js'

// When the server cannot be reached, the till's requests are answered here
// from what the till keeps. Selling, saving tabs, cash and typed M-Pesa codes,
// opening a shift and printing receipts all work. Everything recorded here is
// queued and sent when the connection is back (sync.js).
//
// What needs the server is refused with a plain message: M-Pesa prompts,
// discounts and refunds (they need a manager's approval), closing a shift (the
// count must include every sale), changing a tab from before the outage,
// products, staff and reports.

const MAX_QTY = 999
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isLocalId = id => UUID.test(id ?? '')

const needsInternet = (what = 'This') =>
  new ApiError(0, 'offline', `${what} needs the internet. It will work again when the connection is back.`)
const refuse = (message, code = 'invalid_state') => new ApiError(422, code, message)

// ---------- cached answers ----------

// Which answers the till keeps, and whose they are.
const RULES = [
  { re: /^\/session\/tenant$/, scope: 'all', key: () => '/session/tenant' },
  { re: /^\/products$/, scope: 'branch', key: () => '/products' },
  { re: /^\/sales\?(.*&)?status=SAVED(&|$)/, scope: 'branch', key: () => '/sales?status=SAVED' },
  { re: /^\/shifts\/current$/, scope: 'user', key: () => '/shifts/current' }
]

const ruleFor = path => RULES.find(r => r.re.test(path))
const keyFor = (rule, path, ctx) => {
  const scope = rule.scope === 'all' ? '' : rule.scope === 'branch' ? ctx.branchId ?? '' : `${ctx.branchId ?? ''}|${ctx.user?.id ?? ''}`
  return `c|${scope}|${rule.key(path)}`
}

export const isCacheable = path => !!ruleFor(path)

export async function remember(path, data, ctx, method = 'GET') {
  try { await rememberAll(path, data, ctx, method) } catch {}
}

async function rememberAll(path, data, ctx, method) {
  if (data?.sale) rememberSale(data.sale)
  if (method !== 'GET') return
  if (/^\/sales\?(.*&)?status=SAVED(&|$)/.test(path) && data?.sales) await rememberTabs(ctx.branchId, data.sales)
  const rule = ruleFor(path)
  if (!rule) return
  try { await kvSet(keyFor(rule, path, ctx), { data, at: Date.now() }) } catch {}
}

async function cached(path, ctx) {
  const rule = ruleFor(path)
  if (!rule) return null
  return (await kvGet(keyFor(rule, path, ctx)))?.data ?? null
}

async function updateCached(path, ctx, fn) {
  const rule = ruleFor(path)
  const key = keyFor(rule, path, ctx)
  const entry = await kvGet(key)
  if (!entry) return
  await kvSet(key, { ...entry, data: fn(entry.data) })
}

// ---------- unpaid tabs as last seen from the server ----------

// Every unpaid tab the till has seen (page loads, replies, live updates), so
// any of them can be paid when the internet drops.
const tabsKey = branchId => `tabs|${branchId}`

export async function rememberSale(sale) {
  if (!sale?.id || sale.local || !sale.branchId) return
  try {
    await tx(['kv'], 'readwrite', async s => {
      const map = (await done(s.kv.get(tabsKey(sale.branchId)))) ?? {}
      if (sale.status === 'SAVED') map[sale.id] = sale
      else delete map[sale.id]
      s.kv.put(map, tabsKey(sale.branchId))
    })
  } catch {}
}

async function rememberTabs(branchId, sales) {
  if (!branchId) return
  try { await kvSet(tabsKey(branchId), Object.fromEntries(sales.filter(x => !x.local && x.status === 'SAVED').map(x => [x.id, x]))) } catch {}
}

const knownTabs = async ctx => Object.values((await kvGet(tabsKey(ctx.branchId))) ?? {})

// ---------- sales recorded on this till ----------

const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0)

export function toDTO(r) {
  const subtotal = sum(r.lines, l => l.unitCents * l.qty)
  const discount = Math.min(r.discountCents ?? 0, subtotal)
  const total = subtotal - discount
  const paid = sum(r.payments, p => p.amountCents)
  return {
    id: r.kind === 'remote' ? r.serverId : r.clientId,
    clientId: r.clientId,
    local: true,
    // until the server gives it a number, the receipt number stands in
    number: r.kind === 'remote' ? r.number : r.offlineRef,
    offlineRef: r.kind === 'remote' ? null : r.offlineRef,
    branchId: r.branchId,
    status: r.status,
    label: r.label ?? null,
    customer: r.customerId ? { id: r.customerId, name: r.customerName ?? '', phone: null } : null,
    createdById: r.createdById,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    version: r.version,
    subtotalCents: subtotal,
    discountCents: discount,
    totalCents: total,
    paidCents: paid,
    dueCents: Math.max(0, total - paid),
    paidById: r.paidById ?? null,
    paidAt: r.paidAt ?? null,
    cancelledAt: null,
    refundedAt: null,
    lines: r.lines.map(l => ({ id: l.productId, productId: l.productId, name: l.name, unitCents: l.unitCents, qty: l.qty, lineCents: l.unitCents * l.qty })),
    payments: r.payments.map(p => ({
      id: p.clientId,
      method: p.method,
      amountCents: p.amountCents,
      tenderedCents: p.tenderedCents ?? null,
      changeCents: p.tenderedCents != null ? p.tenderedCents - p.amountCents : null,
      mpesaRef: p.mpesaRef ?? null,
      phone: p.phone ?? null,
      verification: p.method === 'CASH' ? 'CASH' : 'MANUAL_UNVERIFIED',
      receivedById: p.receivedById,
      createdAt: p.at
    })),
    mpesaRequests: []
  }
}

// The item sent to the server for a sale made on this till.
function saleOp(r) {
  return {
    opId: crypto.randomUUID(),
    type: 'sale',
    clientId: r.clientId,
    offlineRef: r.offlineRef,
    branchId: r.branchId,
    createdById: r.createdById,
    createdAt: r.createdAt,
    label: r.label || null,
    customerId: r.customerId ?? null,
    lines: r.lines.map(l => ({ productId: l.productId, name: l.name, unitCents: l.unitCents, qty: l.qty })),
    payments: r.payments.map(paymentOut)
  }
}
const paymentOut = p => ({
  clientId: p.clientId,
  method: p.method,
  amountCents: p.amountCents,
  tenderedCents: p.tenderedCents ?? null,
  mpesaRef: p.mpesaRef ?? null,
  phone: p.phone ?? null,
  receivedById: p.receivedById,
  at: p.at,
  shiftId: p.shiftId ?? null,
  shiftClientId: p.shiftClientId ?? null
})

const getSale = key => getOne('sales', key)

// Saves a sale and its place in the queue together.
async function saveLocal(r) {
  r.updatedAt = new Date().toISOString()
  if (r.kind === 'remote') {
    await tx(['sales'], 'readwrite', s => { s.sales.put(r) })
    return r
  }
  if (!r.lines.length) {
    // an emptied tab that never reached the server: nothing to send
    await tx(['sales'], 'readwrite', s => { s.sales.put(r) })
    await unqueue(r.clientId)
    return r
  }
  const op = saleOp(r)
  r.opId = op.opId
  await tx(['sales'], 'readwrite', s => { s.sales.put(r) })
  await queue('sale', r.clientId, op)
  return r
}

export const localSales = () => tx(['sales'], 'readonly', s => done(s.sales.getAll()))

// After the server has the sale: forget the local copy unless it changed since.
export async function syncedSale(clientId, opId) {
  await tx(['sales'], 'readwrite', async s => {
    const r = await done(s.sales.get(clientId))
    if (r && (r.opId === opId || r.kind === 'remote')) s.sales.delete(clientId)
  })
}
export async function syncedPay(saleId) {
  await tx(['sales'], 'readwrite', s => { s.sales.delete('srv:' + saleId) })
}

// ---------- prices and stock from the cached catalog ----------

async function priceLines(ctx, wanted, keep = new Map()) {
  const products = (await cached('/products', ctx))?.products ?? []
  const byId = new Map(products.map(p => [p.id, p]))
  const merged = new Map()
  for (const l of wanted) merged.set(l.productId, (merged.get(l.productId) ?? 0) + l.qty)
  return [...merged].map(([productId, qty]) => {
    if (qty > MAX_QTY) throw refuse(`Quantity for one product cannot be more than ${MAX_QTY}.`)
    const kept = keep.get(productId)
    if (kept) return { productId, qty, name: kept.name, unitCents: kept.unitCents }
    const p = byId.get(productId)
    if (!p) throw refuse('One of the products is not on this till yet. It can be added when the internet is back.', 'unknown_product')
    return { productId, qty, name: p.name, unitCents: p.priceCents }
  })
}

async function takeStock(ctx, lines) {
  await updateCached('/products', ctx, d => ({
    ...d,
    products: d.products.map(p => {
      const l = lines.find(x => x.productId === p.id)
      return l && p.qty != null ? { ...p, qty: p.qty - l.qty } : p
    })
  })).catch(() => {})
}

// ---------- shifts ----------

const localShiftKey = ctx => `shift|${ctx.branchId}|${ctx.user?.id}`

async function currentShift(ctx) {
  const local = await kvGet(localShiftKey(ctx))
  if (local?.open) return local
  const remote = (await cached('/shifts/current', ctx))?.shift
  return remote?.open ? remote : null
}

async function addCashToShift(ctx, shift, amountCents) {
  const bump = s => ({ ...s, cashTakenCents: (s.cashTakenCents ?? 0) + amountCents, expectedCashCents: (s.expectedCashCents ?? 0) + amountCents })
  if (shift.local) await kvSet(localShiftKey(ctx), bump(shift))
  else await updateCached('/shifts/current', ctx, d => (d?.shift ? { ...d, shift: bump(d.shift) } : d)).catch(() => {})
}

export async function syncedShift(ctx, clientId) {
  const key = localShiftKey(ctx)
  const s = await kvGet(key)
  if (s?.clientId === clientId) await kvSet(key, { ...s, synced: true })
}

async function openShift(ctx, body) {
  if (await currentShift(ctx)) throw new ApiError(409, 'shift_already_open', 'You already have an open shift in this branch. Close it first.')
  const float = Number(body?.openingFloatCents)
  if (!Number.isInteger(float) || float < 0) throw refuse('Enter the cash in the drawer.')
  const clientId = crypto.randomUUID()
  const at = new Date().toISOString()
  const shift = {
    id: clientId,
    clientId,
    local: true,
    branchId: ctx.branchId,
    userId: ctx.user.id,
    userName: ctx.user.name,
    openedAt: at,
    closedAt: null,
    open: true,
    openingFloatCents: float,
    cashTakenCents: 0,
    mpesaTakenCents: 0,
    cashRefundsCents: 0,
    expectedCashCents: float,
    countedCashCents: null,
    varianceCents: null,
    closeNote: null
  }
  await kvSet(localShiftKey(ctx), shift)
  await queue('shift_open', null, { opId: crypto.randomUUID(), type: 'shift_open', clientId, branchId: ctx.branchId, userId: ctx.user.id, openingFloatCents: float, at })
  return { shift }
}

// ---------- payments ----------

const CODE = /^[A-Z0-9]{10}$/

async function codeUsedOnTill(code) {
  const all = await localSales()
  return all.some(r => r.payments.some(p => p.mpesaRef === code))
}

async function takePayments(ctx, r, items) {
  const dto = toDTO(r)
  const due = dto.dueCents
  const total = sum(items, p => Number(p.amountCents) || 0)
  if (!dto.lines.length || dto.totalCents <= 0) throw refuse('Add items before taking payment.', 'sale_empty')
  if (total > due) throw refuse(`Only KSh ${due / 100} is still due on this sale.`, 'overpayment')
  const me = await kvGet('me:current')
  if (me?.user?.requireMpesaCode !== false && items.some(p => p.method === 'MPESA' && !p.mpesaRef)) {
    throw refuse("Type the M-Pesa code from the customer's message.", 'mpesa_code_required')
  }
  const codes = items.filter(p => p.method === 'MPESA' && p.mpesaRef).map(p => p.mpesaRef)
  if (new Set(codes).size !== codes.length) throw refuse('The same M-Pesa code was entered twice.', 'mpesa_code_repeated')
  for (const c of codes) {
    if (!CODE.test(c ?? '')) throw refuse('M-Pesa code must be 10 letters or digits.')
    if (await codeUsedOnTill(c)) throw new ApiError(409, 'mpesa_code_used', 'This M-Pesa code is already linked to another sale.')
  }
  const shift = await currentShift(ctx)
  if (!shift && items.some(p => p.method === 'CASH')) throw refuse('Open a shift before taking cash.', 'no_open_shift')
  const at = new Date().toISOString()
  for (const p of items) {
    if (!(p.amountCents > 0)) throw refuse('Payment amount must be more than zero.', 'bad_amount')
    if (p.method === 'CASH' && p.tenderedCents != null && p.tenderedCents < p.amountCents) throw refuse('Cash received is less than the amount being paid.', 'short_cash')
    r.payments.push({
      clientId: p.clientId ?? crypto.randomUUID(),
      method: p.method,
      amountCents: p.amountCents,
      tenderedCents: p.method === 'CASH' ? (p.tenderedCents ?? p.amountCents) : null,
      mpesaRef: p.method === 'MPESA' ? p.mpesaRef : null,
      phone: p.phone ?? null,
      receivedById: ctx.user.id,
      receivedByName: ctx.user.name,
      at,
      shiftId: shift && !shift.local ? shift.id : null,
      shiftClientId: shift?.local ? shift.clientId : null
    })
  }
  const paidNow = sum(r.payments, p => p.amountCents) >= dto.totalCents
  if (paidNow) {
    r.status = 'PAID'
    r.paidAt = at
    r.paidById = ctx.user.id
    r.paidByName = ctx.user.name
  }
  r.version += 1
  const cashIn = sum(items.filter(p => p.method === 'CASH'), p => p.amountCents)
  if (cashIn && shift) await addCashToShift(ctx, shift, cashIn)
  if (paidNow) await takeStock(ctx, r.lines)
  const change = sum(items, p => (p.method === 'CASH' && p.tenderedCents != null ? p.tenderedCents - p.amountCents : 0))
  return { paidNow, change }
}

// ---------- the requests ----------

async function unpaidList(ctx) {
  const remote = await knownTabs(ctx)
  const mine = (await localSales()).filter(r => r.branchId === ctx.branchId)
  const settled = new Set(mine.filter(r => r.kind === 'remote').map(r => r.serverId))
  const local = mine.filter(r => r.kind !== 'remote' && r.status === 'SAVED' && r.lines.length).map(toDTO)
  const sales = [...local, ...remote.filter(s => !settled.has(s.id))].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  return { sales }
}

async function findSale(ctx, id) {
  if (isLocalId(id)) {
    const r = await getSale(id)
    if (r) return { record: r }
  }
  const settled = await getSale('srv:' + id)
  if (settled) return { record: settled }
  const tab = (await knownTabs(ctx)).find(s => s.id === id)
  if (tab) return { tab }
  return null
}

function vatIncludedCents(totalCents, vatRateBps) {
  if (!(vatRateBps > 0) || totalCents <= 0) return 0
  const scaled = totalCents * 10000
  const divisor = 10000 + vatRateBps
  const rest = scaled % divisor
  return totalCents - ((scaled - rest) / divisor + (rest * 2 >= divisor ? 1 : 0))
}

async function receiptFor(ctx, r) {
  if (r.status !== 'PAID') throw refuse('A receipt is only available once the sale is paid.', 'sale_not_paid')
  const d = toDTO(r)
  const biz = (await getBusiness()) ?? {}
  const me = await kvGet('me:current')
  const branch = me?.branches?.find(b => b.id === r.branchId)
  return {
    receipt: {
      businessName: biz.name ?? '',
      business: biz,
      branchName: branch?.name ?? '',
      saleId: d.id,
      number: d.number,
      offlineRef: r.kind === 'remote' ? null : r.offlineRef,
      offline: true,
      status: 'PAID',
      label: d.label,
      customer: d.customer,
      createdAt: d.createdAt,
      paidAt: d.paidAt,
      refundedAt: null,
      createdBy: { id: r.createdById, name: r.createdByName ?? '' },
      paidBy: { id: r.paidById, name: r.paidByName ?? '' },
      lines: d.lines.map(l => ({ productId: l.productId, name: l.name, qty: l.qty, unitCents: l.unitCents, lineCents: l.lineCents })),
      subtotalCents: d.subtotalCents,
      discountCents: d.discountCents,
      totalCents: d.totalCents,
      vatCents: vatIncludedCents(d.totalCents, biz.vatRateBps ?? 0),
      paidCents: d.paidCents,
      payments: d.payments.map(p => ({ ...p, receivedBy: { name: r.paidByName ?? '' } })),
      changeCents: sum(d.payments, p => p.changeCents ?? 0)
    }
  }
}

function parse(path) {
  const [p, q = ''] = path.split('?')
  return { parts: p.split('/').filter(Boolean), query: new URLSearchParams(q) }
}

export async function handleOffline(method, path, body, ctx) {
  const { parts } = parse(path)
  const [root, id, sub] = parts

  if (method === 'GET') {
    if (path === '/mpesa/status') return { prompts: false, simulation: false }
    if (root === 'sales' && !id && /status=SAVED/.test(path)) return unpaidList(ctx)
    if (root === 'shifts' && id === 'current') return { shift: await currentShift(ctx) }
    if (root === 'sales' && id) {
      const found = await findSale(ctx, id)
      if (!found) throw needsInternet('Opening this sale')
      if (sub === 'receipt') {
        if (!found.record) throw needsInternet('This receipt')
        return receiptFor(ctx, found.record)
      }
      if (!sub) return { sale: found.record ? toDTO(found.record) : found.tab }
    }
    const hit = await cached(path, ctx)
    if (hit) return hit
    throw needsInternet('This page')
  }

  if (!ctx.user) throw needsInternet()

  if (method === 'POST' && root === 'sales' && !id) {
    const clientId = body.clientId && isLocalId(body.clientId) ? body.clientId : crypto.randomUUID()
    const existing = await getSale(clientId)
    if (existing) return { sale: toDTO(existing) }
    const lines = await priceLines(ctx, body.lines ?? [])
    if (!lines.length) throw refuse('Add at least one item.')
    const now = new Date().toISOString()
    const r = await saveLocal({
      clientId,
      kind: 'local',
      offlineRef: await nextOfflineRef(),
      branchId: ctx.branchId,
      createdById: ctx.user.id,
      createdByName: ctx.user.name,
      createdAt: now,
      label: body.label || null,
      customerId: body.customerId ?? null,
      customerName: body.customerName ?? null,
      lines,
      payments: [],
      status: 'SAVED',
      version: 1
    })
    return { sale: toDTO(r) }
  }

  if (root === 'sales' && id && method === 'PUT' && sub === 'lines') {
    const r = isLocalId(id) ? await getSale(id) : null
    if (!r) throw needsInternet('Changing a tab from before the internet dropped')
    if (r.status !== 'SAVED') throw refuse(`Sale ${r.offlineRef} is ${r.status.toLowerCase()} and cannot be changed.`, 'sale_not_editable')
    if (body.version !== r.version) throw new ApiError(409, 'stale_sale', 'This sale was changed in another window. Review it and try again.', { sale: toDTO(r) })
    const keep = new Map(r.lines.map(l => [l.productId, l]))
    const lines = await priceLines(ctx, body.lines ?? [], keep)
    const paid = sum(r.payments, p => p.amountCents)
    if (paid > 0 && sum(lines, l => l.unitCents * l.qty) <= paid) throw refuse(`${paid / 100} has already been paid on this sale. The new total must stay above that.`, 'below_paid')
    r.lines = lines
    r.version += 1
    return { sale: toDTO(await saveLocal(r)) }
  }

  if (root === 'sales' && id && method === 'PATCH' && !sub) {
    const r = isLocalId(id) ? await getSale(id) : null
    if (!r) throw needsInternet('Changing a tab from before the internet dropped')
    if (body.label !== undefined) r.label = body.label || null
    if (body.customerId !== undefined) { r.customerId = body.customerId; r.customerName = body.customerName ?? null }
    return { sale: toDTO(await saveLocal(r)) }
  }

  if (root === 'sales' && id && method === 'POST' && sub === 'pay') {
    const items = body.payments ?? []
    const found = await findSale(ctx, id)
    if (!found) throw needsInternet('Paying this sale')
    if (found.record?.kind === 'remote' || found.record?.status === 'PAID') {
      if (found.record.status === 'PAID') {
        // the same payment again (a retry): answer as before
        const ids = items.map(p => p.clientId).filter(Boolean)
        if (ids.length && ids.every(c => found.record.payments.some(p => p.clientId === c))) return { sale: toDTO(found.record), changeCents: 0 }
        throw refuse('This sale is already paid.', 'sale_not_payable')
      }
    }
    if (found.record && found.record.kind !== 'remote') {
      const r = found.record
      const { change } = await takePayments(ctx, r, items)
      await saveLocal(r)
      return { sale: toDTO(r), changeCents: change }
    }
    // a tab from before the outage: pay it here, send the payment later
    const tab = found.tab ?? toDTO(found.record)
    const r = found.record ?? {
      clientId: 'srv:' + tab.id,
      kind: 'remote',
      serverId: tab.id,
      number: tab.number,
      branchId: tab.branchId,
      createdById: tab.createdById,
      createdAt: tab.createdAt,
      label: tab.label,
      customerId: tab.customer?.id ?? null,
      customerName: tab.customer?.name ?? null,
      lines: tab.lines.map(l => ({ productId: l.productId, name: l.name, unitCents: l.unitCents, qty: l.qty })),
      discountCents: tab.discountCents,
      // payments taken before the outage count towards what is due
      payments: (tab.payments ?? []).map(p => ({
        clientId: p.clientId ?? p.id,
        prior: true,
        method: p.method,
        amountCents: p.amountCents,
        tenderedCents: p.tenderedCents ?? null,
        mpesaRef: p.mpesaRef ?? null,
        phone: p.phone ?? null,
        receivedById: p.receivedById,
        at: p.createdAt
      })),
      seenTotalCents: tab.totalCents,
      status: 'SAVED',
      version: tab.version
    }
    const before = r.payments.length
    const { change } = await takePayments(ctx, r, items)
    await saveLocal(r)
    await queue('pay', null, { opId: crypto.randomUUID(), type: 'pay', saleId: r.serverId, seenTotalCents: r.seenTotalCents, payments: r.payments.slice(before).map(paymentOut) })
    return { sale: toDTO(r), changeCents: change }
  }

  if (root === 'shifts' && id === 'open' && method === 'POST') return openShift(ctx, body)
  if (root === 'shifts' && sub === 'close') throw needsInternet('Closing a shift')
  if (root === 'mpesa') throw needsInternet('The M-Pesa prompt')
  if (root === 'approvals') throw needsInternet('Asking a manager')
  throw needsInternet()
}

// Tabs, shifts and stock as this till sees them right now, for the top bar.
export async function offlineSummary() {
  const all = await localSales()
  return { unsyncedSales: all.length }
}

// ---------- while online, with offline work still on its way ----------

// A sale only this till knows about (made offline, not yet sent), or a tab
// paid offline whose payment is not on the server yet: answer it here.
export async function belongsHere(path) {
  const m = /^\/sales\/([^/?]+)/.exec(path)
  if (!m) return false
  try {
    const id = m[1]
    if (isLocalId(id)) return !!(await getSale(id))
    return !!(await getSale('srv:' + id))
  } catch {
    // storage unavailable: behave as a plain online till
    return false
  }
}

// The server's answer, plus what this till did offline that it has not heard about yet.
export async function withLocal(path, data, ctx) {
  try {
    if (/^\/sales\?(.*&)?status=SAVED(&|$)/.test(path) && data?.sales) {
      const mine = (await localSales()).filter(r => r.branchId === ctx.branchId)
      const settled = new Set(mine.filter(r => r.kind === 'remote').map(r => r.serverId))
      const known = new Set(data.sales.map(s => s.clientId).filter(Boolean))
      const extra = mine.filter(r => r.kind !== 'remote' && r.status === 'SAVED' && r.lines.length && !known.has(r.clientId)).map(toDTO)
      return { ...data, sales: [...extra, ...data.sales.filter(s => !settled.has(s.id))].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) }
    }
    if (path === '/shifts/current' && data && !data.shift) {
      const local = await kvGet(localShiftKey(ctx))
      if (local?.open && !local.synced) return { shift: local }
    }
    if (path === '/shifts/current' && data?.shift) {
      const local = await kvGet(localShiftKey(ctx))
      if (local?.synced) await kvSet(localShiftKey(ctx), null)
    }
  } catch {}
  return data
}

// A sale made offline that is fully on the server now: use the server's id.
// While a newer state of it is still waiting here, keep answering it here.
export async function toServerPath(path) {
  const m = /^\/sales\/([0-9a-f-]{36})(\/.*)?$/i.exec(path)
  if (!m) return path
  try {
    if (await getSale(m[1])) return path
    const synced = await serverIdFor(m[1])
    return synced ? `/sales/${synced.id}${m[2] ?? ''}` : path
  } catch {
    return path
  }
}
