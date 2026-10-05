import { useEffect, useState } from 'react'
import { api, qs } from '../api.js'
import { atLeast, useApi, useSession } from '../session.jsx'
import { Empty, ErrorNote, Field, Loading, Modal, dateOf, ksh, useAction } from '../ui.jsx'

const initials = n => n.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()
const showPhone = p => (p ? '0' + p.replace(/^254/, '') : 'No phone')

function tier(spent) {
  if (spent >= 5000000) return 'Gold'
  if (spent >= 2000000) return 'Silver'
  return 'Bronze'
}

export default function Customers({ onAttach }) {
  const { user } = useSession()
  const [q, setQ] = useState('')
  const res = useApi('/customers' + qs({ q }), [])
  const list = res.data?.customers ?? []
  const [selId, setSelId] = useState(null)
  const [editing, setEditing] = useState(null) // {} for new, customer for edit
  const sel = list.find(c => c.id === selId) ?? list[0] ?? null

  useEffect(() => {
    if (!selId && list[0]) setSelId(list[0].id)
  }, [list])

  return (
    <div className="cashier">
      <section className="catalog">
        <div className="page-head row">
          <h2 className="title-serif">Customers</h2>
          <div className="filters">
            <div className="search narrow">
              <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name or phone" />
            </div>
            <button className="gold" onClick={() => setEditing({})}>New customer</button>
          </div>
        </div>
        <ErrorNote error={res.error} onRetry={res.reload} />
        {res.loading && !res.data ? <Loading /> : !list.length ? <Empty>No customers yet.</Empty> : (
          <div className="grid wide-cards">
            {list.map(c => (
              <button key={c.id} className={'product cust' + (sel?.id === c.id ? ' sel' : '')} onClick={() => setSelId(c.id)}>
                <span className="avatar lg">{initials(c.name)}</span>
                <div className="p-info">
                  <b>{c.name}</b>
                  <small>{showPhone(c.phone)}</small>
                  <div className="cust-meta">
                    <span><small>Spent</small>{ksh(c.spentCents)}</span>
                    <span><small>Visits</small>{c.visitCount}</span>
                    <span className={'tier ' + tier(c.spentCents).toLowerCase()}>{tier(c.spentCents)}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
      <aside className="order">
        {sel ? (
          <>
            <div className="cust-head">
              <span className="avatar xl">{initials(sel.name)}</span>
              <div><h3 className="title-serif sm">{sel.name}</h3><small className="muted">{showPhone(sel.phone)}</small></div>
            </div>
            <div className="stock-sum">
              <div><small>Lifetime spend</small><b>{ksh(sel.spentCents)}</b></div>
              <div><small>Open tab</small><b className={sel.openTabCents ? 'gold-t' : ''}>{ksh(sel.openTabCents)}</b></div>
            </div>
            <div className="kv"><span className="muted">Visits</span><b>{sel.visitCount}</b></div>
            <div className="kv"><span className="muted">Last visit</span><b>{sel.lastVisitAt ? dateOf(sel.lastVisitAt) : 'Never'}</b></div>
            <div className="kv"><span className="muted">Unpaid sales</span><b>{sel.openSales}</b></div>
            <div className="kv"><span className="muted">Customer since</span><b>{dateOf(sel.createdAt)}</b></div>
            <button className="gold" onClick={() => onAttach(sel)}>Attach to current sale</button>
            {atLeast(user, 'MANAGER') && <button className="outline" onClick={() => setEditing(sel)}>Edit details</button>}
          </>
        ) : <Empty>Pick a customer.</Empty>}
      </aside>
      {editing && <CustomerForm customer={editing} onClose={() => setEditing(null)} onSaved={c => { setEditing(null); setSelId(c.id); res.reload() }} />}
    </div>
  )
}

function CustomerForm({ customer, onClose, onSaved }) {
  const isNew = !customer.id
  const [name, setName] = useState(customer.name ?? '')
  const [phone, setPhone] = useState(customer.phone ? '0' + customer.phone.replace(/^254/, '') : '')
  const [run, busy] = useAction()
  const save = () =>
    run(async () => {
      const body = { name: name.trim(), phone: phone.trim() || null }
      const r = isNew ? await api.post('/customers', body) : await api.patch(`/customers/${customer.id}`, body)
      onSaved(r.customer)
    }, isNew ? 'Customer added' : 'Customer updated')
  return (
    <Modal title={isNew ? 'New customer' : 'Edit customer'} onClose={onClose}>
      <Field label="Name"><input className="label-in" value={name} onChange={e => setName(e.target.value)} autoFocus /></Field>
      <Field label="Phone (optional)" hint="Used for M-Pesa prompts"><input className="label-in" value={phone} onChange={e => setPhone(e.target.value)} placeholder="0712 345 678" inputMode="tel" /></Field>
      <button className="gold wide" disabled={busy || !name.trim()} onClick={save}>Save</button>
    </Modal>
  )
}
