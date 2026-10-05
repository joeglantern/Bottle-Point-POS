import { useRef, useState } from 'react'
import { api, qs } from '../api.js'
import { useApi, useLive, useSession } from '../session.jsx'
import { Empty, ErrorNote, Loading, Stat, ago, ksh, timeOf, todayNairobi, useAction } from '../ui.jsx'

export default function Today() {
  const { branchId, branch } = useSession()
  const [date, setDate] = useState(todayNairobi())
  const report = useApi('/reports/daily' + qs({ date }), [branchId])
  const r = report.data?.report

  // money moved somewhere: refresh the figures (lightly debounced)
  const timer = useRef(null)
  const refresh = () => { clearTimeout(timer.current); timer.current = setTimeout(() => report.reload(), 400) }
  useLive('sale:updated', p => p.sale.branchId === branchId && refresh())
  useLive('shift:updated', () => refresh())

  const topMax = r?.topProducts.byValue[0]?.valueCents || 1

  return (
    <div className="page">
      <div className="page-head row">
        <div>
          <h2>{date === todayNairobi() ? 'Today' : date} at {branch?.name}</h2>
          <p className="muted">{new Date(date + 'T12:00:00+03:00').toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        </div>
        <div className="filters">
          <input type="date" className="date-in" value={date} max={todayNairobi()} onChange={e => setDate(e.target.value)} />
        </div>
      </div>

      <Approvals />
      <TypedCodes />

      <ErrorNote error={report.error} onRetry={report.reload} />
      {!r ? <Loading /> : (
        <>
          <div className="stats">
            <Stat label="Takings" value={ksh(r.takings.totalCents)} note={`${r.paidSales.count} paid sales · avg ${ksh(r.paidSales.averageCents)}`} />
            <Stat label="Cash" value={ksh(r.takings.cashCents)} />
            <Stat label="M-Pesa" value={ksh(r.takings.mpesaCents)} />
            <Stat label="Unpaid (saved)" value={ksh(r.unpaid.dueCents ?? r.unpaid.valueCents)} note={`${r.unpaid.count} open`} />
          </div>

          <div className="stats small">
            <Stat label="Net after refunds" value={ksh(r.netCents)} />
            <Stat label="Refunds" value={ksh(r.refunds.valueCents)} note={`${r.refunds.count}`} tone={r.refunds.count ? 'warn' : ''} />
            <Stat label="Cancelled" value={ksh(r.cancellations.valueCents)} note={`${r.cancellations.count}`} />
            <Stat label="Discounts" value={ksh(r.discounts.valueCents)} note={`${r.discounts.count}`} />
          </div>

          {(r.stkUnlinked.count > 0 || r.mpesaUnverified.count > 0) && (
            <div className="card alert-card">
              <h4>Needs attention</h4>
              {r.mpesaUnverified.count > 0 && <div className="kv"><span>Typed M-Pesa codes not yet checked</span><b>{r.mpesaUnverified.count} {'·'} {ksh(r.mpesaUnverified.valueCents)}</b></div>}
              {r.stkUnlinked.count > 0 && (
                <>
                  <div className="kv"><span>M-Pesa received but not linked to a sale</span><b>{r.stkUnlinked.count} {'·'} {ksh(r.stkUnlinked.valueCents)}</b></div>
                  {r.stkUnlinked.requests.map(q => <div key={q.id} className="muted small">{q.receipt ?? 'no code'} {'·'} {ksh(q.amountCents)} {'·'} {q.resultDesc}</div>)}
                </>
              )}
            </div>
          )}

          <div className="two">
            <div className="card">
              <h4>Till counts</h4>
              {!r.shifts.length && <Empty>No shifts this day.</Empty>}
              {r.shifts.map(s => (
                <div key={s.id} className="shift-row">
                  <div>
                    <b>{s.userName}</b>
                    <small className="muted">{timeOf(s.openedAt)} to {s.closedAt ? timeOf(s.closedAt) : 'now'}</small>
                  </div>
                  <div className="r">
                    <small className="muted">Expected</small>
                    <b>{ksh(s.expectedCashCents)}</b>
                  </div>
                  <div className="r">
                    {s.closedAt ? (
                      <span className={'tag ' + (s.varianceCents === 0 ? 'ok' : 'cancelled')}>
                        {s.varianceCents === 0 ? 'Balanced' : s.varianceCents < 0 ? `Short ${ksh(-s.varianceCents)}` : `Over ${ksh(s.varianceCents)}`}
                      </span>
                    ) : <span className="tag saved">Open</span>}
                  </div>
                </div>
              ))}
            </div>

            <div className="card">
              <h4>Best sellers</h4>
              {!r.topProducts.byValue.length && <Empty>No sales yet.</Empty>}
              {r.topProducts.byValue.map(p => (
                <div key={p.productId} className="barrow">
                  <span>{p.name} <small className="muted">x{p.qty}</small></span>
                  <div className="track"><i style={{ width: (p.valueCents / topMax) * 100 + '%' }} /></div>
                  <b>{ksh(p.valueCents)}</b>
                </div>
              ))}
              <h4 className="mt">By cashier</h4>
              {r.cashiers.map(c => <div key={c.userId ?? 'x'} className="kv"><span>{c.name ?? 'Unknown'} <small className="muted">{c.count} sales</small></span><b>{ksh(c.valueCents)}</b></div>)}
            </div>
          </div>

          <div className="card">
            <h4>Unpaid sales</h4>
            <div className="buckets">
              <span>Under 1 hour <b>{r.unpaid.buckets.under1h.count}</b></span>
              <span>1 to 4 hours <b>{r.unpaid.buckets.from1to4h.count}</b></span>
              <span className={r.unpaid.buckets.over4h.count ? 'warn' : ''}>Over 4 hours <b>{r.unpaid.buckets.over4h.count}</b></span>
            </div>
            {r.unpaid.oldest.length > 0 && (
              <table>
                <thead><tr><th>Sale</th><th>Label</th><th>Opened by</th><th>Age</th><th className="r">Value</th></tr></thead>
                <tbody>
                  {r.unpaid.oldest.map(o => (
                    <tr key={o.id}><td>#{o.number}</td><td>{o.label || '-'}</td><td>{o.openedByName}</td><td>{ago(o.createdAt)}</td><td className="r">{ksh(o.totalCents)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}

const KIND = { CANCEL: 'Cancel', REFUND: 'Refund', DISCOUNT: 'Discount' }

function Approvals() {
  const { branchId, user } = useSession()
  const res = useApi('/approvals' + qs({ status: 'PENDING' }), [branchId])
  const [run, busy] = useAction()
  const list = (res.data?.approvals ?? []).filter(a => a.branchId === branchId)
  useLive('approval:updated', () => res.reload())

  const decide = (a, action) => run(async () => { await api.post(`/approvals/${a.id}/${action}`, {}); res.reload() }, action === 'approve' ? 'Approved' : 'Rejected')

  if (!list.length) return null
  return (
    <div className="card approvals">
      <h4>Waiting for you <span className="badge">{list.length}</span></h4>
      {list.map(a => (
        <div key={a.id} className="approval-row">
          <span className={'kind ' + a.kind.toLowerCase()}>{KIND[a.kind]}</span>
          <div className="a-main">
            <b>Sale #{a.saleNumber} {'·'} {ksh(a.kind === 'DISCOUNT' ? a.amountCents : a.saleTotalCents)}{a.kind === 'REFUND' ? ` by ${a.refundMethod === 'CASH' ? 'cash' : 'M-Pesa'}` : ''}</b>
            <small className="muted">{a.requestedByName}, {ago(a.createdAt)}: {a.reason}</small>
          </div>
          {a.requestedById === user.id && user.role !== 'OWNER' ? (
            <small className="muted">Your request, another manager decides</small>
          ) : (
            <div className="a-act">
              <button className="mini" disabled={busy} onClick={() => decide(a, 'reject')}>Reject</button>
              <button className="mini on" disabled={busy} onClick={() => decide(a, 'approve')}>Approve</button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function TypedCodes() {
  const { branchId } = useSession()
  const res = useApi('/mpesa/unverified', [branchId])
  const [run, busy] = useAction()
  const list = res.data?.payments ?? []
  useLive('sale:updated', p => p.sale.branchId === branchId && p.sale.payments.some(x => x.verification === 'MANUAL_UNVERIFIED') && res.reload())
  const verify = (p, ok) => run(async () => { await api.post(`/mpesa/payments/${p.id}/verify`, { ok }); res.reload() }, ok ? 'Marked as checked' : 'Marked as not found')

  if (!list.length) return null
  return (
    <div className="card approvals">
      <h4>Typed M-Pesa codes to check <span className="badge">{list.length}</span></h4>
      <p className="muted small">Find each code on the M-Pesa statement or portal before marking it checked.</p>
      {list.map(p => (
        <div key={p.id} className="approval-row">
          <span className="kind code">{p.mpesaRef}</span>
          <div className="a-main">
            <b>Sale #{p.saleNumber} {'·'} {ksh(p.amountCents)}</b>
            <small className="muted">Typed by {p.receivedByName}, {ago(p.createdAt)}</small>
          </div>
          <div className="a-act">
            <button className="mini" disabled={busy} onClick={() => verify(p, false)}>Not found</button>
            <button className="mini on" disabled={busy} onClick={() => verify(p, true)}>Found it</button>
          </div>
        </div>
      ))}
    </div>
  )
}
