import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { api, connectSocket, disconnectSocket, setBranch } from './api.js'

// Who is signed in, which branch they are working in, and the live socket.

const SessionCtx = createContext(null)
export const useSession = () => useContext(SessionCtx)

const RANK = { CASHIER: 1, MANAGER: 2, OWNER: 3 }
export const atLeast = (user, role) => !!user && RANK[user.role] >= RANK[role]

function savedBranch() {
  try { return localStorage.getItem('bp-branch') } catch { return null }
}

export function SessionProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, branches: [], branchId: null })
  const [connected, setConnected] = useState(false)
  const listeners = useRef(new Map())

  const applyMe = useCallback(me => {
    const remembered = savedBranch()
    const branchId = me.branches.some(b => b.id === remembered) ? remembered : me.branches[0]?.id ?? null
    setBranch(branchId)
    setState({ loading: false, user: me.user, branches: me.branches, branchId })
  }, [])

  const refresh = useCallback(async () => {
    try {
      applyMe(await api.get('/session/me'))
    } catch {
      setBranch(null)
      setState({ loading: false, user: null, branches: [], branchId: null })
    }
  }, [applyMe])

  useEffect(() => { refresh() }, [refresh])

  // A 401 anywhere means the session ended (expired, PIN reset, switched off).
  useEffect(() => {
    const out = () => setState(s => (s.user ? { loading: false, user: null, branches: [], branchId: null } : s))
    window.addEventListener('bp:signed-out', out)
    return () => window.removeEventListener('bp:signed-out', out)
  }, [])

  // One socket while signed in. Events fan out to whoever subscribed.
  useEffect(() => {
    if (!state.user) {
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
  }, [state.user])

  const subscribe = useCallback((event, fn) => {
    if (!listeners.current.has(event)) listeners.current.set(event, new Set())
    listeners.current.get(event).add(fn)
    return () => listeners.current.get(event)?.delete(fn)
  }, [])

  const login = async (username, pin) => {
    await api.post('/session/pin', { username, pin })
    applyMe(await api.get('/session/me'))
  }

  const logout = async () => {
    try { await api.post('/session/logout') } catch {}
    disconnectSocket()
    setBranch(null)
    setState({ loading: false, user: null, branches: [], branchId: null })
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
