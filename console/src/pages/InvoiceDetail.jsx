import { useState } from 'react'
import { api } from '../api.js'
import { date, fromCents, methodLabel, money, toCents, whyNot } from '../format.js'
import { Link, useTitle } from '../router.js'
import { useSession } from '../session.js'
import { Button, Card, ConfirmDialog, Dialog, Empty, ErrorState, Field, Icon, Skeleton, StatusPill, When, useAction, useLoad } from '../ui.jsx'
import { LinesTable } from './ClientDetail.jsx'
import { invoiceStatus } from './Invoices.jsx'

const METHODS = ['MPESA', 'BANK', 'CARD', 'CASH', 'OTHER']
const todayLocal = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10)

export default function InvoiceDetail({ id }) {
  const res = useLoad(signal => api.getInvoice(id, { signal }), [id])
  const inv = res.data?.invoice
  useTitle(inv?.number ?? 'Invoice')
  const { can } = useSession()
  const [dialog, setDialog] = useState(null)

  if (res.error && !inv) {
    return (
      <>
        <Link to="/invoices" className="cx-back"><Icon name="back" size={16} />Invoices</Link>
        {res.error.status === 404 ? <Empty title="Invoice not found" /> : <ErrorState error={res.error} onRetry={res.reload} />}
      </>
    )
  }
  if (!inv) return <><Link to="/invoices" className="cx-back"><Icon name="back" size={16} />Invoices</Link><Skeleton rows={10} cols={3} /></>

  const open = inv.status === 'OPEN'
  const done = () => { setDialog(null); res.reload() }
  const c = inv.client

  return (
    <>
      <Link to="/invoices" className="cx-back cx-no-print"><Icon name="back" size={16} />Invoices</Link>
      <div className="cx-invoice-layout">
        <article className="cx-paper" aria-label={`Invoice ${inv.number}`}>
          <header className="cx-paper-head">
            <div>
              <img src="/brand/bottle-point-lockup-light.png" alt="Bottle Point" className="cx-paper-logo" />
              <p className="cx-paper-from">Bottle Point<br />Nairobi, Kenya</p>
            </div>
            <div className="cx-paper-title">
              <h1>{inv.status === 'VOID' ? 'Void invoice' : 'Invoice'}</h1>
              <p className="cx-num">{inv.number}</p>
            </div>
          </header>
          <div className="cx-paper-parties">
            <div>
              <h2>Billed to</h2>
              <p><b>{c.legalName ?? c.name}</b>{c.legalName && c.legalName !== c.name ? <><br />Trading as {c.name}</> : null}</p>
              {c.address && <p>{c.address}</p>}
              {c.kraPin && <p>KRA PIN <span className="cx-num">{c.kraPin}</span></p>}
              {c.email && <p>{c.email}</p>}
              {c.phone && <p className="cx-num">{c.phone}</p>}
            </div>
            <dl>
              <div><dt>Issued</dt><dd>{date(inv.issuedAt)}</dd></div>
              <div><dt>Due</dt><dd>{date(inv.dueAt)}</dd></div>
              <div><dt>Period</dt><dd>{date(inv.periodStart)} to {date(inv.periodEnd)}</dd></div>
              <div><dt>Status</dt><dd><StatusPill status={invoiceStatus(inv)} /></dd></div>
            </dl>
          </div>
          <LinesTable lines={inv.lines} subtotalCents={inv.subtotalCents} taxCents={inv.taxCents} totalCents={inv.totalCents} />
          <div className="cx-paper-balance">
            <div><span>Paid</span><b className="cx-num">{money(inv.paidCents)}</b></div>
            <div className="cx-paper-due"><span>Balance due</span><b className="cx-num">{money(inv.status === 'VOID' ? 0 : inv.balanceCents)}</b></div>
          </div>
          {inv.notes && <p className="cx-paper-notes">{inv.notes}</p>}
          <footer className="cx-paper-foot">Prices in Kenya shillings. VAT at 16% where shown.</footer>
        </article>

        <aside className="cx-invoice-side cx-no-print">
          <Card title="Actions">
            <div className="cx-side-actions">
              <Button kind="primary" onClick={() => setDialog('pay')} disabled={!open || !can('payments.write')} title={!can('payments.write') ? whyNot('payments.write') : open ? undefined : 'Only open invoices take payments'}>Record payment</Button>
              <Button icon="print" onClick={() => window.print()}>Print or save as PDF</Button>
              <Link to={`/clients/${c.id}`} className="cx-btn cx-btn-secondary">Open client</Link>
              {open && inv.paidCents === 0 && (
                <Button kind="danger-quiet" onClick={() => setDialog('void')} disabled={!can('invoices.write')} title={can('invoices.write') ? undefined : whyNot('invoices.write')}>Void invoice</Button>
              )}
            </div>
          </Card>
          <Card title="Payments">
            {inv.payments.length ? (
              <ul className="cx-list">
                {inv.payments.map(p => (
                  <li key={p.id} className="cx-list-row">
                    <span className="cx-list-main">
                      <b className="cx-num">{money(p.amountCents)}</b>
                      <small className="cx-muted">{methodLabel(p.method)}{p.reference ? ` · ${p.reference}` : ''}</small>
                      <small className="cx-muted"><When at={p.receivedAt} />{p.recordedBy ? `, recorded by ${p.recordedBy.name}` : ''}</small>
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p className="cx-muted cx-pad">No payments yet.</p>}
          </Card>
        </aside>
      </div>
      {dialog === 'pay' && <PaymentDialog inv={inv} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'void' && <VoidDialog inv={inv} onClose={() => setDialog(null)} onDone={done} />}
    </>
  )
}

function PaymentDialog({ inv, onClose, onDone }) {
  const [amount, setAmount] = useState(fromCents(inv.balanceCents))
  const [method, setMethod] = useState('MPESA')
  const [reference, setReference] = useState('')
  const [received, setReceived] = useState(todayLocal())
  const [run, busy, error] = useAction()
  const cents = toCents(amount)
  const tooMuch = cents != null && cents > inv.balanceCents
  const valid = cents != null && cents > 0 && !tooMuch && received && received <= todayLocal()
  const go = async () => {
    if (!valid) return
    const body = { amountCents: cents, method, ...(reference.trim() ? { reference: reference.trim() } : {}), receivedAt: new Date(received + 'T12:00:00+03:00').toISOString() }
    const r = await run(() => api.recordPayment(inv.id, body), cents === inv.balanceCents ? 'Paid in full' : 'Payment recorded')
    if (r) onDone()
  }
  return (
    <Dialog title="Record payment" subtitle={`${inv.number}, balance ${money(inv.balanceCents)}`} onClose={onClose} busy={busy} size="sm"
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button kind="primary" busy={busy} disabled={!valid} onClick={go}>Record {cents ? money(cents) : 'payment'}</Button></>}>
      <Field label="Amount (KSh)" error={amount && cents == null ? 'Enter an amount in shillings' : tooMuch ? `More than the balance of ${money(inv.balanceCents)}` : null}>
        <input className="cx-input cx-num" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} autoFocus />
      </Field>
      <Field label="Method">
        <select className="cx-select" value={method} onChange={e => setMethod(e.target.value)}>
          {METHODS.map(m => <option key={m} value={m}>{methodLabel(m)}</option>)}
        </select>
      </Field>
      <Field label="Reference" hint={method === 'MPESA' ? 'The M-Pesa transaction code' : method === 'BANK' ? 'The bank reference' : 'Optional'}>
        <input className="cx-input cx-num" maxLength={100} value={reference} onChange={e => setReference(e.target.value.toUpperCase())} autoCapitalize="characters" />
      </Field>
      <Field label="Received on" error={received > todayLocal() ? 'Cannot be in the future' : null}>
        <input className="cx-input" type="date" max={todayLocal()} value={received} onChange={e => setReceived(e.target.value)} />
      </Field>
      {error && <p className="cx-form-error" role="alert">{error.message}</p>}
    </Dialog>
  )
}

function VoidDialog({ inv, onClose, onDone }) {
  const [reason, setReason] = useState('')
  const [run, busy, error] = useAction()
  const go = async () => { if (reason.trim() && (await run(() => api.voidInvoice(inv.id, reason.trim()), 'Invoice voided'))) onDone() }
  return (
    <ConfirmDialog title={`Void ${inv.number}?`} confirm="Void invoice" danger onConfirm={go} onClose={onClose} busy={busy} error={error}>
      <p>The invoice stays on record marked void and is no longer owed. This cannot be undone.</p>
      <Field label="Reason">
        <textarea className="cx-input" rows={2} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} />
      </Field>
    </ConfirmDialog>
  )
}
