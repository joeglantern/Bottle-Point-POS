// Is the server reachable? The browser's own online flag is not enough: Wi-Fi
// can be up while the internet behind it is down. So a failed request marks
// the server unreachable, and a quiet check brings it back.

let serverDown = false
const subs = new Set()
let probe = null

const notify = () => { for (const fn of subs) fn(isOnline()) }

export const isOnline = () => (typeof navigator === 'undefined' || navigator.onLine !== false) && !serverDown

export function onNetChange(fn) {
  subs.add(fn)
  return () => subs.delete(fn)
}

export function markReachable() {
  if (!serverDown) return
  serverDown = false
  stopProbe()
  notify()
}

export function markUnreachable() {
  if (serverDown) return
  serverDown = true
  startProbe()
  notify()
}

async function check() {
  if (navigator.onLine === false) return
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 5000)
    const res = await fetch('/api/health', { cache: 'no-store', signal: ctrl.signal })
    clearTimeout(t)
    if (res.ok) markReachable()
  } catch {}
}

function startProbe() {
  if (probe) return
  probe = setInterval(check, 8000)
}
function stopProbe() {
  clearInterval(probe)
  probe = null
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { check(); notify() })
  window.addEventListener('offline', notify)
}

// Seconds to wait before treating the server as unreachable.
export const TIMEOUT_GET_MS = 8000
export const TIMEOUT_WRITE_MS = 15000
