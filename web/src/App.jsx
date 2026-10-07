import { useEffect, useState } from 'react'
import { api, qs } from './api.js'
import { atLeast, useApi, useLive, useSession } from './session.jsx'
import { Icon, Loading, Logo, Modal, ThemeButton, ksh, useTheme, useToast } from './ui.jsx'
import Login from './pages/Login.jsx'
import { OpenShift, ShiftModal } from './pages/Shift.jsx'
import Till from './pages/Till.jsx'
import Transactions from './pages/Transactions.jsx'
import Customers from './pages/Customers.jsx'
import Inventory from './pages/Inventory.jsx'
import Today from './pages/Today.jsx'
import { Branches, Staff } from './pages/Owner.jsx'
import Admin, { BillingBanner, SuspendedScreen } from './pages/Admin.jsx'

export default function App() {
  const [theme, toggleTheme] = useTheme()
  const themeBtn = <ThemeButton theme={theme} toggle={toggleTheme} />
  const { loading, user } = useSession()

  if (loading) return <div className="center-screen"><Loading label="Starting Bottle Point" /></div>
  if (!user) return <Login themeBtn={themeBtn} />
  return <Shell themeBtn={themeBtn} />
}

function Shell({ themeBtn }) {
  const { user, branch, branches, branchId, chooseBranch, connected, logout } = useSession()
  const toast = useToast()
  const [view, setView] = useState('till')
  const [shift, setShift] = useState(undefined) // undefined = loading, null = none
  const [skipped, setSkipped] = useState(false)
  const [shiftOpen, setShiftOpen] = useState(false)
  const [openingShift, setOpeningShift] = useState(false)
  const [attach, setAttach] = useState(null)
  const [moreOpen, setMoreOpen] = useState(false)
  // subscription state: a strip for trials ending and overdue invoices, and
  // a full stop when the account is suspended or cancelled
  const billing = useApi('/admin/billing/status')
  const [blocked, setBlocked] = useState(null)
  useEffect(() => {
    const on = e => setBlocked(e.detail.message)
    window.addEventListener('bp:subscription', on)
    return () => window.removeEventListener('bp:subscription', on)
  }, [])
  const st = billing.data?.status
  const stopped = st === 'SUSPENDED' || st === 'CANCELLED' || !!blocked

  const loadShift = () => api.get('/shifts/current').then(r => setShift(r.shift), () => setShift(null))
  useEffect(() => {
    setShift(undefined)
    loadShift()
  }, [branchId])
  useLive('shift:updated', p => p.shift?.userId === user.id && loadShift())
  // cash taken changes the live till figures
  useLive('sale:updated', p => p.sale.branchId === branchId && shift && loadShift())

  const isManager = atLeast(user, 'MANAGER')
  const approvals = useApi(isManager ? '/approvals' + qs({ status: 'PENDING' }) : null, [branchId])
  useLive('approval:updated', () => isManager && approvals.reload())
  const pending = (approvals.data?.approvals ?? []).filter(a => a.branchId === branchId && a.requestedById !== user.id).length

  const tabs = [
    ['till', 'Till', 'till'],
    ['history', 'Transactions', 'history'],
    ['customers', 'Customers', 'customers']
  ]
  if (isManager) tabs.push(['stock', 'Inventory', 'stock'], ['today', 'Today', 'today'], ['staff', 'Staff', 'staff'])
  if (user.role === 'OWNER') tabs.push(['branches', 'Branches', 'branches'], ['admin', 'Settings', 'settings'])

  // On the bottom tab bar there is room for four destinations plus More.
  const hasMore = tabs.length > 5
  const extra = hasMore ? tabs.slice(4) : []
  const inExtra = extra.some(t => t[0] === view)
  const badge = k => k === 'today' && pending > 0 && <i key={k} className="nav-badge">{pending}</i>

  if (billing.loading && !billing.data && !billing.error) return <div className="center-screen"><Loading label="Loading your till" /></div>
  if (stopped && !(user.role === 'OWNER' && view === 'admin')) {
    const message = blocked ?? (billing.data?.suspendedReason ? `This account is suspended: ${billing.data.suspendedReason}.` : st === 'CANCELLED' ? 'This subscription has ended.' : 'This account is suspended.')
    return <SuspendedScreen message={message} isOwner={user.role === 'OWNER'} onBilling={() => setView('admin')} onSignOut={logout} />
  }
  if (shift === undefined && !stopped) return <div className="center-screen"><Loading label="Loading your till" /></div>
  const mustOpen = !stopped && !shift && !skipped && user.role !== 'OWNER'
  if (mustOpen || openingShift) {
    return (
      <OpenShift
        canSkip={user.role !== 'CASHIER' || openingShift}
        onSkip={() => { setSkipped(true); setOpeningShift(false) }}
        onOpened={s => { setShift(s); setOpeningShift(false); toast('Shift opened with ' + ksh(s.openingFloatCents), 'ok') }}
      />
    )
  }

  return (
    <div className="shell side">
      <aside className="rail">
        <img src="/brand/bottle-point-mark.png" alt="" className="rail-logo" />
        <nav aria-label="Main">
          {tabs.map(([k, l, icon], i) => (
            <button key={k} aria-label={l} aria-current={view === k ? 'page' : undefined} className={(view === k ? 'on' : '') + (hasMore && i >= 4 ? ' nav-extra' : '')} onClick={() => setView(k)}>
              <Icon k={icon} /><span>{l}</span>
              {badge(k)}
            </button>
          ))}
          <button aria-label="More" aria-haspopup="dialog" className={'nav-more' + (inExtra ? ' on' : '')} onClick={() => setMoreOpen(true)}>
            <Icon k="more" /><span>More</span>
            {extra.map(t => badge(t[0]))}
          </button>
        </nav>
        <button aria-label="Sign out" className="rail-out" onClick={logout}><Icon k="out" /><span>Sign out</span></button>
      </aside>
      <div className="body">
        <header className="top">
          <Logo />
          <div className="who">
            <span className={'live-dot' + (connected ? ' on' : '')} title={connected ? 'Live' : 'Reconnecting'} role="img" aria-label={connected ? 'Live' : 'Reconnecting'} />
            {shift ? (
              <button className="shift-pill" onClick={() => setShiftOpen(true)} title="Your shift">
                <span>Till</span><b>{ksh(shift.expectedCashCents)}</b>
              </button>
            ) : (
              <button className="shift-pill off" onClick={() => setOpeningShift(true)}>Open shift</button>
            )}
            {themeBtn}
            {branches.length > 1 ? (
              <select className="branch-select" value={branchId ?? ''} onChange={e => chooseBranch(e.target.value)} aria-label="Branch">
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            ) : <span className="branch-tag">{branch?.name}</span>}
            <span className="avatar">{user.name[0]}</span>
            <div className="who-name"><b>{user.name}</b><small>{user.role.toLowerCase()}</small></div>
          </div>
        </header>
        <OfflineBanner connected={connected} />
        <BillingBanner status={billing.data} onOpen={user.role === 'OWNER' ? () => setView('admin') : null} />
        <main>
          {view === 'till' && <Till key={branchId} shift={shift} attachCustomer={attach} onCustomerAttached={() => setAttach(null)} />}
          {view === 'history' && <Transactions key={branchId} />}
          {view === 'customers' && <Customers onAttach={c => { setAttach(c); setView('till'); toast(`${c.name} added to the sale`, 'ok') }} />}
          {view === 'stock' && isManager && <Inventory key={branchId} />}
          {view === 'today' && isManager && <Today key={branchId} />}
          {view === 'staff' && isManager && <Staff />}
          {view === 'branches' && user.role === 'OWNER' && <Branches />}
          {view === 'admin' && user.role === 'OWNER' && <Admin initial={stopped ? 'billing' : 'business'} />}
        </main>
      </div>
      {moreOpen && (
        <Modal title={user.name} eyebrow={user.role.toLowerCase()} onClose={() => setMoreOpen(false)} className="more-sheet">
          {extra.length > 0 && (
            <div className="more-list">
              {extra.map(([k, l, icon]) => (
                <button key={k} className={'more-item' + (view === k ? ' on' : '')} onClick={() => { setView(k); setMoreOpen(false) }}>
                  <Icon k={icon} /><span>{l}</span>{badge(k)}
                </button>
              ))}
            </div>
          )}
          <div className="more-row">
            <span>Branch</span>
            {branches.length > 1 ? (
              <select className="branch-select" value={branchId ?? ''} onChange={e => chooseBranch(e.target.value)} aria-label="Branch">
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            ) : <b>{branch?.name}</b>}
          </div>
          <div className="more-row"><span>Theme</span>{themeBtn}</div>
          <button className="outline wide more-out" onClick={logout}><Icon k="out" />Sign out</button>
        </Modal>
      )}
      {shiftOpen && shift && (
        <ShiftModal
          shift={shift}
          onClose={() => setShiftOpen(false)}
          onClosed={() => { setShiftOpen(false); setShift(null); setSkipped(user.role !== 'CASHIER') }}
        />
      )}
    </div>
  )
}

// Tells the cashier plainly when the till cannot reach the server. Waits a few
// seconds so a short blip does not flash a warning.
function OfflineBanner({ connected }) {
  const [online, setOnline] = useState(() => navigator.onLine)
  const [show, setShow] = useState(false)
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [])
  const lost = !online || !connected
  useEffect(() => {
    if (!lost) { setShow(false); return }
    const t = setTimeout(() => setShow(true), online ? 8000 : 2000)
    return () => clearTimeout(t)
  }, [lost, online])
  if (!show) return null
  return (
    <div className="billing-banner offline-banner" role="alert">
      <span><b>No connection.</b> Sales cannot be saved or paid until the internet is back. Note orders on paper and enter them when it returns.</span>
    </div>
  )
}
