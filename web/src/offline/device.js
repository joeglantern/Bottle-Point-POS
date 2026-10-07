import { done, keepStorage, kvGet, kvSet, tx } from './db.js'
import { keepOnly, pinUserIds } from './pin.js'

// This browser as a till: its code (T1, T2...), its own key for syncing, and
// the counter behind the receipt numbers it prints while offline (T2-0041).

export const getDevice = () => kvGet('device')

async function post(path, body, headers = {}) {
  const res = await fetch('/api' + path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  if (!res.ok) {
    const err = new Error('request failed ' + res.status)
    err.status = res.status
    throw err
  }
  return res.json()
}

async function register(branchName) {
  registering ??= post('/offline/devices', { name: branchName ? `${branchName} till` : undefined }).finally(() => { registering = null })
  const r = await registering
  let device = await getDevice()
  if (!device) {
    device = { id: r.device.id, code: r.device.code, token: r.token, seq: 0, createdAt: Date.now() }
    await kvSet('device', device)
  }
  return device
}

let registering = null

// Called whenever someone is signed in with internet. Registers the till the
// first time, then just refreshes what it keeps for offline use.
export async function prepareOffline(branchName) {
  try {
    await keepStorage()
    let device = (await getDevice()) ?? (await register(branchName))
    // tell the server who signed in here; a till it no longer knows (removed
    // by the owner) registers again under a new code
    try {
      await post('/offline/devices/seen', {}, { 'x-device-token': device.token })
    } catch (e) {
      if (e.status !== 404) throw e
      await kvSet('retiredDevice', device)
      await kvSet('device', null)
      device = await register(branchName)
      await post('/offline/devices/seen', {}, { 'x-device-token': device.token })
    }
    const ids = await pinUserIds()
    const res = await fetch('/api/offline/bootstrap' + (ids.length ? '?users=' + encodeURIComponent(ids.join(',')) : ''), { credentials: 'same-origin' })
    if (res.ok) {
      const b = await res.json()
      await kvSet('business', b.business)
      await kvSet('clockSkewMs', Date.parse(b.serverTime) - Date.now())
      if (ids.length) await keepOnly(b.activeStaff)
    }
    return device
  } catch {
    return null
  }
}

// The next receipt number for a sale made on this till while offline.
// One transaction, so two sales can never get the same number.
export async function nextOfflineRef() {
  return tx(['kv'], 'readwrite', async s => {
    const device = await done(s.kv.get('device'))
    if (!device) throw new Error('This till is not set up for offline sales yet. Sign in once with internet.')
    device.seq = (device.seq ?? 0) + 1
    s.kv.put(device, 'device')
    return `${device.code}-${String(device.seq).padStart(4, '0')}`
  })
}

export const getBusiness = () => kvGet('business')
