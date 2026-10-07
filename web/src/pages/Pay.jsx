import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { useApi, useLive, useSession } from '../session.jsx'
import { Field, Icon, Modal, MoneyInput, ksh, useAction } from '../ui.jsx'

// Taking payment for a saved sale: cash, M-Pesa prompt (STK push), a typed
// M-Pesa code as the fallback, or a split of cash plus M-Pesa.

const MODES = [
  ['cash', 'Cash'],
  ['stk', 'M-Pesa prompt'],
  ['code', 'M-Pesa code'],
  ['split', 'Split']
]

const codeOk = c => /^[A-Z0-9]{10}$/.test(c)
const phoneOk = p => /^(?:\+?254|0)(?:7|1)\d{8}$/.test(p.replace(/[\s-]/g, ''))

function quickNotes(due) {
  const out = new Set()
  for (const step of [50000, 100000, 200000, 500000]) {
    const v = Math.ceil(due / step) * step
    if (v > due) out.add(v)
  }
  return [...out].sort((a, b) => a - b).slice(0, 3)
}

export default function PayModal({ sale: initial, shift, customerPhone, onPaid, onClose }) {
  // a shop whose M-Pesa is not connected yet records M-Pesa by amount alone
  const { user } = useSession()
  const needCode = user?.requireMpesaCode !== false
  // empty is fine when the code is optional; anything typed must be a real code
  const codeFine = c => (needCode ? codeOk(c) : !c || codeOk(c))
  const mpesaItem = amountCents => ({ method: 'MPESA', amountCents, ...(code ? { mpesaRef: code } : {}) })
  const [sale, setSale] = useState(initial)
  const [mode, setMode] = useState('cash')
  const [tendered, setTendered] = useState(null)
  const [code, setCode] = useState('')
  const [phone, setPhone] = useState(customerPhone ? '0' + String(customerPhone).replace(/^254/, '') : '')
  const [splitCash, setSplitCash] = useState(null)
  // prompts only where the shop has real M-Pesa (or a simulation is allowed)
  const status = useApi('/mpesa/status', [])
  const prompts = status.data ? status.data.prompts : false
  const [splitRest, setSplitRest] = useState('code')
  useEffect(() => { if (prompts) setSplitRest('stk') }, [prompts])
  const [request, setRequest] = useState(sale.mpesaRequests?.find(r => r.status === 'PENDING') ?? null)
  const [run, busy] = useAction()
  const paidOnce = useRef(false)

  const due = sale.dueCents
  const hasShift = !!shift

  const finish = s => {
    setSale(s)
    if (s.status === 'PAID' && !paidOnce.current) {
      paidOnce.current = true
      onPaid(s)
    }
  }

  // Live: the STK result and the sale turning PAID can arrive from the server
  useLive('sale:updated', p => p.sale.id === sale.id && finish(p.sale))
  useLive('mpesa:updated', p => {
    if (p.request.saleId !== sale.id) return
    setRequest(r => (!r || r.id === p.request.id ? p.request : r))
  })

  // If a request was already running when the modal opened, resume watching it
  useEffect(() => {
    if (request) setMode('stk')
  }, [])

  const pay = payments =>
    run(async () => {
      // each payment has its own id: sent twice (a weak connection), it is recorded once
      const r = await api.post(`/sales/${sale.id}/pay`, { payments: payments.map(p => ({ ...p, clientId: crypto.randomUUID() })) })
      finish(r.sale)
      return r
    })

  const payCash = () => pay([{ method: 'CASH', amountCents: due, tenderedCents: tendered ?? due }])
  const payCode = () => pay([mpesaItem(due)])

  const sendStk = amountCents =>
    run(async () => {
      const r = await api.post('/mpesa/stk', { saleId: sale.id, phone, amountCents })
      setRequest(r.request)
      setMode('stk')
    })

  const paySplit = async () => {
    const cashPart = splitCash ?? 0
    const cashItem = { method: 'CASH', amountCents: cashPart, tenderedCents: Math.max(tendered ?? cashPart, cashPart) }
    if (splitRest === 'code') return pay([cashItem, mpesaItem(due - cashPart)])
    // cash now, then the rest by prompt on the phone
    const r = await pay([cashItem])
    if (r && r.sale.status !== 'PAID') await sendStk(r.sale.dueCents)
  }

  const query = () => run(async () => setRequest((await api.post(`/mpesa/requests/${request.id}/query`)).request))
  const cancelStk = () => run(async () => setRequest((await api.post(`/mpesa/requests/${request.id}/cancel`)).request))

  const change = Math.max(0, (tendered ?? 0) - (mode === 'split' ? splitCash ?? 0 : due))
  const splitValid = splitCash > 0 && splitCash < due && (splitRest === 'stk' ? phoneOk(phone) && (due - splitCash) % 100 === 0 : codeFine(code))

  const pending = request && request.status === 'PENDING'

  return (
    <Modal
      title={ksh(due)}
      eyebrow={`Sale #${sale.number}${sale.label ? ' · ' + sale.label : ''}${sale.paidCents ? ' · ' + ksh(sale.paidCents) + ' already paid' : ''}`}
      onClose={pending ? null : onClose}
      className="pay-modal"
    >
      {!pending && (
        <div className={'seg ' + (prompts || request ? 'four' : 'three')}>
          {MODES.map(([k, l]) => (
            (k !== 'stk' || prompts || request) && <button key={k} className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{k === 'code' && !needCode ? 'M-Pesa' : l}</button>
          ))}
        </div>
      )}

      {mode === 'cash' && (
        <>
          {!hasShift && <div className="warn-note">Open a shift before taking cash. Use M-Pesa or open a shift from the top bar.</div>}
          <Field label="Cash received (KSh)">
            <MoneyInput cents={tendered} onCents={setTendered} placeholder={String(due / 100)} autoFocus />
          </Field>
          <div className="quick">
            <button onClick={() => setTendered(due)}>Exact</button>
            {quickNotes(due).map(v => <button key={v} onClick={() => setTendered(v)}>{ksh(v)}</button>)}
          </div>
          <div className="change"><span>Change</span><b>{ksh(change)}</b></div>
          <button className="gold wide" disabled={busy || !hasShift || (tendered != null && tendered < due)} onClick={payCash}>
            {busy ? 'Confirming...' : 'Confirm receipt of payment'}
          </button>
        </>
      )}

      {mode === 'code' && (
        <>
          <p className="muted small">{needCode
            ? "Fallback when the prompt does not work. Type the code from the customer's M-Pesa message. A manager checks typed codes."
            : "Check the M-Pesa message on the customer's phone or the shop's phone, then confirm. Typing the code is optional. A manager checks every M-Pesa payment against the statement."}</p>
          <Field label={needCode ? 'M-Pesa transaction code' : 'M-Pesa code (optional)'}>
            <input className="code-in" value={code} maxLength={10} onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="SJK7D3PQ8M" autoFocus />
          </Field>
          {!needCode && <div className="change"><span>M-Pesa received</span><b>{ksh(due)}</b></div>}
          <button className="gold wide" disabled={busy || !codeFine(code)} onClick={payCode}>{busy ? 'Confirming...' : 'Confirm receipt of payment'}</button>
        </>
      )}

      {mode === 'split' && (
        <>
          <div className="split-grid">
            <Field label="Cash part (KSh)">
              <MoneyInput cents={splitCash} onCents={setSplitCash} autoFocus />
            </Field>
            <Field label="Cash received">
              <MoneyInput cents={tendered} onCents={setTendered} placeholder={splitCash ? String(splitCash / 100) : '0'} />
            </Field>
          </div>
          <div className="change"><span>Rest by M-Pesa</span><b>{ksh(Math.max(0, due - (splitCash ?? 0)))}</b></div>
          {prompts && (
            <div className="seg two">
              <button className={splitRest === 'stk' ? 'on' : ''} onClick={() => setSplitRest('stk')}>Prompt on phone</button>
              <button className={splitRest === 'code' ? 'on' : ''} onClick={() => setSplitRest('code')}>{needCode ? 'Typed code' : 'M-Pesa received'}</button>
            </div>
          )}
          {splitRest === 'stk' ? (
            <Field label="Customer phone"><input className="label-in" value={phone} onChange={e => setPhone(e.target.value)} placeholder="0712 345 678" inputMode="tel" /></Field>
          ) : (
            <Field label={needCode ? 'M-Pesa code' : 'M-Pesa code (optional)'}><input className="code-in" value={code} maxLength={10} onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="SJK7D3PQ8M" /></Field>
          )}
          {!hasShift && <div className="warn-note">Open a shift before taking cash.</div>}
          {splitRest === 'stk' && splitCash > 0 && (due - splitCash) % 100 !== 0 && <div className="warn-note">M-Pesa takes whole shillings. Adjust the cash part.</div>}
          <button className="gold wide" disabled={busy || !hasShift || !splitValid} onClick={paySplit}>
            {splitRest === 'stk' ? 'Take cash and send prompt' : 'Confirm receipt of payment'}
          </button>
        </>
      )}

      {mode === 'stk' && !request && (
        <>
          <p className="muted small">The customer gets a prompt on their phone and enters their M-Pesa PIN. The sale is marked paid as soon as Safaricom confirms.</p>
          <Field label="Customer phone">
            <input className="label-in" value={phone} onChange={e => setPhone(e.target.value)} placeholder="0712 345 678" inputMode="tel" autoFocus />
          </Field>
          {due % 100 !== 0 && <div className="warn-note">M-Pesa takes whole shillings. Take the cents in cash with Split.</div>}
          <button className="gold wide" disabled={busy || !phoneOk(phone) || due % 100 !== 0} onClick={() => sendStk(due)}>
            <Icon k="phone" /> Send prompt for {ksh(due)}
          </button>
        </>
      )}

      {mode === 'stk' && request && (
        <StkStatus request={request} busy={busy} onQuery={query} onCancel={cancelStk} onRetry={() => setRequest(null)} onUseCode={() => { setRequest(null); setMode('code') }} />
      )}
    </Modal>
  )
}

function StkStatus({ request, busy, onQuery, onCancel, onRetry, onUseCode }) {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setSecs(Math.floor((Date.now() - new Date(request.createdAt).getTime()) / 1000)), 1000)
    return () => clearInterval(t)
  }, [request.createdAt])
  const phone = '0' + String(request.phone).replace(/^254/, '')

  if (request.status === 'PENDING') {
    return (
      <div className="stk-wait">
        <div className="stk-phone"><Icon k="phone" /><span className="stk-ring" /></div>
        <b>Waiting for the customer</b>
        <p className="muted">Prompt sent to {phone} for {ksh(request.amountCents)}. Ask them to enter their M-Pesa PIN.</p>
        <span className="stk-timer">{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</span>
        <div className="actions">
          <button className="outline" disabled={busy} onClick={onQuery}><Icon k="refresh" /> Check status</button>
          <button className="ghost" disabled={busy} onClick={onCancel}>Cancel prompt</button>
        </div>
      </div>
    )
  }
  if (request.status === 'SUCCESS') {
    return (
      <div className="stk-wait ok">
        <b>Payment received</b>
        <p className="muted">M-Pesa code {request.receipt}. {request.resultDesc && !/success/i.test(request.resultDesc) ? request.resultDesc : ''}</p>
      </div>
    )
  }
  const reason = { CANCELLED: 'The customer cancelled the prompt.', TIMEOUT: 'No answer from the phone.', FAILED: 'The payment failed.' }[request.status]
  return (
    <div className="stk-wait bad">
      <b>{reason}</b>
      {request.resultDesc && <p className="muted">{request.resultDesc}</p>}
      <div className="actions">
        <button className="gold" onClick={onRetry}>Send again</button>
        <button className="outline" onClick={onUseCode}>Use a typed code</button>
      </div>
    </div>
  )
}
