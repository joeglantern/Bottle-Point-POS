import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useBarcodeScanner, cameraScanSupported } from './scanner.js'
import ReceiptModal, { parseReceiptCode } from './Receipt.jsx'
import {
  BRANCHES, USERS, CATEGORIES, PRODUCTS, SEED_SALES, OTHER_BRANCHES, CUSTOMERS,
  ksh, saleTotal, ago, timeOf
} from './data.js'

function Logo({ className = 'logo' }) {
  return (
    <span className={className}>
      <img src="/brand/bottle-point-lockup.png" alt="Bottle Point" className="on-dark" />
      <img src="/brand/bottle-point-lockup-light.png" alt="Bottle Point" className="on-light" />
    </span>
  )
}

function Bottle({ tint }) {
  return (
    <svg viewBox="0 0 40 80" className="bottle" aria-hidden="true">
      <path d="M16 2h8v4h-1v14c0 5 10 7 10 16v38c0 2-1 3-3 3H10c-2 0-3-1-3-3V36c0-9 10-11 10-16V6h-1z" fill={tint} />
      <path d="M16 2h8v4h-8z" fill="#C9A45C" opacity=".8" />
      <rect x="10" y="44" width="20" height="16" rx="1.5" fill="#C9A45C" opacity=".22" />
      <path d="M11 38c0-6 6-8 7-12" stroke="#fff" strokeOpacity=".18" strokeWidth="1.5" fill="none" />
    </svg>
  )
}

/* ---------------- Theme ---------------- */

function initialTheme() {
  try {
    const saved = localStorage.getItem('bp-theme')
    if (saved === 'light' || saved === 'dark') return saved
  } catch {}
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function useTheme() {
  const [theme, setTheme] = useState(initialTheme)
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem('bp-theme', theme) } catch {}
  }, [theme])
  return [theme, () => setTheme(t => (t === 'dark' ? 'light' : 'dark'))]
}

function ThemeButton({ theme, toggle }) {
  return (
    <button className="theme-btn" onClick={toggle} title={theme === 'dark' ? 'Light theme' : 'Dark theme'} aria-label="Switch theme">
      {theme === 'dark'
        ? <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
        : <svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" /></svg>}
    </button>
  )
}

/* ---------------- Login ---------------- */

function Login({ onLogin, themeBtn }) {
  const [user, setUser] = useState(USERS[0])
  const [pin, setPin] = useState('')
  const [err, setErr] = useState('')

  const press = d => {
    setErr('')
    if (d === 'del') return setPin(p => p.slice(0, -1))
    const next = (pin + d).slice(0, 4)
    setPin(next)
    if (next.length === 4) {
      if (next === '1234') onLogin(user)
      else { setErr('Wrong PIN. Try 1234 for the demo.'); setPin('') }
    }
  }

  return (
    <div className="login">
      {themeBtn}
      <div className="login-art">
        <h1 className="login-brand"><Logo className="logo xl" /></h1>
        <p className="login-sub">Point of sale for wines, spirits and local pubs.</p>
      </div>
      <div className="login-card">
        <h2>Sign in</h2>
        <p className="muted">Pick your name and enter your PIN.</p>
        <div className="user-list">
          {USERS.map(u => (
            <button key={u.id} className={'user-pill' + (u.id === user.id ? ' on' : '')} onClick={() => { setUser(u); setPin('') }}>
              <span className="avatar">{u.name[0]}</span>
              <span>
                <b>{u.name}</b>
                <small>{u.role}</small>
              </span>
            </button>
          ))}
        </div>
        <div className="pin-dots">
          {[0, 1, 2, 3].map(i => <span key={i} className={i < pin.length ? 'full' : ''} />)}
        </div>
        <div className="err">{err}</div>
        <div className="pad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map((d, i) =>
            d === '' ? <span key={i} /> :
              <button key={i} onClick={() => press(d)}>{d === 'del' ? '⌫' : d}</button>
          )}
        </div>
      </div>
    </div>
  )
}

/* ---------------- Payment modal ---------------- */

function PayModal({ sale, usedCodes, onClose, onConfirm }) {
  const total = saleTotal(sale)
  const [cash, setCash] = useState('')
  const [mpesa, setMpesa] = useState('')
  const [code, setCode] = useState('')
  const [mode, setMode] = useState('cash')
  const [err, setErr] = useState('')

  const cashN = Number(cash) || 0
  const mpesaN = mode === 'cash' ? 0 : mode === 'mpesa' ? total : Number(mpesa) || 0
  const cashPart = mode === 'mpesa' ? 0 : mode === 'cash' ? total : total - mpesaN
  const change = mode === 'mpesa' ? 0 : Math.max(0, cashN - cashPart)

  const confirm = () => {
    const c = code.trim().toUpperCase()
    if (mode !== 'cash') {
      if (!/^[A-Z0-9]{10}$/.test(c)) return setErr('M-Pesa code must be 10 letters or digits.')
      if (usedCodes.has(c)) return setErr('This M-Pesa code is already linked to another sale.')
      if (mode === 'split' && (mpesaN <= 0 || mpesaN >= total)) return setErr('Enter the M-Pesa part of the split.')
    }
    if (mode !== 'mpesa' && cashN < cashPart) return setErr('Cash received is less than the cash due.')
    const payments = []
    if (cashPart > 0) payments.push({ method: 'cash', amount: cashPart, tendered: mode === 'split' || mode === 'cash' ? cashN : cashPart })
    if (mpesaN > 0) payments.push({ method: 'mpesa', amount: mpesaN, ref: c })
    onConfirm(payments)
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <small className="muted">Sale #{sale.no}{sale.label ? ' · ' + sale.label : ''}</small>
            <h3>{ksh(total)}</h3>
          </div>
          <button className="ghost" onClick={onClose}>Close</button>
        </div>
        <div className="seg">
          {[['cash', 'Cash'], ['mpesa', 'M-Pesa'], ['split', 'Split']].map(([k, l]) => (
            <button key={k} className={mode === k ? 'on' : ''} onClick={() => { setMode(k); setErr('') }}>{l}</button>
          ))}
        </div>

        {mode === 'split' && (
          <label className="field">
            <span>M-Pesa amount</span>
            <input inputMode="numeric" value={mpesa} onChange={e => setMpesa(e.target.value.replace(/\D/g, ''))} placeholder="0" />
          </label>
        )}
        {mode !== 'cash' && (
          <label className="field">
            <span>M-Pesa transaction code</span>
            <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="e.g. SJK7D3PQ8M" maxLength={10} />
          </label>
        )}
        {mode !== 'mpesa' && (
          <label className="field">
            <span>Cash received {mode === 'split' && <em className="muted">(due {ksh(cashPart)})</em>}</span>
            <input inputMode="numeric" value={cash} onChange={e => setCash(e.target.value.replace(/\D/g, ''))} placeholder="0" autoFocus />
          </label>
        )}
        {mode !== 'mpesa' && (
          <div className="change">
            <span>Change</span>
            <b>{ksh(change)}</b>
          </div>
        )}
        <div className="err">{err}</div>
        <button className="gold wide" onClick={confirm}>Confirm receipt of payment</button>
      </div>
    </div>
  )
}

// Demo sales are in shillings; the receipt system works in cents like the API.
function toReceipt(sale, copy = false) {
  const lines = sale.lines.map(l => ({ name: l.name, qty: l.qty, unitCents: l.price * 100 }))
  const total = saleTotal(sale) * 100
  return {
    business: { name: 'Bottle Point Demo', address: 'Woodvale Grove, Westlands, Nairobi', phone: '0712 000 000' },
    branch: { name: BRANCHES.find(b => b.id === sale.branch).name },
    number: sale.no,
    status: sale.status === 'refunded' ? 'REFUNDED' : 'PAID',
    paidAt: sale.paidAt || sale.at,
    refundedAt: sale.refundedAt,
    servedBy: sale.paidBy || sale.cashier,
    label: sale.label,
    lines,
    subtotalCents: total,
    discountCents: 0,
    totalCents: total,
    payments: (sale.payments || []).map(p => ({
      method: p.method === 'cash' ? 'CASH' : 'MPESA',
      amountCents: p.amount * 100,
      tenderedCents: p.method === 'cash' ? (p.tendered || p.amount) * 100 : null,
      mpesaRef: p.ref,
      phone: p.phone,
      verification: p.stk ? 'STK_CONFIRMED' : 'MANUAL_UNVERIFIED'
    })),
    copy
  }
}

/* ---------------- Scanner ---------------- */

function ScanModal({ onCode, onClose }) {
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

  const submit = e => { e.preventDefault(); if (code.trim()) { onCode(code.trim()); setCode('') } }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal scan-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <small className="eyebrow">Barcode</small>
            <h3 className="title-serif sm">Scan an item</h3>
          </div>
          <button className="ghost" onClick={onClose}>Close</button>
        </div>

        <div className={'scan-window' + (cam ? ' live' : '')}>
          {cam ? <video ref={video} muted playsInline /> : (
            <div className="scan-idle">
              <svg viewBox="0 0 64 40" className="barcode-art" aria-hidden="true">
                {[2, 6, 8, 13, 15, 17, 22, 26, 28, 31, 35, 37, 42, 44, 48, 51, 53, 57, 61].map((x, i) =>
                  <rect key={x} x={x} y="2" width={i % 3 === 0 ? 2 : 1} height="36" />)}
              </svg>
              <p>Point the scanner at the barcode and pull the trigger.</p>
            </div>
          )}
          <span className="scan-beam" />
        </div>
        {camErr && <div className="err">{camErr}</div>}

        <form onSubmit={submit} className="scan-manual">
          <input value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="Or type the barcode" />
          <button className="outline" type="submit">Add</button>
        </form>

        {cameraScanSupported() && !cam && (
          <button className="ghost cam-btn" onClick={() => setCam(true)}>Use this device's camera instead</button>
        )}

        <div className="scan-try">
          <small className="eyebrow">Demo, no scanner? Tap a code</small>
          <div className="chips">
            {PRODUCTS.slice(0, 4).map(p => <button key={p.id} onClick={() => onCode(p.code)}>{p.code}</button>)}
            <button onClick={() => onCode('4006381333931')}>Unknown code</button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---------------- Cashier ---------------- */

function Cashier({ user, sales, setSales, nextNo, toast }) {
  const [cat, setCat] = useState('All')
  const [q, setQ] = useState('')
  const [cart, setCart] = useState([])
  const [editing, setEditing] = useState(null)
  const [label, setLabel] = useState('')
  const [paying, setPaying] = useState(null)
  const [receipt, setReceipt] = useState(null)
  const [scanOpen, setScanOpen] = useState(false)
  const [lastScan, setLastScan] = useState(null)
  const [flash, setFlash] = useState(null)

  const onScan = code => {
    const no = parseReceiptCode(code)
    if (no) {
      const s = sales.find(x => x.no === no && x.branch === user.branch)
      setLastScan({ code, name: s ? 'receipt #' + no : null, at: Date.now() })
      if (!s) return toast('No sale #' + no + ' in this branch')
      if (s.status === 'saved') return openSaved(s)
      if (s.status === 'paid' || s.status === 'refunded') return setReceipt({ sale: s, copy: true })
      return toast('Sale #' + no + ' is ' + s.status)
    }
    const p = PRODUCTS.find(x => x.code === code)
    setLastScan({ code, name: p ? p.name : null, at: Date.now() })
    if (p) {
      add(p)
      setFlash(p.id)
      setTimeout(() => setFlash(f => (f === p.id ? null : f)), 700)
    } else {
      toast('No product with barcode ' + code)
    }
  }
  useBarcodeScanner(onScan, !paying && !receipt)

  const list = PRODUCTS.filter(p =>
    (cat === 'All' || p.cat === cat) &&
    (q === '' || p.name.toLowerCase().includes(q.toLowerCase()) || p.code.includes(q))
  )
  const unpaid = sales.filter(s => s.status === 'saved' && s.branch === user.branch)
  const usedCodes = new Set(sales.flatMap(s => (s.payments || []).filter(p => p.ref).map(p => p.ref)))
  const total = cart.reduce((a, l) => a + l.price * l.qty, 0)

  const add = p => setCart(c => {
    const f = c.find(l => l.pid === p.id)
    return f ? c.map(l => l.pid === p.id ? { ...l, qty: l.qty + 1 } : l) : [...c, { pid: p.id, name: p.name, price: p.price, qty: 1 }]
  })
  const qty = (pid, d) => setCart(c => c.map(l => l.pid === pid ? { ...l, qty: l.qty + d } : l).filter(l => l.qty > 0))

  const reset = () => { setCart([]); setEditing(null); setLabel('') }

  const persist = status => {
    if (editing) {
      const s = { ...sales.find(x => x.no === editing), lines: cart, label: label || undefined }
      setSales(all => all.map(x => x.no === editing ? s : x))
      return s
    }
    const s = { no: nextNo(), branch: user.branch, cashier: user.name, at: Date.now(), status, lines: cart, label: label || undefined }
    setSales(all => [s, ...all])
    return s
  }

  const saveLater = () => {
    if (!cart.length) return
    const s = persist('saved')
    toast(`Sale #${s.no} saved to unpaid list`)
    reset()
  }
  const payNow = () => {
    if (!cart.length) return
    const s = persist('saved')
    setPaying(s)
    reset()
  }
  const openSaved = s => { setEditing(s.no); setCart(s.lines); setLabel(s.label || '') }

  const confirmPay = payments => {
    const paid = { ...paying, status: 'paid', payments, paidBy: user.name, paidAt: Date.now() }
    setSales(all => all.map(x => x.no === paid.no ? paid : x))
    setPaying(null)
    setReceipt({ sale: paid, copy: false })
  }

  return (
    <div className="cashier">
      <section className="catalog">
        <div className="bar">
          <div className="search">
            <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search by name" />
          </div>
          <button className="scan-btn" onClick={() => setScanOpen(true)} title="Scan barcode">
            <svg viewBox="0 0 24 24" className="ico"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M10 8v8M13 8v8M17 8v8" /></svg>
            <span>Scan</span>
          </button>
        </div>
        <div className={'scanner-status' + (lastScan && !lastScan.name ? ' miss' : '')}>
          <span className="pulse" />
          <span className="s-label">Scanner ready</span>
          {lastScan && (
            <span className="s-last" key={lastScan.at}>
              <code>{lastScan.code}</code>
              {lastScan.name ? <> added {lastScan.name}</> : <> not found</>}
            </span>
          )}
        </div>
        <div className="chips">
          {CATEGORIES.map(c => <button key={c} className={c === cat ? 'on' : ''} onClick={() => setCat(c)}>{c}</button>)}
        </div>
        <div className="grid">
          {list.map(p => (
            <button key={p.id} className={'product' + (flash === p.id ? ' flash' : '')} onClick={() => add(p)}>
              <Bottle tint={p.tint} />
              <div className="p-info">
                <b>{p.name}</b>
                <small>{p.size} {'·'} {p.cat}</small>
                <span className="price">{ksh(p.price)}</span>
              </div>
            </button>
          ))}
          {!list.length && <p className="muted pad-l">No products match that search.</p>}
        </div>
      </section>

      <aside className="order">
        <div className="order-head">
          <h3>{editing ? `Sale #${editing}` : 'New sale'}</h3>
          {editing && <button className="ghost" onClick={reset}>New</button>}
        </div>
        <input className="label-in" value={label} onChange={e => setLabel(e.target.value)} placeholder="Label (customer or table), optional" />
        <div className="lines">
          {cart.map(l => (
            <div key={l.pid} className="line">
              <div><b>{l.name}</b><small>{ksh(l.price)}</small></div>
              <div className="stepper">
                <button onClick={() => qty(l.pid, -1)}>{'−'}</button>
                <span>{l.qty}</span>
                <button onClick={() => qty(l.pid, 1)}>+</button>
              </div>
              <b className="lt">{ksh(l.price * l.qty)}</b>
            </div>
          ))}
          {!cart.length && <p className="empty">Tap a bottle to start a sale.</p>}
        </div>
        <div className="totals">
          <span>Total</span><b>{ksh(total)}</b>
        </div>
        <div className="actions">
          <button className="outline" disabled={!cart.length} onClick={saveLater}>Save for later</button>
          <button className="gold" disabled={!cart.length} onClick={payNow}>Pay now</button>
        </div>

        <div className="unpaid">
          <h4>Unpaid sales <span className="badge">{unpaid.length}</span></h4>
          {unpaid.map(s => (
            <div key={s.no} className="u-row">
              <div onClick={() => openSaved(s)} className="u-main">
                <b>#{s.no} {s.label && <em>{s.label}</em>}</b>
                <small>{s.cashier} {'·'} {ago(s.at)}</small>
              </div>
              <span className="u-amt">{ksh(saleTotal(s))}</span>
              <button className="mini" onClick={() => setPaying(s)}>Pay</button>
            </div>
          ))}
          {!unpaid.length && <p className="muted small">Nothing waiting.</p>}
        </div>
      </aside>

      {scanOpen && <ScanModal onCode={code => { onScan(code); setScanOpen(false) }} onClose={() => setScanOpen(false)} />}
      {paying && <PayModal sale={paying} usedCodes={usedCodes} onClose={() => setPaying(null)} onConfirm={confirmPay} />}
      {receipt && <ReceiptModal receipt={toReceipt(receipt.sale, receipt.copy)} onClose={() => setReceipt(null)} onNewSale={receipt.copy ? null : () => setReceipt(null)} />}
    </div>
  )
}

/* ---------------- Manager ---------------- */

function Stat({ label, value, note }) {
  return (
    <div className="stat">
      <small>{label}</small>
      <b>{value}</b>
      {note && <span>{note}</span>}
    </div>
  )
}

function Manager({ sales, setSales, float, user, toast }) {
  const [counted, setCounted] = useState('')
  const today = sales.filter(s => s.branch === 'wl')
  const paid = today.filter(s => s.status === 'paid')
  const unpaid = today.filter(s => s.status === 'saved')
  const cancelled = today.filter(s => ['cancelled', 'refunded', 'refund_requested'].includes(s.status))
  const refundCash = today.filter(s => s.status === 'refunded').flatMap(s => s.payments).filter(p => p.method === 'cash').reduce((a, p) => a + p.amount, 0)
  const decide = (no, status) => { setSales(all => all.map(x => x.no === no ? { ...x, status, approvedBy: user.name, refundedAt: status === 'refunded' ? Date.now() : x.refundedAt } : x)); toast('Sale #' + no + ' ' + status) }
  const pay = paid.flatMap(s => s.payments)
  const cash = pay.filter(p => p.method === 'cash').reduce((a, p) => a + p.amount, 0)
  const mpesa = pay.filter(p => p.method === 'mpesa').reduce((a, p) => a + p.amount, 0)
  const expected = float + cash - refundCash
  const variance = counted === '' ? null : Number(counted) - expected

  const perCashier = {}
  paid.forEach(s => { perCashier[s.paidBy] = (perCashier[s.paidBy] || 0) + saleTotal(s) })
  const prod = {}
  paid.forEach(s => s.lines.forEach(l => { prod[l.name] = (prod[l.name] || 0) + l.qty * l.price }))
  const top = Object.entries(prod).sort((a, b) => b[1] - a[1]).slice(0, 5)
  const topMax = top[0]?.[1] || 1

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Today at Westlands</h2>
          <p className="muted">{new Date().toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        </div>
      </div>

      <div className="stats">
        <Stat label="Paid sales" value={ksh(cash + mpesa)} note={paid.length + ' sales'} />
        <Stat label="Cash" value={ksh(cash)} />
        <Stat label="M-Pesa" value={ksh(mpesa)} />
        <Stat label="Unpaid (saved)" value={ksh(unpaid.reduce((a, s) => a + saleTotal(s), 0))} note={unpaid.length + ' open'} />
      </div>

      <div className="two">
        <div className="card">
          <h4>Till reconciliation</h4>
          <div className="recon">
            <div><span>Opening float</span><b>{ksh(float)}</b></div>
            <div><span>Cash sales</span><b>+ {ksh(cash)}</b></div>
            <div><span>Cash refunds</span><b>{'−'} {ksh(refundCash)}</b></div>
            <div className="sum"><span>Expected in till</span><b>{ksh(expected)}</b></div>
          </div>
          <label className="field">
            <span>Counted cash</span>
            <input inputMode="numeric" value={counted} onChange={e => setCounted(e.target.value.replace(/\D/g, ''))} placeholder="Enter the count" />
          </label>
          {variance !== null && (
            <div className={'variance ' + (variance === 0 ? 'ok' : variance < 0 ? 'short' : 'over')}>
              {variance === 0 ? 'Till balances.' : variance < 0 ? `Short by ${ksh(-variance)}` : `Over by ${ksh(variance)}`}
            </div>
          )}
        </div>

        <div className="card">
          <h4>Best sellers</h4>
          {top.map(([n, v]) => (
            <div key={n} className="barrow">
              <span>{n}</span>
              <div className="track"><i style={{ width: (v / topMax) * 100 + '%' }} /></div>
              <b>{ksh(v)}</b>
            </div>
          ))}
          <h4 className="mt">By cashier</h4>
          {Object.entries(perCashier).map(([n, v]) => (
            <div key={n} className="kv"><span>{n}</span><b>{ksh(v)}</b></div>
          ))}
        </div>
      </div>

      <div className="card">
        <h4>Unpaid and exceptions</h4>
        <table>
          <thead><tr><th>Sale</th><th>Label</th><th>Opened by</th><th>Age</th><th>Status</th><th className="r">Value</th><th></th></tr></thead>
          <tbody>
            {[...unpaid, ...cancelled].map(s => (
              <tr key={s.no}>
                <td>#{s.no}</td><td>{s.label || '-'}</td><td>{s.cashier}</td><td>{ago(s.at)}</td>
                <td><span className={'tag ' + s.status}>{s.status}</span></td>
                <td className="r">{ksh(saleTotal(s))}</td>
                <td className="r">
                  {s.status === 'saved' && <button className="mini" onClick={() => decide(s.no, 'cancelled')}>Cancel</button>}
                  {s.status === 'refund_requested' && <button className="mini on" onClick={() => decide(s.no, 'refunded')}>Approve refund</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ---------------- Owner ---------------- */

function Owner({ sales }) {
  const wl = sales.filter(s => s.branch === 'wl')
  const paid = wl.filter(s => s.status === 'paid').flatMap(s => s.payments)
  const unpaid = wl.filter(s => s.status === 'saved')
  const rows = [
    {
      id: 'wl', name: 'Westlands',
      cash: paid.filter(p => p.method === 'cash').reduce((a, p) => a + p.amount, 0),
      mpesa: paid.filter(p => p.method === 'mpesa').reduce((a, p) => a + p.amount, 0),
      count: wl.filter(s => s.status === 'paid').length,
      unpaid: unpaid.length, unpaidValue: unpaid.reduce((a, s) => a + saleTotal(s), 0), variance: 0
    },
    ...OTHER_BRANCHES
  ]
  const sum = k => rows.reduce((a, r) => a + r[k], 0)
  const max = Math.max(...rows.map(r => r.cash + r.mpesa))

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>All branches</h2>
          <p className="muted">End of day view across {rows.length} branches</p>
        </div>
      </div>
      <div className="stats">
        <Stat label="Combined paid sales" value={ksh(sum('cash') + sum('mpesa'))} note={sum('count') + ' sales'} />
        <Stat label="Cash" value={ksh(sum('cash'))} />
        <Stat label="M-Pesa" value={ksh(sum('mpesa'))} />
        <Stat label="Unpaid across branches" value={ksh(sum('unpaidValue'))} note={sum('unpaid') + ' open'} />
      </div>
      <div className="card">
        <h4>Branch comparison</h4>
        {rows.map(r => (
          <div key={r.id} className="branch-bar">
            <span>{r.name}</span>
            <div className="track stacked">
              <i className="c" style={{ width: (r.cash / max) * 100 + '%' }} />
              <i className="m" style={{ width: (r.mpesa / max) * 100 + '%' }} />
            </div>
            <b>{ksh(r.cash + r.mpesa)}</b>
          </div>
        ))}
        <div className="legend"><span><i className="c" />Cash</span><span><i className="m" />M-Pesa</span></div>
      </div>
      <div className="card">
        <table>
          <thead><tr><th>Branch</th><th className="r">Sales</th><th className="r">Cash</th><th className="r">M-Pesa</th><th className="r">Unpaid</th><th className="r">Till variance</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td>{r.name}</td><td className="r">{r.count}</td><td className="r">{ksh(r.cash)}</td><td className="r">{ksh(r.mpesa)}</td>
                <td className="r">{r.unpaid} ({ksh(r.unpaidValue)})</td>
                <td className={'r ' + (r.variance < 0 ? 'neg' : '')}>{r.variance === 0 ? 'Balanced' : ksh(r.variance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ---------------- Transactions ---------------- */

function Transactions({ sales, setSales, user, toast }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(null)
  const [receipt, setReceipt] = useState(null)
  const rows = sales.filter(s => s.branch === 'wl').filter(s => {
    if (!q) return true
    const t = q.toLowerCase()
    return String(s.no).includes(t) || s.cashier.toLowerCase().includes(t) ||
      (s.payments || []).some(p => p.method.includes(t) || (p.ref || '').toLowerCase().includes(t))
  }).sort((a, b) => b.at - a.at)

  return (
    <div className="page">
      <div className="page-head row">
        <h2>Transactions</h2>
        <div className="search narrow">
          <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Sale number, cashier or M-Pesa code" />
        </div>
      </div>
      <div className="card flush">
        <table>
          <thead><tr><th>Sale</th><th>Time</th><th>Items</th><th>Payment</th><th>Cashier</th><th>Status</th><th className="r">Total</th></tr></thead>
          <tbody>
            {rows.map(s => (
              <Fragment key={s.no}>
                <tr className="click" onClick={() => setOpen(open === s.no ? null : s.no)}>
                  <td>#{s.no}</td>
                  <td>{timeOf(s.at)}</td>
                  <td>
                    <div className="mini-bottles">
                      {s.lines.slice(0, 3).map(l => <Bottle key={l.pid} tint={PRODUCTS.find(p => p.id === l.pid).tint} />)}
                    </div>
                  </td>
                  <td>{(s.payments || []).map((p, i) => <span key={i} className={'pm ' + p.method}>{p.method === 'cash' ? 'Cash' : 'M-Pesa'}</span>)}{!s.payments && <span className="muted">{'-'}</span>}</td>
                  <td>{s.cashier}</td>
                  <td><span className={'tag ' + s.status}>{s.status}</span></td>
                  <td className="r"><b>{ksh(saleTotal(s))}</b></td>
                </tr>
                {open === s.no && (
                  <tr className="expand">
                    <td colSpan={7}>
                      <div className="expand-in">
                        <div>
                          {s.lines.map(l => <div key={l.pid}>{l.name} x{l.qty}</div>)}
                        </div>
                        <div>
                          {(s.payments || []).map((p, i) => <div key={i} className="muted">{p.method === 'cash' ? 'Cash' : 'M-Pesa ' + p.ref}: {ksh(p.amount)}</div>)}
                          {s.paidBy && <div className="muted">Confirmed by {s.paidBy} at {timeOf(s.paidAt)}</div>}
                        </div>
                        <div className="expand-act">
                          {(s.status === 'paid' || s.status === 'refunded') && <button className="mini" onClick={() => setReceipt(s)}>Reprint receipt</button>}
                          {s.status === 'paid' && <button className="mini" onClick={() => { setSales(all => all.map(x => x.no === s.no ? { ...x, status: 'refund_requested', refundBy: user.name } : x)); toast('Refund sent to manager for approval') }}>Request refund</button>}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {receipt && <ReceiptModal receipt={toReceipt(receipt, true)} onClose={() => setReceipt(null)} />}
    </div>
  )
}

/* ---------------- Inventory ---------------- */

function stockTag(n) {
  if (n === 0) return <span className="tag cancelled">Out of stock</span>
  if (n < 10) return <span className="tag saved">Low: {n}</span>
  return <span className="tag ok">In stock: {n}</span>
}

function Inventory() {
  const [cat, setCat] = useState('All')
  const list = PRODUCTS.filter(p => cat === 'All' || p.cat === cat)
  const low = PRODUCTS.filter(p => p.stock < 10).sort((a, b) => a.stock - b.stock)
  const units = PRODUCTS.reduce((a, p) => a + p.stock, 0)
  const value = PRODUCTS.reduce((a, p) => a + p.stock * p.price, 0)

  return (
    <div className="cashier">
      <section className="catalog">
        <h2 className="title-serif">Inventory</h2>
        <div className="chips">
          {CATEGORIES.map(c => <button key={c} className={c === cat ? 'on' : ''} onClick={() => setCat(c)}>{c}</button>)}
        </div>
        <div className="grid">
          {list.map(p => (
            <div key={p.id} className="product inv">
              <Bottle tint={p.tint} />
              <div className="p-info">
                <b>{p.name}</b>
                <small>Barcode {p.code}</small>
                <div className="inv-row">{stockTag(p.stock)}</div>
                <span className="price">{ksh(p.price)}</span>
              </div>
            </div>
          ))}
        </div>
      </section>
      <aside className="order">
        <h3 className="title-serif sm">Stock</h3>
        <div className="stock-sum">
          <div><small>Units on hand</small><b>{units}</b></div>
          <div><small>Retail value</small><b>{ksh(value)}</b></div>
        </div>
        <button className="gold">Add product</button>
        <button className="outline">Receive stock</button>
        <div className="unpaid">
          <h4>Low stock alerts <span className="badge">{low.length}</span></h4>
          {low.map(p => (
            <div key={p.id} className="u-row">
              <div className="u-main"><b>{p.name}</b><small>{p.stock === 0 ? 'Out of stock' : p.stock + ' left'}</small></div>
              <span className={'dot ' + (p.stock === 0 ? 'red' : 'amber')} />
            </div>
          ))}
        </div>
      </aside>
    </div>
  )
}

/* ---------------- Customers ---------------- */

const initials = n => n.split(' ').map(w => w[0]).slice(0, 2).join('')

function Customers() {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(CUSTOMERS[0])
  const list = CUSTOMERS.filter(c => c.name.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="cashier">
      <section className="catalog">
        <div className="page-head row">
          <h2 className="title-serif">Customers</h2>
          <div className="search narrow">
            <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search by name" />
          </div>
        </div>
        <div className="grid wide-cards">
          {list.map(c => (
            <button key={c.id} className={'product cust' + (sel.id === c.id ? ' sel' : '')} onClick={() => setSel(c)}>
              <span className="avatar lg">{initials(c.name)}</span>
              <div className="p-info">
                <b>{c.name}</b>
                <small>{c.phone}</small>
                <div className="cust-meta">
                  <span><small>Spent</small>{ksh(c.spent)}</span>
                  <span><small>Visits</small>{c.visits}</span>
                  <span className={'tier ' + c.tier.toLowerCase()}>{c.tier}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </section>
      <aside className="order">
        <div className="cust-head">
          <span className="avatar xl">{initials(sel.name)}</span>
          <div><h3 className="title-serif sm">{sel.name}</h3><small className="muted">{sel.phone}</small></div>
        </div>
        <div className="stock-sum">
          <div><small>Lifetime spend</small><b>{ksh(sel.spent)}</b></div>
          <div><small>Open tab</small><b className={sel.tab ? 'gold-t' : ''}>{ksh(sel.tab)}</b></div>
        </div>
        <div className="kv"><span className="muted">Tier</span><b>{sel.tier}</b></div>
        <div className="kv"><span className="muted">Last visit</span><b>{sel.last}</b></div>
        <div className="kv"><span className="muted">Visits</span><b>{sel.visits}</b></div>
        <div className="loyal">
          <div className="kv"><span className="muted">Progress to next tier</span><b>{Math.min(100, Math.round(sel.spent / 1500))}%</b></div>
          <div className="track"><i style={{ width: Math.min(100, sel.spent / 1500) + '%' }} /></div>
        </div>
        <button className="gold">Attach to current sale</button>
        <button className="outline">Edit details</button>
      </aside>
    </div>
  )
}

/* ---------------- Open shift ---------------- */

function OpenShift({ user, onOpen, onBack }) {
  const [amt, setAmt] = useState('5000')
  return (
    <div className="center-screen">
      <div className="modal static">
        <img src="/brand/bottle-point-mark.png" alt="" width="40" />
        <h3 className="title-serif sm">Open your shift</h3>
        <p className="muted">Hi {user.name.split(' ')[0]}. Count the cash in the till and enter the opening float.</p>
        <label className="field">
          <span>Opening float (KSh)</span>
          <input inputMode="numeric" value={amt} onChange={e => setAmt(e.target.value.replace(/\D/g, ''))} autoFocus />
        </label>
        <button className="gold wide" disabled={!amt} onClick={() => onOpen(Number(amt))}>Open shift</button>
        <button className="ghost" onClick={onBack}>Back to sign in</button>
      </div>
    </div>
  )
}

/* ---------------- Shell ---------------- */

const ICONS = {
  till: <path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6M10 21h.01M17 21h.01" />,
  history: <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3" />,
  stock: <path d="M21 8 12 3 3 8v8l9 5 9-5V8ZM3 8l9 5 9-5M12 13v8" />,
  today: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  branches: <path d="M12 21s-7-5.6-7-11a7 7 0 0 1 14 0c0 5.4-7 11-7 11Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />,
  customers: <path d="M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 20v-1a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" />,
  out: <path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l-5-5 5-5M5 12h11" />
}
const Icon = ({ k }) => <svg viewBox="0 0 24 24" className="ico">{ICONS[k]}</svg>

export default function App() {
  const [theme, toggleTheme] = useTheme()
  const themeBtn = <ThemeButton theme={theme} toggle={toggleTheme} />
  const [user, setUser] = useState(null)
  const [sales, setSales] = useState(SEED_SALES)
  const [view, setView] = useState('till')
  const [msg, setMsg] = useState('')
  const [shift, setShift] = useState(null)
  const float = shift ? shift.float : 5000

  const nextNo = useMemo(() => {
    let n = Math.max(...SEED_SALES.map(s => s.no))
    return () => ++n
  }, [])

  const toast = m => { setMsg(m); setTimeout(() => setMsg(''), 2400) }

  if (!user) return <Login themeBtn={themeBtn} onLogin={u => { setShift(null); setUser(u); setView(u.role === 'owner' ? 'branches' : u.role === 'manager' ? 'today' : 'till') }} />

  if (!shift && user.role !== 'owner') return <OpenShift user={user} onBack={() => setUser(null)} onOpen={f => { setShift({ float: f, at: Date.now() }); toast('Shift opened with ' + ksh(f)) }} />

  const tabs = [['till', 'Till'], ['history', 'Transactions'], ['customers', 'Customers']]
  if (user.role !== 'cashier') tabs.push(['stock', 'Inventory'], ['today', 'Daily sales'])
  if (user.role === 'owner') tabs.push(['branches', 'Branches'])

  return (
    <div className="shell side">
      <aside className="rail">
        <img src="/brand/bottle-point-mark.png" alt="" className="rail-logo" />
        <nav>
          {tabs.map(([k, l]) => (
            <button key={k} title={l} className={view === k ? 'on' : ''} onClick={() => setView(k)}>
              <Icon k={k} /><span>{l}</span>
            </button>
          ))}
        </nav>
        <button title="Sign out" className="rail-out" onClick={() => setUser(null)}><Icon k="out" /></button>
      </aside>
      <div className="body">
        <header className="top">
          <Logo />
          <div className="who">
            {themeBtn}
            <span className="branch-tag">Westlands</span>
            <span className="avatar">{user.name[0]}</span>
            <div><b>{user.name}</b><small>{user.role}</small></div>
          </div>
        </header>
        <main>
          {view === 'till' && <Cashier user={user} sales={sales} setSales={setSales} nextNo={nextNo} toast={toast} />}
          {view === 'history' && <Transactions sales={sales} setSales={setSales} user={user} toast={toast} />}
          {view === 'customers' && <Customers />}
          {view === 'stock' && <Inventory />}
          {view === 'today' && <Manager sales={sales} setSales={setSales} float={float} user={user} toast={toast} />}
          {view === 'branches' && <Owner sales={sales} />}
        </main>
      </div>
      {msg && <div className="toast">{msg}</div>}
    </div>
  )
}
