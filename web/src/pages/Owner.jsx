import { useState } from 'react'
import { api, qs } from '../api.js'
import { useApi, useLive, useSession } from '../session.jsx'
import { Empty, ErrorNote, Field, Loading, Modal, Stat, ksh, todayNairobi, useAction } from '../ui.jsx'

export function Branches() {
  const [date, setDate] = useState(todayNairobi())
  const res = useApi('/reports/branches' + qs({ date }), [])
  useLive('sale:updated', () => res.reload())
  const d = res.data
  const max = d ? Math.max(1, ...d.branches.map(b => b.takings.totalCents)) : 1

  return (
    <div className="page">
      <div className="page-head row">
        <div>
          <h2>All branches</h2>
          <p className="muted">End of day across {d?.branches.length ?? 0} branches</p>
        </div>
        <div className="filters"><input type="date" className="date-in" value={date} max={todayNairobi()} onChange={e => setDate(e.target.value)} /></div>
      </div>
      <ErrorNote error={res.error} onRetry={res.reload} />
      {!d ? <Loading /> : (
        <>
          <div className="stats">
            <Stat label="Combined takings" value={ksh(d.total.takings.totalCents)} note={`${d.total.paidSales.count} paid sales`} />
            <Stat label="Cash" value={ksh(d.total.takings.cashCents)} />
            <Stat label="M-Pesa" value={ksh(d.total.takings.mpesaCents)} />
            <Stat label="Unpaid across branches" value={ksh(d.total.unpaid.valueCents)} note={`${d.total.unpaid.count} open`} />
          </div>
          <div className="card">
            <h4>Branch comparison</h4>
            {d.branches.map(b => (
              <div key={b.branchId} className="branch-bar">
                <span>{b.branchName}</span>
                <div className="track stacked">
                  <i className="c" style={{ width: (b.takings.cashCents / max) * 100 + '%' }} />
                  <i className="m" style={{ width: (b.takings.mpesaCents / max) * 100 + '%' }} />
                </div>
                <b>{ksh(b.takings.totalCents)}</b>
              </div>
            ))}
            <div className="legend"><span><i className="c" />Cash</span><span><i className="m" />M-Pesa</span></div>
          </div>
          <div className="card flush">
            <table className="rtable rt-branches">
              <thead><tr><th>Branch</th><th className="r">Sales</th><th className="r">Cash</th><th className="r">M-Pesa</th><th className="r">Refunds</th><th className="r">Unpaid</th><th className="r">Net</th></tr></thead>
              <tbody>
                {d.branches.map(b => (
                  <tr key={b.branchId}>
                    <td>{b.branchName}</td>
                    <td className="r">{b.paidSales.count}</td>
                    <td className="r">{ksh(b.takings.cashCents)}</td>
                    <td className="r">{ksh(b.takings.mpesaCents)}</td>
                    <td className={'r ' + (b.refunds.valueCents ? 'neg' : '')}>{ksh(b.refunds.valueCents)}</td>
                    <td className="r">{b.unpaid.count} ({ksh(b.unpaid.valueCents)})</td>
                    <td className="r"><b>{ksh(b.netCents)}</b></td>
                  </tr>
                ))}
                <tr className="total-row">
                  <td>All branches</td>
                  <td className="r">{d.total.paidSales.count}</td>
                  <td className="r">{ksh(d.total.takings.cashCents)}</td>
                  <td className="r">{ksh(d.total.takings.mpesaCents)}</td>
                  <td className="r">{ksh(d.total.refunds.valueCents)}</td>
                  <td className="r">{d.total.unpaid.count} ({ksh(d.total.unpaid.valueCents)})</td>
                  <td className="r"><b>{ksh(d.total.netCents)}</b></td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

const ROLES = [['CASHIER', 'Cashier'], ['MANAGER', 'Manager'], ['OWNER', 'Owner']]

export function Staff() {
  const { user, refresh } = useSession()
  const isOwner = user.role === 'OWNER'
  const users = useApi('/admin/users', [])
  // branch admin is owner only
  const branches = useApi(isOwner ? '/admin/branches' : null, [])
  const [modal, setModal] = useState(null)
  const [run, busy] = useAction()
  const allBranches = branches.data?.branches ?? []

  const toggleBranch = b =>
    run(async () => {
      await api.patch(`/admin/branches/${b.id}`, { active: !b.active })
      branches.reload()
      refresh()
    }, b.active ? 'Branch closed' : 'Branch reopened')

  return (
    <div className="page">
      <div className="page-head row">
        <div><h2>Staff</h2><p className="muted">Everyone signs in with their own username and PIN.</p></div>
        {isOwner && <div className="filters"><button className="gold" onClick={() => setModal({ kind: 'user' })}>Add staff</button></div>}
      </div>
      <ErrorNote error={users.error} onRetry={users.reload} />
      {!users.data ? <Loading /> : (
        <div className="card flush">
          <table className="rtable rt-staff">
            <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Branches</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {users.data.users.map(u => (
                <tr key={u.id}>
                  <td><b>{u.name}</b>{u.id === user.id && <span className="muted"> (you)</span>}</td>
                  <td className="mono">{u.username}</td>
                  <td>{ROLES.find(r => r[0] === u.role)?.[1]}</td>
                  <td>{u.role === 'OWNER' ? 'All' : u.branches.map(b => b.name).join(', ') || '-'}</td>
                  <td>
                    {!u.active ? <span className="tag cancelled">Switched off</span> : u.locked ? <span className="tag saved">Locked out</span> : <span className="tag ok">Active</span>}
                  </td>
                  <td className="r">
                    {isOwner && (
                      <>
                        <button className="mini" onClick={() => setModal({ kind: 'user', item: u })}>Edit</button>{' '}
                        <button className="mini" onClick={() => setModal({ kind: 'pin', item: u })}>New PIN</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isOwner && (
        <>
          <div className="page-head row">
            <div><h2 className="sm-h">Branches</h2></div>
            <div className="filters"><button className="outline" onClick={() => setModal({ kind: 'branch' })}>Add branch</button></div>
          </div>
          <div className="card">
            {!allBranches.length && <Empty>No branches.</Empty>}
            {allBranches.map(b => (
              <div key={b.id} className="kv branch-line">
                <span><b>{b.name}</b> {!b.active && <span className="tag cancelled">Closed</span>}</span>
                <span>
                  <button className="mini" onClick={() => setModal({ kind: 'branch', item: b })}>Rename</button>{' '}
                  <button className="mini" disabled={busy} onClick={() => toggleBranch(b)}>{b.active ? 'Close' : 'Reopen'}</button>
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {modal?.kind === 'user' && <UserForm item={modal.item} branches={allBranches.filter(b => b.active)} self={user} onClose={() => setModal(null)} onDone={() => { setModal(null); users.reload() }} />}
      {modal?.kind === 'pin' && <PinForm item={modal.item} onClose={() => setModal(null)} onDone={() => { setModal(null); users.reload() }} />}
      {modal?.kind === 'branch' && <BranchForm item={modal.item} onClose={() => setModal(null)} onDone={() => { setModal(null); branches.reload(); refresh() }} />}
    </div>
  )
}

function UserForm({ item, branches, self, onClose, onDone }) {
  const isNew = !item
  const [name, setName] = useState(item?.name ?? '')
  const [username, setUsername] = useState(item?.username ?? '')
  const [pin, setPin] = useState('')
  const [role, setRole] = useState(item?.role ?? 'CASHIER')
  const [ids, setIds] = useState(item?.branchIds ?? (branches[0] ? [branches[0].id] : []))
  const [active, setActive] = useState(item?.active ?? true)
  const [run, busy] = useAction()
  const isSelf = item?.id === self.id
  const toggle = id => setIds(xs => (xs.includes(id) ? xs.filter(x => x !== id) : [...xs, id]))
  const valid = name.trim() && (isNew ? /^[a-z0-9._]{3,32}$/.test(username) && /^\d{4,6}$/.test(pin) : true) && (role === 'OWNER' || ids.length > 0)

  const save = () =>
    run(async () => {
      if (isNew) await api.post('/admin/users', { name: name.trim(), username, pin, role, branchIds: role === 'OWNER' ? [] : ids })
      else await api.patch(`/admin/users/${item.id}`, { name: name.trim(), role, branchIds: role === 'OWNER' ? [] : ids, active })
      onDone()
    }, isNew ? 'Staff member added' : 'Saved')

  return (
    <Modal title={isNew ? 'Add staff' : item.name} eyebrow="Staff" onClose={onClose}>
      <Field label="Full name"><input className="label-in" value={name} onChange={e => setName(e.target.value)} autoFocus /></Field>
      {isNew && (
        <div className="split-grid">
          <Field label="Username" hint="Lowercase, used to sign in"><input className="label-in mono" value={username} onChange={e => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._]/g, ''))} autoCapitalize="none" /></Field>
          <Field label="PIN" hint="4 to 6 digits"><input className="label-in mono" type="password" inputMode="numeric" value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} /></Field>
        </div>
      )}
      <Field label="Role">
        <div className="seg three">
          {ROLES.map(([k, l]) => <button key={k} disabled={isSelf} className={role === k ? 'on' : ''} onClick={() => setRole(k)}>{l}</button>)}
        </div>
      </Field>
      {role !== 'OWNER' && (
        <Field label="Works at">
          <div className="check-list">
            {branches.map(b => (
              <label key={b.id} className="toggle"><input type="checkbox" checked={ids.includes(b.id)} onChange={() => toggle(b.id)} /><span />{b.name}</label>
            ))}
          </div>
        </Field>
      )}
      {!isNew && !isSelf && (
        <label className="toggle"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} /><span />Can sign in</label>
      )}
      {!isNew && <p className="muted small">Changes sign this person out of every till straight away.</p>}
      <button className="gold wide" disabled={busy || !valid} onClick={save}>Save</button>
    </Modal>
  )
}

function PinForm({ item, onClose, onDone }) {
  const [pin, setPin] = useState('')
  const [run, busy] = useAction()
  const save = () => run(async () => { await api.post(`/admin/users/${item.id}/pin`, { pin }); onDone() }, 'PIN changed')
  return (
    <Modal title={`New PIN for ${item.name}`} eyebrow="Staff" onClose={onClose}>
      <Field label="New PIN" hint="4 to 6 digits. Also clears a lockout and signs them out everywhere.">
        <input className="label-in mono" type="password" inputMode="numeric" value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} autoFocus />
      </Field>
      <button className="gold wide" disabled={busy || pin.length < 4} onClick={save}>Set PIN</button>
    </Modal>
  )
}

function BranchForm({ item, onClose, onDone }) {
  const [name, setName] = useState(item?.name ?? '')
  const [run, busy] = useAction()
  const save = () =>
    run(async () => {
      if (item) await api.patch(`/admin/branches/${item.id}`, { name: name.trim() })
      else await api.post('/admin/branches', { name: name.trim() })
      onDone()
    }, item ? 'Branch renamed' : 'Branch added')
  return (
    <Modal title={item ? 'Rename branch' : 'Add branch'} eyebrow="Branches" onClose={onClose}>
      <Field label="Branch name"><input className="label-in" value={name} onChange={e => setName(e.target.value)} autoFocus /></Field>
      {!item && <p className="muted small">Every product is added to the new branch with zero stock. Receive a delivery to stock it.</p>}
      <button className="gold wide" disabled={busy || name.trim().length < 2} onClick={save}>Save</button>
    </Modal>
  )
}
