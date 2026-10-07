import { io } from 'socket.io-client'

// Thin client for the Bottle Point API. Same origin (Vite proxies /api in
// development, nginx in production), so the session cookie just works.

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

let branchId = null
export const setBranch = id => { branchId = id }
export const getBranch = () => branchId

async function request(method, path, body) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (branchId) headers['x-branch-id'] = branchId
  let res
  try {
    res = await fetch('/api' + path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  } catch {
    throw new ApiError(0, 'offline', 'Cannot reach the server. Check the connection.')
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
  return socket
}
export function disconnectSocket() {
  if (socket) socket.close()
  socket = null
}

// Money comes from the API in cents.
export const ksh = cents => 'KSh ' + Math.round((cents || 0) / 100).toLocaleString('en-KE')
export const toCents = shillings => Math.round(Number(shillings || 0) * 100)
