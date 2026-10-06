// History API router for the console. No library, no basename.
import { createElement, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'

const listeners = new Set()
let lastPath = typeof location !== 'undefined' ? location.pathname : '/'

function emit() {
  if (location.pathname !== lastPath) {
    lastPath = location.pathname
    // New view starts at the top. Query changes keep the scroll position.
    window.scrollTo(0, 0)
    const main = document.getElementById('cx-main')
    if (main) main.scrollTop = 0
  }
  listeners.forEach(fn => fn())
}

function subscribe(fn) {
  listeners.add(fn)
  window.addEventListener('popstate', emit)
  return () => {
    listeners.delete(fn)
    if (!listeners.size) window.removeEventListener('popstate', emit)
  }
}

const snapshot = () => location.pathname + location.search

export function navigate(to, { replace = false } = {}) {
  const url = new URL(to, location.href)
  const next = url.pathname + url.search + url.hash
  if (next === location.pathname + location.search + location.hash) return
  history[replace ? 'replaceState' : 'pushState'](null, '', next)
  emit()
}

export function parseQuery(search) {
  const out = {}
  new URLSearchParams(search).forEach((v, k) => { out[k] = v })
  return out
}

export function buildQuery(query) {
  const p = new URLSearchParams()
  Object.keys(query).forEach(k => {
    const v = query[k]
    if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v))
  })
  const s = p.toString()
  return s ? '?' + s : ''
}

// { path, segments, query, search }. Re renders on back, forward and navigate().
export function useRoute() {
  const key = useSyncExternalStore(subscribe, snapshot)
  return useMemo(() => {
    const [path, search = ''] = key.split('?')
    return {
      path,
      segments: path.split('/').filter(Boolean).map(decodeURIComponent),
      query: parseQuery(search),
      search: search ? '?' + search : ''
    }
  }, [key])
}

// [query, setQuery(patch, { replace })]. Empty values are removed. Changing
// any key other than page goes back to the first page unless the patch sets it.
export function useQuery() {
  const { query } = useRoute()
  const setQuery = useCallback((patch, { replace = false } = {}) => {
    const next = { ...parseQuery(location.search), ...patch }
    const touchesOther = Object.keys(patch).some(k => k !== 'page')
    if (touchesOther && !('page' in patch)) delete next.page
    navigate(location.pathname + buildQuery(next), { replace })
  }, [])
  return [query, setQuery]
}

export const ROUTES = [
  { name: 'overview', pattern: '/' },
  { name: 'clients', pattern: '/clients' },
  { name: 'client', pattern: '/clients/:id' },
  { name: 'subscriptions', pattern: '/subscriptions' },
  { name: 'invoices', pattern: '/invoices' },
  { name: 'invoice', pattern: '/invoices/:id' },
  { name: 'plans', pattern: '/plans' },
  { name: 'team', pattern: '/team' },
  { name: 'audit', pattern: '/audit' },
  { name: 'account', pattern: '/account' },
  { name: 'kit', pattern: '/_kit' }
]

// matchRoute('/clients/abc') -> { name: 'client', params: { id: 'abc' } } or null.
export function matchRoute(path, routes = ROUTES) {
  const parts = path.split('/').filter(Boolean)
  for (const route of routes) {
    const want = route.pattern.split('/').filter(Boolean)
    if (want.length !== parts.length) continue
    const params = {}
    const ok = want.every((w, i) => {
      if (w[0] === ':') { params[w.slice(1)] = decodeURIComponent(parts[i]); return true }
      return w === parts[i]
    })
    if (ok) return { name: route.name, params }
  }
  return null
}

// A real anchor. Only plain left clicks on same origin links are intercepted.
export function Link({ to, replace, onClick, target, children, ...rest }) {
  function click(e) {
    if (onClick) onClick(e)
    if (e.defaultPrevented || e.button !== 0 || target) return
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const url = new URL(to, location.href)
    if (url.origin !== location.origin) return
    e.preventDefault()
    navigate(to, { replace })
  }
  return createElement('a', { href: to, target, onClick: click, ...rest }, children)
}

export function useTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} · Bottle Point Console` : 'Bottle Point Console'
  }, [title])
}
