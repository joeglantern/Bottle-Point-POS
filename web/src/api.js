import { io } from 'socket.io-client'

// Thin client for the Bottle Point API. Same origin (Vite proxies /api in
// development, nginx in production), so the session cookie just works.

import { ApiError } from './apierror.js'
import { belongsHere, handleOffline, remember, rememberSale, toServerPath, withLocal } from './offline/local.js'
import { isOnline, markReachable, markUnreachable, TIMEOUT_GET_MS, TIMEOUT_WRITE_MS } from './offline/net.js'
export { ApiError }

let branchId = null
export const setBranch = id => { branchId = id }
export const getBranch = () => branchId

let user = null
// who is working, for things recorded on the till while offline
export const setUser = u => { user = u ? { id: u.id, name: u.name } : null }

// Session calls are handled by session.jsx when the server cannot be reached.
const sessionCall = path => path.startsWith('/session/') && path !== '/session/tenant'

async function request(method, path, body) {
  const ctx = { branchId, user }
  // a sale made offline that the server now has: use the server's id
  path = await toServerPath(path)
  // only this till knows this sale yet
  if (!sessionCall(path) && (await belongsHere(path))) return handleOffline(method, path, body ?? {}, ctx)
  if (!isOnline() && !sessionCall(path)) return handleOffline(method, path, body ?? {}, ctx)

  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (branchId) headers['x-branch-id'] = branchId
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), method === 'GET' ? TIMEOUT_GET_MS : TIMEOUT_WRITE_MS)
  let res
  try {
    res = await fetch('/api' + path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal
    })
  } catch {
    markUnreachable()
    // Carry on from the till. Sales and payments carry their own ids, so if
    // the server did get this request, the sync recognises it: never twice.
    if (!sessionCall(path)) return handleOffline(method, path, body ?? {}, ctx)
    throw new ApiError(0, 'offline', 'Cannot reach the server. Check the connection.')
  } finally {
    clearTimeout(timer)
  }
  // a proxy answering for a server that is down
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    markUnreachable()
    if (!sessionCall(path)) return handleOffline(method, path, body ?? {}, ctx)
  } else {
    markReachable()
  }
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  if (!res.ok) {
    const e = data && data.error
    if (res.status === 401) window.dispatchEvent(new Event('bp:signed-out'))
    // suspended or cancelled subscription: the app shows why, everywhere at once
    if (res.status === 402 && e && /^subscription_/.test(e.code)) window.dispatchEvent(new CustomEvent('bp:subscription', { detail: { code: e.code, message: e.message } }))
    // "Invalid input." alone does not help anyone: show what was wrong
    let message = e ? e.message : 'Something went wrong.'
    if (e && message === 'Invalid input.' && e.details) {
      const first = [...(e.details.formErrors ?? []), ...Object.values(e.details.fieldErrors ?? {}).flat()][0]
      if (first) message = /[.!?]$/.test(first) ? first : first + '.'
    }
    throw new ApiError(res.status, e ? e.code : 'http_' + res.status, message, e && e.details)
  }
  // keep what the till needs to carry on offline
  remember(path, data, ctx, method)
  if (method === 'GET') return withLocal(path, data, ctx)
  return data
}

export const api = {
  get: p => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b = {}) => request('PUT', p, b),
  patch: (p, b = {}) => request('PATCH', p, b),
  del: p => request('DELETE', p)
}

export const qs = params => {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, v)
  const out = s.toString()
  return out ? '?' + out : ''
}

// One socket for the whole app, opened after sign in.
let socket = null
export function connectSocket() {
  if (socket) return socket
  socket = io({ path: '/socket.io', withCredentials: true, transports: ['websocket', 'polling'] })
  // tabs changed on other tills: keep them, so they can be paid offline too
  socket.on('sale:updated', p => rememberSale(p?.sale))
  return socket
}
export function disconnectSocket() {
  if (socket) socket.close()
  socket = null
}

// Money comes from the API in cents.
export const ksh = cents => 'KSh ' + Math.round((cents || 0) / 100).toLocaleString('en-KE')
export const toCents = shillings => Math.round(Number(shillings || 0) * 100)
