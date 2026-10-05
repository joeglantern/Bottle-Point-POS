import { useEffect, useState } from 'react'
import { api, qs } from './api.js'
import { atLeast, useApi, useLive, useSession } from './session.jsx'
import { Icon, Loading, Logo, ThemeButton, ksh, useTheme, useToast } from './ui.jsx'
import Login from './pages/Login.jsx'
import { OpenShift, ShiftModal } from './pages/Shift.jsx'
import Till from './pages/Till.jsx'
import Transactions from './pages/Transactions.jsx'
import Customers from './pages/Customers.jsx'
import Inventory from './pages/Inventory.jsx'
import Today from './pages/Today.jsx'
import { Branches, Staff } from './pages/Owner.jsx'

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
  if (user.role === 'OWNER') tabs.push(['branches', 'Branches', 'branches'])

  if (shift === undefined) return <div className="center-screen"><Loading label="Loading your till" /></div>
  const mustOpen = !shift && !skipped && user.role !== 'OWNER'
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
        <nav>
          {tabs.map(([k, l, icon]) => (
            <button key={k} title={l} className={view === k ? 'on' : ''} onClick={() => setView(k)}>
              <Icon k={icon} /><span>{l}</span>
              {k === 'today' && pending > 0 && <i className="nav-badge">{pending}</i>}
            </button>
          ))}
        </nav>
        <button title="Sign out" className="rail-out" onClick={logout}><Icon k="out" /></button>
      </aside>
      <div className="body">
        <header className="top">
          <Logo />
          <div className="who">
            <span className={'live-dot' + (connected ? ' on' : '')} title={connected ? 'Live' : 'Reconnecting'} />
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
        <main>
          {view === 'till' && <Till key={branchId} shift={shift} attachCustomer={attach} onCustomerAttached={() => setAttach(null)} />}
          {view === 'history' && <Transactions key={branchId} />}
          {view === 'customers' && <Customers onAttach={c => { setAttach(c); setView('till'); toast(`${c.name} added to the sale`, 'ok') }} />}
          {view === 'stock' && isManager && <Inventory key={branchId} />}
          {view === 'today' && isManager && <Today key={branchId} />}
          {view === 'staff' && isManager && <Staff />}
          {view === 'branches' && user.role === 'OWNER' && <Branches />}
        </main>
      </div>
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
