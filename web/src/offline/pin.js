import { kvGet, kvSet } from './db.js'

// Signing in without internet. When someone signs in online, the till keeps a
// slow, salted fingerprint of their PIN (never the PIN itself). Offline, the
// PIN typed is checked against it. Only people who signed in on this till
// before can sign in offline, for 14 days after their last online sign in, and
// anyone switched off by the owner is forgotten the next time the till is online.

const ITERATIONS = 200_000
const VALID_MS = 14 * 24 * 60 * 60 * 1000
const MAX_TRIES = 5
const LOCK_MS = 5 * 60 * 1000
const KEY = 'pins'

const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0))

async function derive(pin, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256)
  return b64(bits)
}

const all = async () => (await kvGet(KEY)) ?? {}

export class OfflineSignInError extends Error {}

export async function rememberPin(username, pin, me) {
  if (!crypto?.subtle) return
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(pin, salt, ITERATIONS)
  const pins = await all()
  pins[username.toLowerCase()] = { userId: me.user.id, salt: b64(salt), hash, iterations: ITERATIONS, savedAt: Date.now(), failed: 0, lockedUntil: 0, me }
  await kvSet(KEY, pins)
}

// Keep the cached details (role, branches) current while online.
export async function refreshMe(me) {
  const pins = await all()
  const entry = Object.values(pins).find(p => p.userId === me.user.id)
  if (!entry) return
  entry.me = me
  await kvSet(KEY, pins)
}

export async function checkPin(username, pin) {
  const name = username.trim().toLowerCase()
  const pins = await all()
  const p = pins[name]
  if (!p || Date.now() - p.savedAt > VALID_MS) {
    throw new OfflineSignInError('No internet, and this person has not signed in on this till in the last 14 days, so they cannot sign in offline.')
  }
  if (p.lockedUntil > Date.now()) {
    const mins = Math.ceil((p.lockedUntil - Date.now()) / 60000)
    throw new OfflineSignInError(`Too many wrong PINs. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`)
  }
  const hash = await derive(pin, unb64(p.salt), p.iterations)
  if (hash !== p.hash) {
    p.failed += 1
    if (p.failed >= MAX_TRIES) { p.failed = 0; p.lockedUntil = Date.now() + LOCK_MS }
    await kvSet(KEY, pins)
    throw new OfflineSignInError('Wrong username or PIN.')
  }
  p.failed = 0
  p.lockedUntil = 0
  await kvSet(KEY, pins)
  return p.me
}

export async function pinUserIds() {
  return Object.values(await all()).map(p => p.userId)
}

// Forget everyone the server no longer lists as active staff.
export async function keepOnly(activeIds) {
  const keep = new Set(activeIds)
  const pins = await all()
  let changed = false
  for (const [name, p] of Object.entries(pins)) {
    if (!keep.has(p.userId)) { delete pins[name]; changed = true }
  }
  if (changed) await kvSet(KEY, pins)
}

export async function hasOfflineUsers() {
  const pins = await all()
  return Object.values(pins).some(p => Date.now() - p.savedAt <= VALID_MS)
}
