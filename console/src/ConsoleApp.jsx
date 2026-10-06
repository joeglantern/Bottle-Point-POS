import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, onUnauthorized } from './api.js'
import { can as canDo, roleLabel, statusLabel, money } from './format.js'
import { Link, matchRoute, navigate, useRoute } from './router.js'
import { SessionContext, useSession } from './session.js'
import { Icon, IconButton, ToastProvider } from './ui.jsx'
import Login from './pages/Login.jsx'
import Overview from './pages/Overview.jsx'
import Clients from './pages/Clients.jsx'
import ClientDetail from './pages/ClientDetail.jsx'
import Subscriptions from './pages/Subscriptions.jsx'
import Invoices from './pages/Invoices.jsx'
import InvoiceDetail from './pages/InvoiceDetail.jsx'
import Plans from './pages/Plans.jsx'
import Team from './pages/Team.jsx'
import Audit from './pages/Audit.jsx'
import Account from './pages/Account.jsx'

class Boundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidUpdate(prev) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="cx-crash" role="alert">
        <h1>Something went wrong</h1>
        <p className="cx-muted">This page hit a problem it could not recover from. Reloading usually fixes it.</p>
        <button type="button" className="cx-btn cx-btn-primary" onClick={() => location.reload()}>Reload the page</button>
      </div>
    )
  }
}

function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'dark')
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme === 'light' ? '#f4f0e7' : '#09090a')
    try { localStorage.setItem('bp-theme', theme) } catch {}
  }, [theme])
  return [theme, () => setTheme(t => (t === 'dark' ? 'light' : 'dark'))]
}

export default function ConsoleApp() {
  return (
    <Boundary>
      <ToastProvider>
        <Root />
      </ToastProvider>
    </Boundary>
  )
}

function Root() {
  const [state, setState] = useState({ loading: true, user: null, ended: false })
  const [theme, toggleTheme] = useTheme()

  const loadMe = useCallback(async () => {
    try {
      const r = await api.me()
      setState({ loading: false, user: r.user, ended: false })
    } catch {
      setState(s => ({ loading: false, user: null, ended: s.ended }))
    }
  }, [])

  useEffect(() => {
    loadMe()
    onUnauthorized(() => {
      try { sessionStorage.setItem('cx-return', location.pathname + location.search) } catch {}
      setState({ loading: false, user: null, ended: true })
    })
  }, [loadMe])

  const signOut = useCallback(async () => {
    try { await api.logout() } catch {}
    setState({ loading: false, user: null, ended: false })
    navigate('/', { replace: true })
  }, [])

  const session = useMemo(
    () => ({ user: state.user, role: state.user?.role ?? null, can: ability => canDo(state.user?.role, ability), signOut }),
    [state.user, signOut]
  )

  if (state.loading) return <div className="cx-boot" aria-busy="true"><span className="cx-spin" /></div>
  if (!state.user) {
    return (
      <Login
        ended={state.ended}
        theme={theme}
        onTheme={toggleTheme}
        onSignedIn={async () => {
          await loadMe()
          let back = '/'
          try { back = sessionStorage.getItem('cx-return') || '/'; sessionStorage.removeItem('cx-return') } catch {}
          navigate(back, { replace: true })
        }}
      />
    )
  }
  return (
    <SessionContext.Provider value={session}>
      <Shell theme={theme} onTheme={toggleTheme} />
    </SessionContext.Provider>
  )
}

const NAV = [
  { group: null, items: [['/', 'Overview', 'overview']] },
  { group: 'Clients', items: [['/clients', 'Clients', 'clients'], ['/subscriptions', 'Subscriptions', 'subscriptions']] },
  { group: 'Billing', items: [['/invoices', 'Invoices', 'invoices'], ['/plans', 'Plans', 'plans']] },
  { group: 'Company', items: [['/team', 'Team', 'team'], ['/audit', 'Audit log', 'audit']] }
]

function Shell({ theme, onTheme }) {
  const route = useRoute()
  const [drawer, setDrawer] = useState(false)
  const [search, setSearch] = useState(false)
  const match = matchRoute(route.path)

  useEffect(() => setDrawer(false), [route.path])
  useEffect(() => {
    const onKey = e => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable
      if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
        e.preventDefault()
        setSearch(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const active = href => (href === '/' ? route.path === '/' : route.path === href || route.path.startsWith(href + '/'))

  let page
  switch (match?.name) {
    case 'overview': page = <Overview />; break
    case 'clients': page = <Clients />; break
    case 'client': page = <ClientDetail id={match.params.id} />; break
    case 'subscriptions': page = <Subscriptions />; break
    case 'invoices': page = <Invoices />; break
    case 'invoice': page = <InvoiceDetail id={match.params.id} />; break
    case 'plans': page = <Plans />; break
    case 'team': page = <Team />; break
    case 'audit': page = <Audit />; break
    case 'account': page = <Account />; break
    default: page = <NotFound />
  }

  return (
    <div className={'cx-shell' + (drawer ? ' is-drawer' : '')}>
      <a href="#cx-main" className="cx-skip">Skip to content</a>
      <aside className="cx-side" aria-label="Console navigation">
        <div className="cx-side-brand">
          <Link to="/" className="cx-brand" aria-label="Bottle Point Console home">
            <img src="/brand/bottle-point-lockup.png" alt="" className="cx-on-dark" />
            <img src="/brand/bottle-point-lockup-light.png" alt="" className="cx-on-light" />
          </Link>
          <span className="cx-console-tag">Console</span>
          <IconButton icon="close" label="Close menu" className="cx-drawer-close" onClick={() => setDrawer(false)} />
        </div>
        <nav className="cx-nav">
          {NAV.map(section => (
            <div key={section.group ?? 'main'} className="cx-nav-group">
              {section.group && <div className="cx-nav-label">{section.group}</div>}
              {section.items.map(([href, label, icon]) => (
                <Link key={href} to={href} className={'cx-nav-item' + (active(href) ? ' is-on' : '')} aria-current={active(href) ? 'page' : undefined}>
                  <Icon name={icon} />
                  <span>{label}</span>
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <SideFooter theme={theme} onTheme={onTheme} />
      </aside>
      <div className="cx-scrim-nav" onClick={() => setDrawer(false)} aria-hidden="true" />

      <div className="cx-body">
        <header className="cx-top">
          <IconButton icon="menu" label="Open menu" className="cx-menu-btn" onClick={() => setDrawer(true)} />
          <button type="button" className="cx-search-trigger" onClick={() => setSearch(true)}>
            <Icon name="search" size={16} />
            <span>Search clients and invoices</span>
            <kbd>/</kbd>
          </button>
          <IconButton icon="search" label="Search" className="cx-search-icon" onClick={() => setSearch(true)} />
        </header>
        <main id="cx-main" className="cx-main" tabIndex={-1}>
          <Boundary resetKey={route.path}>{page}</Boundary>
        </main>
      </div>
      {search && <SearchPalette onClose={() => setSearch(false)} />}
    </div>
  )
}

function SideFooter({ theme, onTheme }) {
  const { user, signOut } = useSession()
  return (
    <div className="cx-side-foot">
      <Link to="/account" className="cx-me">
        <span className="cx-avatar" aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span>
        <span className="cx-me-text">
          <b>{user.name}</b>
          <small>{roleLabel(user.role)}</small>
        </span>
      </Link>
      <div className="cx-side-tools">
        <IconButton icon={theme === 'dark' ? 'sun' : 'moon'} label={theme === 'dark' ? 'Light theme' : 'Dark theme'} onClick={onTheme} />
        <IconButton icon="out" label="Sign out" onClick={signOut} />
      </div>
    </div>
  )
}


function NotFound() {
  useEffect(() => { document.title = 'Not found · Bottle Point Console' }, [])
  return (
    <div className="cx-notfound">
      <h1>Page not found</h1>
      <p className="cx-muted">There is nothing at this address.</p>
      <Link to="/" className="cx-btn cx-btn-secondary">Go to the overview</Link>
    </div>
  )
}

// Ctrl K or / anywhere: find a client or an invoice.
function SearchPalette({ onClose }) {
  const [q, setQ] = useState('')
  const [res, setRes] = useState({ tenants: [], invoices: [] })
  const [busy, setBusy] = useState(false)
  const [pos, setPos] = useState(0)
  const inputRef = useRef(null)
  const before = useRef(document.activeElement)

  useEffect(() => {
    inputRef.current?.focus()
    document.documentElement.classList.add('cx-locked')
    return () => {
      document.documentElement.classList.remove('cx-locked')
      before.current?.focus?.()
    }
  }, [])

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) { setRes({ tenants: [], invoices: [] }); return }
    const ctl = new AbortController()
    setBusy(true)
    const t = setTimeout(() => {
      api.search(term, { signal: ctl.signal }).then(
        r => { setRes(r); setPos(0); setBusy(false) },
        e => { if (e?.name !== 'AbortError') setBusy(false) }
      )
    }, 180)
    return () => { clearTimeout(t); ctl.abort() }
  }, [q])

  const items = [
    ...res.tenants.map(t => ({ key: 't' + t.id, to: `/clients/${t.id}`, title: t.name, meta: `${statusLabel(t.status)}${t.plan ? ' · ' + t.plan.name : ''}`, kind: 'Client' })),
    ...res.invoices.map(i => ({ key: 'i' + i.id, to: `/invoices/${i.id}`, title: i.number, meta: `${i.businessName} · ${money(i.totalCents)}`, kind: 'Invoice' }))
  ]
  const go = item => { onClose(); navigate(item.to) }

  const onKey = e => {
    if (e.key === 'Escape') onClose()
    else if (e.key === 'ArrowDown') { e.preventDefault(); setPos(p => Math.min(items.length - 1, p + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setPos(p => Math.max(0, p - 1)) }
    else if (e.key === 'Enter' && items[pos]) go(items[pos])
  }

  return (
    <div className="cx-scrim cx-scrim-top" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="cx-palette" role="dialog" aria-modal="true" aria-label="Search" onKeyDown={onKey}>
        <div className="cx-palette-input">
          <Icon name="search" />
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Client name, owner username or invoice number"
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls="cx-palette-list"
            aria-activedescendant={items[pos] ? 'cx-opt-' + items[pos].key : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          {busy && <span className="cx-spin" aria-hidden="true" />}
          <IconButton icon="close" label="Close search" onClick={onClose} />
        </div>
        <ul id="cx-palette-list" role="listbox" className="cx-palette-list">
          {items.map((it, i) => (
            <li key={it.key} id={'cx-opt-' + it.key} role="option" aria-selected={i === pos} className={i === pos ? 'is-on' : ''} onMouseEnter={() => setPos(i)} onClick={() => go(it)}>
              <span className="cx-palette-kind">{it.kind}</span>
              <span className="cx-palette-title">{it.title}</span>
              <span className="cx-muted">{it.meta}</span>
            </li>
          ))}
          {q.trim().length >= 2 && !busy && !items.length && <li className="cx-palette-empty">Nothing matches "{q.trim()}"</li>}
          {q.trim().length < 2 && <li className="cx-palette-empty">Type at least two letters</li>}
        </ul>
      </div>
    </div>
  )
}
