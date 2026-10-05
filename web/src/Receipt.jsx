import { useEffect, useRef, useState } from 'react'
import JsBarcode from 'jsbarcode'

// Receipt view and printing.
//
// Takes a normalised receipt object (amounts in cents), so it works the same
// for the demo data and for GET /api/sales/:id/receipt:
// {
//   business: { name, address?, phone?, kraPin? }, branch: { name },
//   number, status: 'PAID' | 'REFUNDED', paidAt, refundedAt?, servedBy, label?, customer?,
//   lines: [{ name, qty, unitCents }], subtotalCents, discountCents, totalCents,
//   payments: [{ method: 'CASH' | 'MPESA', amountCents, tenderedCents?, mpesaRef?, phone?, verification? }],
//   copy?: boolean
// }

const VAT_RATE = 0.16

const money = c => (Math.round(c) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const when = t =>
  new Date(t).toLocaleString('en-KE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' })

// 254712345678 -> 0712 *** 678
export function maskPhone(p) {
  if (!p) return ''
  const local = p.startsWith('254') ? '0' + p.slice(3) : p
  return local.slice(0, 4) + ' *** ' + local.slice(-3)
}

// Printed on the receipt and read back by the till scanner to open the sale.
export const receiptCode = number => 'BP' + String(number).padStart(6, '0')
export const parseReceiptCode = code => (/^BP\d{6}$/.test(code) ? Number(code.slice(2)) : null)

function Barcode({ value }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current) return
    JsBarcode(ref.current, value, {
      format: 'CODE128',
      displayValue: false,
      margin: 0,
      height: 38,
      width: 1.6,
      background: 'transparent',
      lineColor: '#111'
    })
  }, [value])
  return <svg ref={ref} className="rc-barcode" aria-label={'Receipt code ' + value} />
}

export function ReceiptPaper({ r }) {
  const refund = r.status === 'REFUNDED'
  const vat = Math.round(r.totalCents - r.totalCents / (1 + VAT_RATE))
  const items = r.lines.reduce((a, l) => a + l.qty, 0)
  const cashChange = r.payments.filter(p => p.method === 'CASH').reduce((a, p) => a + ((p.tenderedCents ?? p.amountCents) - p.amountCents), 0)

  return (
    <article className={'rc' + (refund ? ' is-refund' : '')}>
      <header className="rc-head">
        <img src="/brand/bottle-point-lockup-light.png" alt={r.business.name} className="rc-logo" />
        <div className="rc-biz">
          <b>{r.business.name}</b>
          <span>{r.branch.name} branch</span>
          {r.business.address && <span>{r.business.address}</span>}
          {r.business.phone && <span>Tel {r.business.phone}</span>}
          {r.business.kraPin && <span>KRA PIN {r.business.kraPin}</span>}
        </div>
      </header>

      <div className="rc-title">
        <span>{refund ? 'Refund' : 'Sales receipt'}</span>
        {r.copy && <em>Copy</em>}
      </div>

      <dl className="rc-meta">
        <div><dt>Receipt</dt><dd>#{r.number}</dd></div>
        <div><dt>Date</dt><dd>{when(refund && r.refundedAt ? r.refundedAt : r.paidAt)}</dd></div>
        <div><dt>Served by</dt><dd>{r.servedBy}</dd></div>
        {r.customer && <div><dt>Customer</dt><dd>{r.customer}</dd></div>}
        {r.label && !r.customer && <div><dt>For</dt><dd>{r.label}</dd></div>}
      </dl>

      <table className="rc-items">
        <tbody>
          {r.lines.map((l, i) => (
            <tr key={i}>
              <td>
                <span className="rc-name">{l.name}</span>
                <span className="rc-qty">{l.qty} x {money(l.unitCents)}</span>
              </td>
              <td className="rc-amt">{money(l.qty * l.unitCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="rc-sums">
        <div><span>{items} item{items === 1 ? '' : 's'}</span><span>{money(r.subtotalCents)}</span></div>
        {r.discountCents > 0 && <div><span>Discount</span><span>-{money(r.discountCents)}</span></div>}
        <div className="rc-total"><span>{refund ? 'Refunded' : 'Total'}</span><span><small>KSh</small>{money(r.totalCents)}</span></div>
        <div className="rc-vat"><span>Includes VAT 16%</span><span>{money(vat)}</span></div>
      </div>

      <div className="rc-pay">
        {refund && <div className="rc-note">Originally paid by</div>}
        {r.payments.map((p, i) =>
          p.method === 'CASH' ? (
            <div key={i}>
              <div className="rc-row"><span>Cash</span><span>{money(refund ? p.amountCents : (p.tenderedCents ?? p.amountCents))}</span></div>
            </div>
          ) : (
            <div key={i}>
              <div className="rc-row"><span>M-Pesa</span><span>{money(p.amountCents)}</span></div>
              <div className="rc-sub">
                <span className="rc-code">{p.mpesaRef}</span>
                {p.phone && <span>{maskPhone(p.phone)}</span>}
                <span>{p.verification === 'STK_CONFIRMED' ? 'Confirmed by M-Pesa' : 'Code entered at till'}</span>
              </div>
            </div>
          )
        )}
        {!refund && cashChange > 0 && <div className="rc-row rc-change"><span>Change</span><span>{money(cashChange)}</span></div>}
      </div>

      <footer className="rc-foot">
        <Barcode value={receiptCode(r.number)} />
        <span className="rc-ref">{receiptCode(r.number)}</span>
        <p className="rc-thanks">{refund ? 'Refund processed. Keep this slip.' : 'Thank you, karibu tena.'}</p>
        <p className="rc-law">Not for sale to persons under the age of 18. Drink responsibly.</p>
        {!refund && <p className="rc-law">Goods once sold are not returnable without this receipt.</p>}
      </footer>
    </article>
  )
}

function readWidth() {
  try {
    return localStorage.getItem('bp-paper') === '58' ? '58' : '80'
  } catch {
    return '80'
  }
}

// Modal with the receipt on screen plus print controls.
export default function ReceiptModal({ receipt, onClose, onNewSale, autoPrint = false }) {
  const [width, setWidth] = useState(readWidth)
  const printed = useRef(false)

  const pickWidth = w => {
    setWidth(w)
    try { localStorage.setItem('bp-paper', w) } catch {}
  }

  const print = () => {
    document.documentElement.dataset.paper = width
    window.print()
  }

  useEffect(() => {
    if (autoPrint && !printed.current) {
      printed.current = true
      setTimeout(print, 250)
    }
    const onKey = e => {
      if (e.key === 'Escape') onClose()
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        print()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="scrim rc-scrim" onClick={onClose}>
      <div className="rc-shell" onClick={e => e.stopPropagation()}>
        <div className={'rc-stage w' + width}>
          <div className="rc-print-root">
            <ReceiptPaper r={receipt} />
          </div>
        </div>
        <aside className="rc-panel">
          <div>
            <small className="eyebrow">{receipt.status === 'REFUNDED' ? 'Refund' : 'Paid'}</small>
            <h3 className="title-serif sm">Receipt #{receipt.number}</h3>
          </div>
          <div className="rc-paid">
            <span>{receipt.status === 'REFUNDED' ? 'Refunded' : 'Received'}</span>
            <b>KSh {money(receipt.totalCents)}</b>
          </div>
          <div className="field">
            <span>Paper width</span>
            <div className="seg two">
              <button className={width === '80' ? 'on' : ''} onClick={() => pickWidth('80')}>80 mm</button>
              <button className={width === '58' ? 'on' : ''} onClick={() => pickWidth('58')}>58 mm</button>
            </div>
          </div>
          <button className="gold wide" onClick={print}>Print receipt</button>
          {onNewSale && <button className="outline wide" onClick={onNewSale}>Start next sale</button>}
          <button className="ghost" onClick={onClose}>Close</button>
          <p className="muted small">Ctrl P prints. Scan the barcode at any till in this branch to open the sale again.</p>
        </aside>
      </div>
    </div>
  )
}

// GET /api/sales/:id/receipt into the shape the receipt draws.
export function fromApiReceipt(r, copy = false) {
  return {
    business: { name: r.businessName },
    branch: { name: r.branchName },
    number: r.number,
    status: r.status,
    paidAt: r.paidAt,
    refundedAt: r.refundedAt,
    servedBy: r.paidBy?.name ?? r.createdBy?.name ?? '',
    label: r.label,
    customer: r.customer?.name ?? null,
    lines: r.lines.map(l => ({ name: l.name, qty: l.qty, unitCents: l.unitCents })),
    subtotalCents: r.subtotalCents,
    discountCents: r.discountCents,
    totalCents: r.totalCents,
    payments: r.payments.map(p => ({
      method: p.method,
      amountCents: p.amountCents,
      tenderedCents: p.tenderedCents,
      mpesaRef: p.mpesaRef,
      phone: p.phone,
      verification: p.verification
    })),
    copy
  }
}
