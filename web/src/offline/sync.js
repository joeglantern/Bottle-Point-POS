import { kvGet, kvSet } from './db.js'
import { getDevice } from './device.js'
import { isOnline, markReachable, markUnreachable, onNetChange } from './net.js'
import { failedItems, pending, refused, sent } from './outbox.js'
import { syncedPay, syncedSale, syncedShift } from './local.js'
import { rememberServerId } from './ids.js'
export { serverIdFor } from './ids.js'

// Sends what the till recorded offline, oldest first, whenever the server is
// reachable. Safe to run any number of times, from any number of tabs: the
// server recognises everything it has already received.

const BATCH = 10
const MAX_BYTES = 80_000
let running = false
let again = false

const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }))

function batchOf(rows) {
  const out = []
  let bytes = 0
  for (const r of rows) {
    const size = JSON.stringify(r.op).length
    if (out.length && (out.length >= BATCH || bytes + size > MAX_BYTES)) break
    out.push(r)
    bytes += size
  }
  return out
}

async function send(device, ops) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 30_000)
  try {
    return await fetch('/api/offline/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device-token': device.token },
      body: JSON.stringify({ ops }),
      signal: ctrl.signal
    })
  } finally {
    clearTimeout(t)
  }
}

async function runOnce() {
  let total = 0
  for (;;) {
    const rows = (await pending()).sort((a, b) => a.seq - b.seq)
    if (!rows.length) break
    const device = await getDevice()
    if (!device) break
    const batch = batchOf(rows)
    let res
    try {
      res = await send(device, batch.map(r => r.op))
    } catch {
      markUnreachable()
      break
    }
    if (res.status === 401) {
      await kvSet('syncProblem', 'This till is no longer registered, so its offline sales cannot be sent. Download them from the banner and give the file to the owner.')
      emit('bp:sync-state')
      break
    }
    if (!res.ok) break
    markReachable()
    await kvSet('syncProblem', null)
    const { results } = await res.json()
    let stop = false
    for (const r of results) {
      const row = batch.find(b => b.op.opId === r.opId)
      if (!row) continue
      if (r.status === 'ok') {
        if (row.op.type === 'sale' && r.sale) {
          await rememberServerId(row.op.clientId, r.sale)
          await syncedSale(row.op.clientId, row.op.opId)
        }
        if (row.op.type === 'pay') await syncedPay(row.op.saleId)
        if (row.op.type === 'shift_open') await syncedShift({ branchId: row.op.branchId, user: { id: row.op.userId } }, row.op.clientId)
        await sent(r.opId)
        total++
      } else if (r.status === 'rejected') {
        await refused(r.opId, r.message)
        emit('bp:sync-refused', { message: r.message })
      } else {
        // the server will take it later: keep the order, try again later
        stop = true
        break
      }
    }
    if (stop) break
  }
  if (total) emit('bp:synced', { count: total })
  emit('bp:sync-state')
}

export async function syncNow() {
  if (!isOnline()) return
  if (running) { again = true; return }
  running = true
  try {
    const go = () => runOnce()
    // one tab at a time; the others skip (the server would also cope)
    if (navigator.locks?.request) await navigator.locks.request('bp-sync', { ifAvailable: true }, lock => (lock ? go() : null))
    else await go()
  } catch (err) {
    console.warn('sync', err)
  } finally {
    running = false
    if (again) { again = false; setTimeout(syncNow, 500) }
  }
}

let started = false
export function startSync() {
  if (started) return
  started = true
  onNetChange(up => up && syncNow())
  window.addEventListener('bp:outbox', () => setTimeout(syncNow, 300))
  setInterval(syncNow, 20_000)
  syncNow()
}

export async function syncState() {
  const [rows, failed, problem] = await Promise.all([pending(), failedItems(), kvGet('syncProblem')])
  return { waiting: rows.length, refused: failed.length, problem: problem ?? null }
}
