import { Fragment, useState } from 'react'
import { api, qs } from '../api.js'
import { useApi, useLive, useSession } from '../session.jsx'
import ReceiptLoader from '../ReceiptLoader.jsx'
import { Bottle, Empty, ErrorNote, Field, Loading, ReasonModal, dateOf, ksh, statusLabel, timeOf, tintFor, todayNairobi, useAction } from '../ui.jsx'

const STATUSES = [['', 'All'], ['PAID', 'Paid'], ['SAVED', 'Unpaid'], ['REFUNDED', 'Refunded'], ['CANCELLED', 'Cancelled']]

export default function Transactions() {
  const { branchId } = useSession()
  const [date, setDate] = useState(todayNairobi())
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(null)
  const [receipt, setReceipt] = useState(null)
  const [refundFor, setRefundFor] = useState(null)
  const [method, setMethod] = useState('CASH')
  const [run, busy] = useAction()

  const res = useApi('/sales' + qs({ date: q ? undefined : date, status, q, limit: 300 }), [branchId])
  const rows = res.data?.sales ?? []

  useLive('sale:updated', ({ sale }) => {
    if (sale.branchId !== branchId) return
    res.setData(d => d && { ...d, sales: d.sales.some(s => s.id === sale.id) ? d.sales.map(s => (s.id === sale.id ? sale : s)) : d.sales })
  })

  const refund = reason =>
    run(async () => {
      await api.post('/approvals', { saleId: refundFor.id, kind: 'REFUND', reason, refundMethod: method })
      setRefundFor(null)
    }, 'Refund request sent to the manager')

  const total = rows.filter(s => s.status === 'PAID').reduce((a, s) => a + s.totalCents, 0)

  return (
    <div className="page">
      <div className="page-head row">
        <div>
          <h2>Transactions</h2>
          <p className="muted">{rows.length} sale{rows.length === 1 ? '' : 's'}{total ? ` · ${ksh(total)} paid` : ''}</p>
        </div>
        <div className="filters">
          <input type="date" className="date-in" value={date} max={todayNairobi()} onChange={e => setDate(e.target.value)} disabled={!!q} />
          <div className="search narrow">
            <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Sale number or label" />
          </div>
        </div>
      </div>
      <div className="chips">
        {STATUSES.map(([k, l]) => <button key={k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{l}</button>)}
      </div>
      <ErrorNote error={res.error} onRetry={res.reload} />
      {res.loading && !res.data ? <Loading /> : !rows.length ? <Empty>No sales for this day yet.</Empty> : (
        <div className="card flush">
          <table>
            <thead><tr><th>Sale</th><th>Time</th><th>Items</th><th>Payment</th><th>Status</th><th className="r">Total</th></tr></thead>
            <tbody>
              {rows.map(s => (
                <Fragment key={s.id}>
                  <tr className="click" onClick={() => setOpen(open === s.id ? null : s.id)}>
                    <td>#{s.number}{s.label && <em className="row-label">{s.label}</em>}</td>
                    <td>{q ? dateOf(s.createdAt) + ' ' : ''}{timeOf(s.paidAt ?? s.createdAt)}</td>
                    <td><div className="mini-bottles">{s.lines.slice(0, 4).map(l => <Bottle key={l.id} tint={tintFor(guessCategory(l.name))} />)}</div></td>
                    <td>
                      {s.payments.map(p => <span key={p.id} className={'pm ' + p.method.toLowerCase()}>{p.method === 'CASH' ? 'Cash' : 'M-Pesa'}</span>)}
                      {!s.payments.length && <span className="muted">-</span>}
                    </td>
                    <td><span className={'tag ' + s.status.toLowerCase()}>{statusLabel(s.status)}</span></td>
                    <td className="r"><b>{ksh(s.totalCents)}</b></td>
                  </tr>
                  {open === s.id && (
                    <tr className="expand">
                      <td colSpan={6}>
                        <div className="expand-in">
                          <div>{s.lines.map(l => <div key={l.id}>{l.qty} x {l.name} <span className="muted">{ksh(l.lineCents)}</span></div>)}</div>
                          <div>
                            {s.payments.map(p => (
                              <div key={p.id} className="muted">
                                {p.method === 'CASH' ? 'Cash' : `M-Pesa ${p.mpesaRef}`}: {ksh(p.amountCents)}
                                {p.method === 'MPESA' && <span className={'verif ' + p.verification.toLowerCase()}>{verificationLabel(p.verification)}</span>}
                              </div>
                            ))}
                            {s.discountCents > 0 && <div className="muted">Discount {ksh(s.discountCents)}</div>}
                            {s.dueCents > 0 && s.status === 'SAVED' && <div className="muted">Still due {ksh(s.dueCents)}</div>}
                          </div>
                          <div className="expand-act">
                            {(s.status === 'PAID' || s.status === 'REFUNDED') && <button className="mini" onClick={() => setReceipt(s.id)}>Reprint receipt</button>}
                            {s.status === 'PAID' && <button className="mini" onClick={() => setRefundFor(s)}>Request refund</button>}
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
      )}
      {receipt && <ReceiptLoader saleId={receipt} copy onClose={() => setReceipt(null)} />}
      {refundFor && (
        <ReasonModal title={`Refund sale #${refundFor.number}`} eyebrow={ksh(refundFor.totalCents) + ' · needs a manager'} onClose={() => setRefundFor(null)} busy={busy} onSubmit={refund}>
          <Field label="Money goes back by">
            <div className="seg two">
              <button className={method === 'CASH' ? 'on' : ''} onClick={() => setMethod('CASH')}>Cash from the till</button>
              <button className={method === 'MPESA' ? 'on' : ''} onClick={() => setMethod('MPESA')}>M-Pesa</button>
            </div>
          </Field>
          {method === 'MPESA' && <p className="muted small">M-Pesa refunds are sent from the M-Pesa portal. This records it.</p>}
        </ReasonModal>
      )}
    </div>
  )
}

export const verificationLabel = v => ({ STK_CONFIRMED: 'confirmed', MANUAL_UNVERIFIED: 'typed, not checked', MANUAL_VERIFIED: 'typed, checked', MANUAL_REJECTED: 'typed, rejected' })[v] ?? ''

// Sale lines only carry the name; the bottle colour is a nice to have.
function guessCategory(name) {
  const n = name.toLowerCase()
  if (/lager|stout|guinness|tusker|cap|beer/.test(n)) return 'beer'
  if (/gin/.test(n)) return 'gin'
  if (/vodka|smirnoff|chrome/.test(n)) return 'vodka'
  if (/wine|cabernet|cousins|merlot/.test(n)) return 'wine'
  if (/rum|cane|morgan/.test(n)) return 'rum'
  if (/cognac|hennessy/.test(n)) return 'cognac'
  return 'whisky'
}
