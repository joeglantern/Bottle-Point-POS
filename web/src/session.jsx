import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { api, connectSocket, disconnectSocket, setBranch, setUser } from './api.js'
import { kvGet, kvSet } from './offline/db.js'
import { prepareOffline } from './offline/device.js'
import { isOnline, onNetChange } from './offline/net.js'
import { checkPin, refreshMe, rememberPin } from './offline/pin.js'
import { startSync, syncState } from './offline/sync.js'

// Who is signed in, which branch they are working in, and the live socket.

const SessionCtx = createContext(null)
export const useSession = () => useContext(SessionCtx)

const RANK = { CASHIER: 1, MANAGER: 2, OWNER: 3 }
export const atLeast = (user, role) => !!user && RANK[user.role] >= RANK[role]

function savedBranch() {
  try { return localStorage.getItem('bp-branch') } catch { return null }
}

const signedOutState = notice => ({ loading: false, user: null, branches: [], branchId: null, offline: false, notice: notice ?? null })

// Ends whatever session the browser still holds, once the server is reachable.
// Set when someone signs out, or someone else signs in, without internet.
async function clearPendingLogout() {
  if (!(await kvGet('pendingLogout').catch(() => null)) || !isOnline()) return
  try {
    const res = await fetch('/api/session/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' })
    if (res.ok || res.status === 401) await kvSet('pendingLogout', false)
  } catch {}
}

export function SessionProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, branches: [], branchId: null, offline: false, notice: null })
  const [connected, setConnected] = useState(false)
  const listeners = useRef(new Map())

  // offline: signed in on this till without the server (no session yet)
  const applyMe = useCallback((me, offline = false) => {
    const remembered = savedBranch()
    const branchId = me.branches.some(b => b.id === remembered) ? remembered : me.branches[0]?.id ?? null
    setBranch(branchId)
    setUser(me.user)
    kvSet('me:current', me).catch(() => {})
    setState({ loading: false, user: me.user, branches: me.branches, branding: me.branding ?? null, branchId, offline, notice: null })
    if (!offline) {
      refreshMe(me).catch(() => {})
      prepareOffline(me.branches.find(b => b.id === branchId)?.name)
    }
  }, [])

  const signedOut = useCallback(notice => {
    setBranch(null)
    setUser(null)
    kvSet('me:current', null).catch(() => {})
    setState(signedOutState(notice))
  }, [])

  const refresh = useCallback(async () => {
    await clearPendingLogout()
    try {
      applyMe(await api.get('/session/me'))
    } catch (e) {
      // no internet: carry on as whoever was signed in on this till
      if (e.status === 0) {
        const me = await kvGet('me:current').catch(() => null)
        if (me) return applyMe(me, true)
      }
      setBranch(null)
      setUser(null)
      setState(signedOutState())
    }
  }, [applyMe])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { startSync() }, [])

  // The internet is back after an offline sign in: the server needs a real
  // session. Offline sales sync on their own (the till's key), so nothing waits.
  const offlineRef = useRef(false)
  offlineRef.current = state.offline
  useEffect(() => onNetChange(async up => {
    if (!up || !offlineRef.current) return
    await clearPendingLogout()
    try {
      const me = await api.get('/session/me')
      const was = await kvGet('offlineUser').catch(() => null)
      if (me.user.id === was) return applyMe(me)
    } catch {}
    signedOut('The internet is back. Enter your PIN to carry on.')
  }), [applyMe, signedOut])

  // A 401 anywhere means the session ended (expired, PIN reset, switched off).
  useEffect(() => {
    const out = () => setState(s => {
      if (!s.user) return s
      setUser(null)
      kvSet('me:current', null).catch(() => {})
      return signedOutState(s.offline ? 'The internet is back. Enter your PIN to carry on.' : null)
    })
    window.addEventListener('bp:signed-out', out)
    return () => window.removeEventListener('bp:signed-out', out)
  }, [])

  // One socket while signed in. Events fan out to whoever subscribed.
  useEffect(() => {
    if (!state.user || state.offline) {
      disconnectSocket()
      setConnected(false)
      return
    }
    const s = connectSocket()
    const onAny = (event, payload) => {
      const set = listeners.current.get(event)
      if (set) for (const fn of set) fn(payload)
    }
    s.on('connect', () => setConnected(true))
    s.on('disconnect', () => setConnected(false))
    s.onAny(onAny)
    if (s.connected) setConnected(true)
    return () => {
      s.offAny(onAny)
      s.off('connect')
      s.off('disconnect')
    }
  }, [state.user, state.offline])

  const subscribe = useCallback((event, fn) => {
    if (!listeners.current.has(event)) listeners.current.set(event, new Set())
    listeners.current.get(event).add(fn)
    return () => listeners.current.get(event)?.delete(fn)
  }, [])

  const login = async (username, pin) => {
    try {
      await api.post('/session/pin', { username, pin })
    } catch (e) {
      if (e.status !== 0) throw e
      // no internet: check the PIN against what this till keeps
      const me = await checkPin(username, pin)
      await kvSet('pendingLogout', true)
      await kvSet('offlineUser', me.user.id)
      return applyMe(me, true)
    }
    const me = await api.get('/session/me')
    await rememberPin(username, pin, me).catch(() => {})
    await kvSet('offlineUser', null).catch(() => {})
    applyMe(me)
  }

  const logout = async () => {
    try { await api.post('/session/logout') } catch { await kvSet('pendingLogout', true).catch(() => {}) }
    disconnectSocket()
    signedOut()
  }

  const chooseBranch = id => {
    setBranch(id)
    try { localStorage.setItem('bp-branch', id) } catch {}
    setState(s => ({ ...s, branchId: id }))
  }

  const branch = state.branches.find(b => b.id === state.branchId) ?? null

  return (
    <SessionCtx.Provider value={{ ...state, branch, connected, login, logout, chooseBranch, subscribe, refresh }}>
      {children}
    </SessionCtx.Provider>
  )
}

// Subscribe to a socket event for the life of a component.
export function useLive(event, fn) {
  const { subscribe } = useSession()
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => subscribe(event, p => ref.current(p)), [event, subscribe])
}

// Load something from the API, with reload. Re-runs when deps change.
export function useApi(path, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true })
  const seq = useRef(0)
  const load = useCallback(async () => {
    if (!path) return
    const n = ++seq.current
    setState(s => ({ ...s, loading: true }))
    try {
      const data = await api.get(path)
      if (n === seq.current) setState({ data, error: null, loading: false })
    } catch (error) {
      if (n === seq.current) setState(s => ({ data: s.data, error, loading: false }))
    }
  }, [path])
  useEffect(() => { load() }, [load, ...deps])
  const setData = fn => setState(s => ({ ...s, data: typeof fn === 'function' ? fn(s.data) : fn }))
  return { ...state, reload: load, setData }
}

// Whether the server can be reached right now.
export function useOnline() {
  const [online, setOnline] = useState(isOnline)
  useEffect(() => onNetChange(setOnline), [])
  return online
}

// What this till still has to send, and anything the server refused.
export function useSyncState() {
  const [state, setState] = useState({ waiting: 0, refused: 0, problem: null })
  useEffect(() => {
    let live = true
    const load = () => syncState().then(s => live && setState(s), () => {})
    load()
    const events = ['bp:outbox', 'bp:synced', 'bp:sync-state']
    for (const e of events) window.addEventListener(e, load)
    return () => { live = false; for (const e of events) window.removeEventListener(e, load) }
  }, [])
  return state
}
