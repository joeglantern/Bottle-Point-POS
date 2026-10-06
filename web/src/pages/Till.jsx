import { useEffect, useMemo, useRef, useState } from 'react'
import { api, qs } from '../api.js'
import { useApi, useLive, useSession } from '../session.jsx'
import { useBarcodeScanner, cameraScanSupported } from '../scanner.js'
import { parseReceiptCode } from '../Receipt.jsx'
import ReceiptLoader from '../ReceiptLoader.jsx'
import PayModal from './Pay.jsx'
import {
  Bottle, ErrorNote, Field, Icon, Loading, Modal, MoneyInput, ReasonModal, ago, ksh, tintFor, useAction, useDialogFocus, useScrollLock, useToast
} from '../ui.jsx'

// Keep in step with the compact layout query in styles.css.
const COMPACT = '(max-width: 899px), (max-width: 1100px) and (orientation: portrait)'

const emptyCart = () => ({ saleId: null, number: null, version: 0, lines: [], label: '', customer: null, paidCents: 0, discountCents: 0, original: null })

function cartFromSale(s) {
  return {
    saleId: s.id,
    number: s.number,
    version: s.version,
    lines: s.lines.map(l => ({ productId: l.productId, name: l.name, unitCents: l.unitCents, qty: l.qty })),
    label: s.label ?? '',
    customer: s.customer ?? null,
    paidCents: s.paidCents,
    discountCents: s.discountCents,
    original: JSON.stringify(s.lines.map(l => [l.productId, l.qty]))
  }
}
const linesKey = lines => JSON.stringify(lines.map(l => [l.productId, l.qty]))

export default function Till({ shift, attachCustomer, onCustomerAttached }) {
  const { branchId } = useSession()
  const toast = useToast()
  const [run, busy] = useAction()

  const products = useApi('/products', [branchId])
  const unpaid = useApi('/sales' + qs({ status: 'SAVED', limit: 200 }), [branchId])

  const [cat, setCat] = useState('All')
  const [q, setQ] = useState('')
  const [cart, setCart] = useState(emptyCart)
  const [paying, setPaying] = useState(null)
  const [receiptFor, setReceiptFor] = useState(null)
  const [scanOpen, setScanOpen] = useState(false)
  const [lastScan, setLastScan] = useState(null)
  const [flash, setFlash] = useState(null)
  const [ask, setAsk] = useState(null) // 'discount' | 'cancel'
  const [discount, setDiscount] = useState(null)
  const [findCustomer, setFindCustomer] = useState(false)
  // On phones and portrait tablets the order panel is a bottom sheet.
  const [sheetOpen, setSheetOpen] = useState(false)
  const [sheetTab, setSheetTab] = useState('order')
  const orderRef = useRef(null)
  useScrollLock(sheetOpen)
  useDialogFocus(orderRef, sheetOpen)
  useEffect(() => {
    const mq = window.matchMedia(COMPACT)
    const sync = () => !mq.matches && setSheetOpen(false)
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  useEffect(() => {
    if (!sheetOpen) return
    const onKey = e => e.key === 'Escape' && !document.querySelector('.scrim') && setSheetOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sheetOpen])
  // a finished sale puts the cashier back on the catalog
  useEffect(() => { if (receiptFor) { setSheetOpen(false); setSheetTab('order') } }, [receiptFor])
  const showSheet = tab => { setSheetTab(tab); setSheetOpen(true) }

  // a customer picked on the Customers screen lands on the current sale
  useEffect(() => {
    if (attachCustomer) {
      setCart(c => ({ ...c, customer: attachCustomer }))
      onCustomerAttached()
    }
  }, [attachCustomer])

  const list = products.data?.products ?? []
  const categories = useMemo(() => ['All', ...new Set(list.map(p => p.category))], [list])
  const shown = list.filter(p =>
    (cat === 'All' || p.category === cat) &&
    (!q || p.name.toLowerCase().includes(q.toLowerCase()) || (p.barcode || '').startsWith(q))
  )
  const sales = unpaid.data?.sales ?? []
  const total = cart.lines.reduce((a, l) => a + l.unitCents * l.qty, 0)
  const dirty = cart.saleId ? linesKey(cart.lines) !== cart.original : cart.lines.length > 0

  // ---- live updates ----
  useLive('stock:updated', p => {
    if (p.branchId !== branchId) return
    products.setData(d => d && { ...d, products: d.products.map(x => (x.id === p.productId ? { ...x, qty: p.qty } : x)) })
  })
  useLive('product:updated', () => products.reload())
  useLive('sale:updated', ({ sale }) => {
    if (sale.branchId !== branchId) return
    unpaid.setData(d => {
      if (!d) return d
      const rest = d.sales.filter(s => s.id !== sale.id)
      return { ...d, sales: sale.status === 'SAVED' ? [sale, ...rest].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) : rest }
    })
    // someone else changed the sale open on this till
    setCart(c => {
      if (c.saleId !== sale.id || sale.version === c.version) return c
      if (sale.status !== 'SAVED') {
        if (!paying) toast(`Sale #${sale.number} is now ${sale.status.toLowerCase()} on another till.`)
        return paying ? c : emptyCart()
      }
      if (linesKey(c.lines) === c.original) return cartFromSale(sale)
      return { ...c, version: sale.version, original: JSON.stringify(sale.lines.map(l => [l.productId, l.qty])), stale: true }
    })
  })

  // ---- cart ----
  const add = p => {
    setCart(c => {
      const f = c.lines.find(l => l.productId === p.id)
      const lines = f
        ? c.lines.map(l => (l.productId === p.id ? { ...l, qty: Math.min(999, l.qty + 1) } : l))
        : [...c.lines, { productId: p.id, name: p.name, unitCents: p.priceCents, qty: 1 }]
      return { ...c, lines }
    })
    setFlash(p.id)
    setTimeout(() => setFlash(f => (f === p.id ? null : f)), 700)
  }
  const setQty = (pid, qty) => setCart(c => ({ ...c, lines: c.lines.map(l => (l.productId === pid ? { ...l, qty } : l)).filter(l => l.qty > 0) }))
  const reset = () => setCart(emptyCart())

  // Save the cart to the server (create or update). Returns the sale.
  const persist = async () => {
    const lines = cart.lines.map(l => ({ productId: l.productId, qty: l.qty }))
    if (!cart.saleId) {
      const r = await api.post('/sales', { lines, label: cart.label || undefined, customerId: cart.customer?.id })
      return r.sale
    }
    let sale = null
    if (dirty) sale = (await api.put(`/sales/${cart.saleId}/lines`, { lines, version: cart.version })).sale
    const opened = sales.find(s => s.id === cart.saleId)
    const labelChanged = (opened?.label ?? '') !== cart.label
    const customerChanged = (opened?.customer?.id ?? null) !== (cart.customer?.id ?? null)
    if (labelChanged || customerChanged) {
      sale = (await api.patch(`/sales/${cart.saleId}`, { label: cart.label || null, customerId: cart.customer?.id ?? null })).sale
    }
    return sale ?? (await api.get(`/sales/${cart.saleId}`)).sale
  }

  const onStale = e => {
    if (e.code !== 'stale_sale') return false
    toast('Another till changed this sale. It has been reloaded.', 'error')
    const s = e.details?.sale
    if (s) setCart(cartFromSale(s))
    return true
  }

  const saveLater = () =>
    run(async () => {
      const s = await persist()
      reset()
      return s
    }, cart.saleId ? 'Sale updated' : 'Saved to unpaid sales', onStale)

  const payNow = () =>
    run(async () => {
      const s = await persist()
      setCart(cartFromSale(s))
      setPaying(s)
    }, null, onStale)

  const openSale = s => {
    if (dirty && !window.confirm('Leave the current sale? Unsaved changes will be lost.')) return
    setCart(cartFromSale(s))
  }

  const requestApproval = (kind, reason) =>
    run(async () => {
      await api.post('/approvals', { saleId: cart.saleId, kind, reason, amountCents: kind === 'DISCOUNT' ? discount : undefined })
      setAsk(null)
      setDiscount(null)
    }, kind === 'CANCEL' ? 'Cancel request sent to the manager' : 'Discount request sent to the manager')

  // ---- scanner ----
  const onScan = async code => {
    const receiptNo = parseReceiptCode(code)
    if (receiptNo) {
      setLastScan({ code, label: 'receipt #' + receiptNo, at: Date.now() })
      try {
        const r = await api.get('/sales' + qs({ q: String(receiptNo), limit: 5 }))
        const s = r.sales.find(x => x.number === receiptNo)
        if (!s) return toast(`No sale #${receiptNo} in this branch.`, 'error')
        if (s.status === 'SAVED') return openSale(s)
        if (s.status === 'PAID' || s.status === 'REFUNDED') return setReceiptFor({ saleId: s.id, copy: true })
        return toast(`Sale #${receiptNo} is ${s.status.toLowerCase()}.`)
      } catch (e) {
        return toast(e.message, 'error')
      }
    }
    let p = list.find(x => x.barcode === code)
    if (!p) {
      try { p = (await api.get(`/products/barcode/${encodeURIComponent(code)}`)).product } catch { p = null }
    }
    setLastScan({ code, label: p ? p.name : null, at: Date.now() })
    if (p) add(p)
    else toast('No product with barcode ' + code, 'error')
  }
  useBarcodeScanner(onScan, !paying && !receiptFor && !ask && !findCustomer)

  const canAsk = cart.saleId && cart.paidCents === 0

  return (
    <div className={'cashier till-view' + (sheetOpen ? ' sheet-open' : '')}>
      <section className="catalog">
        <div className="bar">
          <div className="search">
            <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search by name or barcode" aria-label="Search products" enterKeyHint="search" autoComplete="off" autoCapitalize="none" />
          </div>
          <button className="scan-btn" onClick={() => setScanOpen(true)} aria-label="Scan barcode"><Icon k="scan" /><span>Scan</span></button>
        </div>
        <div className={'scanner-status' + (lastScan && !lastScan.label ? ' miss' : '')}>
          <span className="pulse" />
          <span className="s-label">Scanner ready</span>
          {lastScan && (
            <span className="s-last" key={lastScan.at}>
              <code>{lastScan.code}</code>{lastScan.label ? <> added {lastScan.label}</> : <> not found</>}
            </span>
          )}
        </div>
        <div className="chips">
          {categories.map(c => <button key={c} className={c === cat ? 'on' : ''} onClick={() => setCat(c)}>{c}</button>)}
        </div>
        <ErrorNote error={products.error} onRetry={products.reload} />
        {products.loading && !products.data ? <Loading label="Loading products" /> : (
          <div className="grid">
            {shown.map(p => (
              <button key={p.id} className={'product' + (flash === p.id ? ' flash' : '') + (p.qty != null && p.qty <= 0 ? ' out' : '')} onClick={() => add(p)}>
                <Bottle tint={tintFor(p.category)} />
                <div className="p-info">
                  <b>{p.name}</b>
                  <small>{p.sizeMl ? p.sizeMl + 'ml · ' : ''}{p.category}</small>
                  <span className="price">{ksh(p.priceCents)}</span>
                  {p.qty != null && <span className={'qty' + (p.qty <= (p.reorderAt ?? 0) ? ' low' : '')}>{p.qty <= 0 ? 'Out of stock' : p.qty + ' in stock'}</span>}
                </div>
              </button>
            ))}
            {!shown.length && <p className="muted pad-l">No products match that search.</p>}
          </div>
        )}
      </section>

      <div className="till-bar">
        <button className="till-bar-unpaid" onClick={() => showSheet('unpaid')} aria-label={'Unpaid sales, ' + sales.length}>
          <span>Unpaid</span><b className="badge">{sales.length}</b>
        </button>
        <div className="till-bar-sum" aria-live="polite">
          <small>{cart.lines.reduce((a, l) => a + l.qty, 0)} {cart.lines.reduce((a, l) => a + l.qty, 0) === 1 ? 'item' : 'items'}</small>
          <b>{ksh(total)}</b>
        </div>
        <button className="gold till-bar-view" onClick={() => showSheet('order')}>View order</button>
      </div>
      {sheetOpen && <div className="till-scrim" onClick={() => setSheetOpen(false)} />}

      <aside className="order" data-tab={sheetTab} ref={orderRef} tabIndex={-1} aria-label="Order">
        <div className="sheet-tabs">
          <div className="seg" role="tablist">
            <button role="tab" aria-selected={sheetTab === 'order'} className={sheetTab === 'order' ? 'on' : ''} onClick={() => setSheetTab('order')}>Order</button>
            <button role="tab" aria-selected={sheetTab === 'unpaid'} className={sheetTab === 'unpaid' ? 'on' : ''} onClick={() => setSheetTab('unpaid')}>Unpaid ({sales.length})</button>
          </div>
          <button className="ghost" onClick={() => setSheetOpen(false)}>Close</button>
        </div>
        <div className="order-head">
          <h3>{cart.saleId ? `Sale #${cart.number}` : 'New sale'}</h3>
          {(cart.saleId || cart.lines.length > 0) && <button className="ghost" onClick={() => (!dirty || window.confirm('Start a new sale? Unsaved changes will be lost.')) && reset()}>New</button>}
        </div>
        {cart.stale && <div className="warn-note">This sale was changed on another till while you edited it. Saving will be refused, press New and reopen it.</div>}
        <input className="label-in" value={cart.label} onChange={e => setCart(c => ({ ...c, label: e.target.value }))} placeholder="Label (customer or table), optional" maxLength={60} />
        <div className="customer-row">
          {cart.customer ? (
            <>
              <span className="cust-chip"><span className="avatar">{cart.customer.name[0]}</span>{cart.customer.name}</span>
              <button className="ghost" onClick={() => setCart(c => ({ ...c, customer: null }))}>Remove</button>
            </>
          ) : (
            <button className="ghost" onClick={() => setFindCustomer(true)}>+ Add customer</button>
          )}
        </div>
        <div className="lines">
          {cart.lines.map(l => (
            <div key={l.productId} className="line">
              <div><b>{l.name}</b><small>{ksh(l.unitCents)}</small></div>
              <div className="stepper">
                <button onClick={() => setQty(l.productId, l.qty - 1)} aria-label="One less">{'−'}</button>
                <span>{l.qty}</span>
                <button onClick={() => setQty(l.productId, Math.min(999, l.qty + 1))} aria-label="One more">+</button>
              </div>
              <b className="lt">{ksh(l.unitCents * l.qty)}</b>
            </div>
          ))}
          {!cart.lines.length && <p className="empty">Tap or scan a bottle to start a sale.</p>}
        </div>
        {cart.discountCents > 0 && <div className="kv"><span className="muted">Discount</span><b>{'−'} {ksh(cart.discountCents)}</b></div>}
        {cart.paidCents > 0 && <div className="kv"><span className="muted">Already paid</span><b>{ksh(cart.paidCents)}</b></div>}
        <div className="totals"><span>Total</span><b>{ksh(Math.max(0, total - cart.discountCents))}</b></div>
        <div className="actions">
          <button className="outline" disabled={busy || !cart.lines.length} onClick={saveLater}>{cart.saleId ? 'Save changes' : 'Save for later'}</button>
          <button className="gold" disabled={busy || !cart.lines.length} onClick={payNow}>Pay now</button>
        </div>
        {canAsk && (
          <div className="ask-row">
            <button className="ghost" onClick={() => setAsk('discount')}>Ask for discount</button>
            <button className="ghost" onClick={() => setAsk('cancel')}>Ask to cancel</button>
          </div>
        )}

        <div className="unpaid">
          <h4>Unpaid sales <span className="badge">{sales.length}</span></h4>
          {sales.map(s => (
            <div key={s.id} className={'u-row' + (s.id === cart.saleId ? ' current' : '')}>
              <div onClick={() => { openSale(s); setSheetTab('order') }} className="u-main" role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && (openSale(s), setSheetTab('order'))}>
                <b>#{s.number} {s.label && <em>{s.label}</em>}</b>
                <small>{ago(s.createdAt)}{s.paidCents ? ` · ${ksh(s.paidCents)} paid` : ''}</small>
              </div>
              <span className="u-amt">{ksh(s.dueCents)}</span>
              <button className="mini" onClick={() => { setCart(cartFromSale(s)); setPaying(s) }}>Pay</button>
            </div>
          ))}
          {!sales.length && <p className="muted small">Nothing waiting.</p>}
        </div>
      </aside>

      {scanOpen && <ScanModal onCode={code => { setScanOpen(false); onScan(code) }} onClose={() => setScanOpen(false)} products={list} />}
      {paying && (
        <PayModal
          sale={paying}
          shift={shift}
          customerPhone={paying.customer?.phone ?? cart.customer?.phone}
          onClose={() => { setPaying(null); unpaid.reload() }}
          onPaid={s => { setPaying(null); reset(); setReceiptFor({ saleId: s.id, copy: false }) }}
        />
      )}
      {receiptFor && <ReceiptLoader saleId={receiptFor.saleId} copy={receiptFor.copy} onClose={() => setReceiptFor(null)} onNewSale={receiptFor.copy ? null : () => setReceiptFor(null)} />}
      {ask === 'cancel' && (
        <ReasonModal title={`Cancel sale #${cart.number}`} eyebrow="Needs a manager" onClose={() => setAsk(null)} busy={busy} onSubmit={r => requestApproval('CANCEL', r)}>
          <p className="muted small">The sale stays in the unpaid list until a manager approves.</p>
        </ReasonModal>
      )}
      {ask === 'discount' && (
        <ReasonModal title={`Discount on sale #${cart.number}`} eyebrow="Needs a manager" onClose={() => setAsk(null)} busy={busy || !discount || discount > total} onSubmit={r => requestApproval('DISCOUNT', r)}>
          <Field label="Discount (KSh)" hint={`Sale total ${ksh(total)}`}>
            <MoneyInput cents={discount} onCents={setDiscount} autoFocus />
          </Field>
        </ReasonModal>
      )}
      {findCustomer && <CustomerPicker onPick={c => { setCart(x => ({ ...x, customer: c })); setFindCustomer(false) }} onClose={() => setFindCustomer(false)} />}
    </div>
  )
}

function CustomerPicker({ onPick, onClose }) {
  const [q, setQ] = useState('')
  const found = useApi('/customers' + qs({ q }), [])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [run, busy] = useAction()
  const create = () => run(async () => onPick((await api.post('/customers', { name, phone: phone || null })).customer), 'Customer added')
  return (
    <Modal title="Add customer" eyebrow="Sale" onClose={onClose}>
      {!creating ? (
        <>
          <input className="label-in" value={q} onChange={e => setQ(e.target.value)} placeholder="Search name or phone" autoFocus />
          <div className="pick-list">
            {(found.data?.customers ?? []).slice(0, 8).map(c => (
              <button key={c.id} className="pick" onClick={() => onPick(c)}>
                <span className="avatar">{c.name[0]}</span>
                <span><b>{c.name}</b><small>{c.phone ? '0' + c.phone.replace(/^254/, '') : 'No phone'}</small></span>
              </button>
            ))}
            {found.data && !found.data.customers.length && <p className="muted small">No match.</p>}
          </div>
          <button className="outline wide" onClick={() => { setCreating(true); setName(q) }}>New customer</button>
        </>
      ) : (
        <>
          <Field label="Name"><input className="label-in" value={name} onChange={e => setName(e.target.value)} autoFocus /></Field>
          <Field label="Phone (optional)"><input className="label-in" value={phone} onChange={e => setPhone(e.target.value)} placeholder="0712 345 678" inputMode="tel" /></Field>
          <button className="gold wide" disabled={busy || !name.trim()} onClick={create}>Add and attach</button>
        </>
      )}
    </Modal>
  )
}

export function ScanModal({ onCode, onClose, products = [] }) {
  const [code, setCode] = useState('')
  const [cam, setCam] = useState(false)
  const [camErr, setCamErr] = useState('')
  const video = useRef(null)

  useEffect(() => {
    if (!cam) return
    let stream, timer, stopped = false
    const detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] })
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(s => {
      if (stopped) return s.getTracks().forEach(t => t.stop())
      stream = s
      video.current.srcObject = s
      video.current.play()
      timer = setInterval(async () => {
        try {
          const found = await detector.detect(video.current)
          if (found[0]) onCode(found[0].rawValue)
        } catch {}
      }, 250)
    }).catch(() => setCamErr('Camera not available. Use the scanner or type the code.'))
    return () => { stopped = true; clearInterval(timer); stream && stream.getTracks().forEach(t => t.stop()) }
  }, [cam])

  const submit = e => { e.preventDefault(); if (code.trim()) onCode(code.trim().toUpperCase()) }
  const samples = products.filter(p => p.barcode).slice(0, 4)

  return (
    <Modal title="Scan an item" eyebrow="Barcode" onClose={onClose} className="scan-modal">
      <div className={'scan-window' + (cam ? ' live' : '')}>
        {cam ? <video ref={video} muted playsInline /> : (
          <div className="scan-idle">
            <svg viewBox="0 0 64 40" className="barcode-art" aria-hidden="true">
              {[2, 6, 8, 13, 15, 17, 22, 26, 28, 31, 35, 37, 42, 44, 48, 51, 53, 57, 61].map((x, i) => <rect key={x} x={x} y="2" width={i % 3 === 0 ? 2 : 1} height="36" />)}
            </svg>
            <p>Point the scanner at a bottle or a receipt and pull the trigger.</p>
          </div>
        )}
        <span className="scan-beam" />
      </div>
      {camErr && <div className="err">{camErr}</div>}
      <form onSubmit={submit} className="scan-manual">
        <input value={code} onChange={e => setCode(e.target.value.replace(/[^\dA-Za-z]/g, ''))} placeholder="Or type the barcode" autoFocus />
        <button className="outline" type="submit">Add</button>
      </form>
      {cameraScanSupported() && !cam && <button className="ghost cam-btn" onClick={() => setCam(true)}>Use this device's camera instead</button>}
      {samples.length > 0 && (
        <div className="scan-try">
          <small className="eyebrow">Demo, no scanner? Tap a code</small>
          <div className="chips">{samples.map(p => <button key={p.id} onClick={() => onCode(p.barcode)}>{p.barcode}</button>)}</div>
        </div>
      )}
    </Modal>
  )
}
