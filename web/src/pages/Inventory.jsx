import { useMemo, useState } from 'react'
import { api, qs } from '../api.js'
import { useApi, useLive, useSession } from '../session.jsx'
import { Bottle, Empty, ErrorNote, Field, Loading, Modal, MoneyInput, dateOf, ksh, timeOf, tintFor, useAction } from '../ui.jsx'

export default function Inventory() {
  const { branchId, branch } = useSession()
  const [cat, setCat] = useState('All')
  const [lowOnly, setLowOnly] = useState(false)
  const [q, setQ] = useState('')
  const [modal, setModal] = useState(null) // {kind, item}
  const res = useApi('/stock', [branchId])
  const rows = res.data?.stock ?? []

  useLive('stock:updated', p => {
    if (p.branchId !== branchId) return
    res.setData(d => d && { ...d, stock: d.stock.map(s => (s.productId === p.productId ? { ...s, qty: p.qty, reorderAt: p.reorderAt ?? s.reorderAt, low: p.qty <= (p.reorderAt ?? s.reorderAt) } : s)) })
  })
  useLive('product:updated', () => res.reload())

  const categories = useMemo(() => ['All', ...new Set(rows.map(r => r.category))], [rows])
  const shown = rows.filter(r => (cat === 'All' || r.category === cat) && (!lowOnly || r.low) && (!q || r.name.toLowerCase().includes(q.toLowerCase()) || (r.barcode || '').startsWith(q)))
  const low = rows.filter(r => r.low).sort((a, b) => a.qty - b.qty)
  const units = rows.reduce((a, r) => a + Math.max(0, r.qty), 0)
  const value = rows.reduce((a, r) => a + Math.max(0, r.qty) * r.priceCents, 0)
  const done = () => { setModal(null); res.reload() }

  return (
    <div className="cashier">
      <section className="catalog">
        <div className="page-head row">
          <div>
            <h2 className="title-serif">Inventory</h2>
            <p className="muted">{branch?.name} stock</p>
          </div>
          <div className="filters">
            <div className="search narrow">
              <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Name or barcode" />
            </div>
          </div>
        </div>
        <div className="chips">
          {categories.map(c => <button key={c} className={c === cat ? 'on' : ''} onClick={() => setCat(c)}>{c}</button>)}
          <label className="toggle"><input type="checkbox" checked={lowOnly} onChange={e => setLowOnly(e.target.checked)} /><span />Low stock only</label>
        </div>
        <ErrorNote error={res.error} onRetry={res.reload} />
        {res.loading && !res.data ? <Loading /> : !shown.length ? <Empty>Nothing here.</Empty> : (
          <div className="grid">
            {shown.map(r => (
              <div key={r.productId} className="product inv">
                <Bottle tint={tintFor(r.category)} />
                <div className="p-info">
                  <b>{r.name}</b>
                  <small>{r.barcode ? 'Barcode ' + r.barcode : 'No barcode'}</small>
                  <div className="inv-row">{r.qty <= 0 ? <span className="tag cancelled">Out of stock</span> : r.low ? <span className="tag saved">Low: {r.qty}</span> : <span className="tag ok">In stock: {r.qty}</span>}</div>
                  <span className="price">{ksh(r.priceCents)}</span>
                  <div className="inv-actions">
                    <button className="mini" onClick={() => setModal({ kind: 'count', item: r })}>Count</button>
                    <button className="mini" onClick={() => setModal({ kind: 'product', item: r })}>Edit</button>
                    <button className="mini" onClick={() => setModal({ kind: 'history', item: r })}>History</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      <aside className="order">
        <h3 className="title-serif sm">Stock</h3>
        <div className="stock-sum">
          <div><small>Units on hand</small><b>{units}</b></div>
          <div><small>Retail value</small><b>{ksh(value)}</b></div>
        </div>
        <button className="gold" onClick={() => setModal({ kind: 'receive' })}>Receive delivery</button>
        <button className="outline" onClick={() => setModal({ kind: 'product', item: null })}>Add product</button>
        <div className="unpaid">
          <h4>Low stock alerts <span className="badge">{low.length}</span></h4>
          {low.map(p => (
            <div key={p.productId} className="u-row">
              <div className="u-main" onClick={() => setModal({ kind: 'receive', item: p })}><b>{p.name}</b><small>{p.qty <= 0 ? 'Out of stock' : p.qty + ' left'} {'·'} reorder at {p.reorderAt}</small></div>
              <span className={'dot ' + (p.qty <= 0 ? 'red' : 'amber')} />
            </div>
          ))}
          {!low.length && <p className="muted small">Everything is above its reorder level.</p>}
        </div>
      </aside>
      {modal?.kind === 'receive' && <Receive rows={rows} first={modal.item} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'count' && <Count item={modal.item} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'product' && <ProductForm item={modal.item} categories={categories.filter(c => c !== 'All')} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'history' && <History item={modal.item} onClose={() => setModal(null)} />}
    </div>
  )
}

function Receive({ rows, first, onClose, onDone }) {
  const [items, setItems] = useState([{ productId: first?.productId ?? '', qty: '' }])
  const [run, busy] = useAction()
  const set = (i, patch) => setItems(xs => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const valid = items.filter(x => x.productId && Number(x.qty) > 0)
  const save = () =>
    run(async () => {
      await api.post('/stock/receive', { items: valid.map(x => ({ productId: x.productId, qty: Number(x.qty) })) })
      onDone()
    }, 'Delivery received')
  return (
    <Modal title="Receive delivery" eyebrow="Stock in" onClose={onClose} wide>
      <div className="receive-rows">
        {items.map((x, i) => (
          <div key={i} className="receive-row">
            <select className="label-in" value={x.productId} onChange={e => set(i, { productId: e.target.value })}>
              <option value="">Choose a product</option>
              {rows.map(r => <option key={r.productId} value={r.productId}>{r.name} ({r.qty} in stock)</option>)}
            </select>
            <input className="label-in" inputMode="numeric" value={x.qty} onChange={e => set(i, { qty: e.target.value.replace(/\D/g, '') })} placeholder="Qty" />
            <button className="ghost" onClick={() => setItems(xs => (xs.length > 1 ? xs.filter((_, j) => j !== i) : xs))} aria-label="Remove row">{'×'}</button>
          </div>
        ))}
      </div>
      <button className="ghost" onClick={() => setItems(xs => [...xs, { productId: '', qty: '' }])}>+ Another product</button>
      <button className="gold wide" disabled={busy || !valid.length} onClick={save}>Add {valid.reduce((a, x) => a + Number(x.qty), 0)} units to stock</button>
    </Modal>
  )
}

function Count({ item, onClose, onDone }) {
  const [qty, setQty] = useState(String(Math.max(0, item.qty)))
  const [reason, setReason] = useState('Stock take')
  const [reorder, setReorder] = useState(String(item.reorderAt))
  const [run, busy] = useAction()
  const delta = Number(qty) - item.qty
  const save = () =>
    run(async () => {
      if (Number(qty) !== item.qty) await api.post('/stock/adjust', { productId: item.productId, countedQty: Number(qty), reason })
      if (Number(reorder) !== item.reorderAt) await api.patch(`/stock/${item.productId}`, { reorderAt: Number(reorder) })
      onDone()
    }, 'Stock updated')
  return (
    <Modal title={item.name} eyebrow="Stock count" onClose={onClose}>
      <div className="split-grid">
        <Field label="Counted on the shelf"><input className="label-in" inputMode="numeric" value={qty} onChange={e => setQty(e.target.value.replace(/\D/g, ''))} autoFocus /></Field>
        <Field label="Reorder at"><input className="label-in" inputMode="numeric" value={reorder} onChange={e => setReorder(e.target.value.replace(/\D/g, ''))} /></Field>
      </div>
      {qty !== '' && delta !== 0 && <div className={'variance ' + (delta < 0 ? 'short' : 'over')}>{delta < 0 ? `${-delta} missing` : `${delta} more than recorded`}</div>}
      {delta !== 0 && <Field label="Reason"><input className="label-in" value={reason} onChange={e => setReason(e.target.value)} /></Field>}
      <button className="gold wide" disabled={busy || qty === '' || reorder === '' || (delta !== 0 && reason.trim().length < 3)} onClick={save}>Save</button>
    </Modal>
  )
}

function ProductForm({ item, categories, onClose, onDone }) {
  const isNew = !item
  const [name, setName] = useState(item?.name ?? '')
  const [category, setCategory] = useState(item?.category ?? '')
  const [sizeMl, setSizeMl] = useState(item?.sizeMl ? String(item.sizeMl) : '')
  const [barcode, setBarcode] = useState(item?.barcode ?? '')
  const [price, setPrice] = useState(item?.priceCents ?? null)
  const [run, busy] = useAction()
  const id = item?.productId
  const save = () =>
    run(async () => {
      const body = { name: name.trim(), category: category.trim(), sizeMl: sizeMl ? Number(sizeMl) : null, barcode: barcode || null, priceCents: price }
      if (isNew) await api.post('/products', body)
      else await api.patch(`/products/${id}`, body)
      onDone()
    }, isNew ? 'Product added' : 'Product updated')
  const archive = () =>
    window.confirm(`Stop selling ${item.name}? It disappears from the till but its history stays.`) &&
    run(async () => { await api.del(`/products/${id}`); onDone() }, 'Product removed from the till')
  return (
    <Modal title={isNew ? 'Add product' : 'Edit product'} eyebrow="Catalog" onClose={onClose}>
      <Field label="Name"><input className="label-in" value={name} onChange={e => setName(e.target.value)} autoFocus /></Field>
      <div className="split-grid">
        <Field label="Category">
          <input className="label-in" list="bp-categories" value={category} onChange={e => setCategory(e.target.value)} placeholder="Whisky" />
          <datalist id="bp-categories">{categories.map(c => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label="Size (ml)"><input className="label-in" inputMode="numeric" value={sizeMl} onChange={e => setSizeMl(e.target.value.replace(/\D/g, ''))} placeholder="750" /></Field>
      </div>
      <div className="split-grid">
        <Field label="Price (KSh)"><MoneyInput cents={price} onCents={setPrice} /></Field>
        <Field label="Barcode" hint="Scan it into this box"><input className="label-in" inputMode="numeric" value={barcode} onChange={e => setBarcode(e.target.value.replace(/\D/g, ''))} /></Field>
      </div>
      {!isNew && price !== item.priceCents && <p className="muted small">Price changes apply to new sales only. Past receipts keep their price.</p>}
      <button className="gold wide" disabled={busy || !name.trim() || !category.trim() || !price} onClick={save}>Save</button>
      {!isNew && <button className="ghost danger" onClick={archive}>Stop selling this product</button>}
    </Modal>
  )
}

function History({ item, onClose }) {
  const res = useApi('/stock/movements' + qs({ productId: item.productId, limit: 50 }), [])
  const rows = res.data?.movements ?? []
  const label = { SALE: 'Sold', REFUND: 'Refunded', RECEIVE: 'Received', ADJUST: 'Counted' }
  return (
    <Modal title={item.name} eyebrow="Stock history" onClose={onClose} wide>
      <ErrorNote error={res.error} />
      {res.loading && !res.data ? <Loading /> : !rows.length ? <Empty>No movements yet.</Empty> : (
        <table className="rtable rt-hist">
          <thead><tr><th>When</th><th>What</th><th>Note</th><th className="r">Change</th></tr></thead>
          <tbody>
            {rows.map(m => (
              <tr key={m.id}>
                <td>{dateOf(m.createdAt)} {timeOf(m.createdAt)}</td>
                <td>{label[m.reason] ?? m.reason}{m.userName ? <span className="muted"> by {m.userName}</span> : null}</td>
                <td className="muted">{m.note ?? ''}</td>
                <td className={'r ' + (m.delta < 0 ? 'neg' : '')}>{m.delta > 0 ? '+' : ''}{m.delta}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  )
}
