import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { money } from '../format.js'
import { Link, navigate, useQuery, useTitle } from '../router.js'
import { Chips, Empty, ErrorState, Icon, PageHeader, Pagination, Skeleton, StatusPill, When, useLoad } from '../ui.jsx'

const LIMIT = 30
const STATUSES = [['', 'All'], ['OPEN', 'Open'], ['OVERDUE', 'Overdue'], ['PAID', 'Paid'], ['VOID', 'Void']]

export const invoiceStatus = i => (i.status === 'OPEN' && i.overdue ? 'OVERDUE' : i.status === 'OPEN' && i.paidCents > 0 ? 'PARTLY_PAID' : i.status)

export function InvoiceTable({ rows, showClient = true }) {
  return (
    <div className="cx-table-wrap">
      <table className="cx-table cx-table-cards">
        <thead>
          <tr>
            <th>Number</th>
            {showClient && <th>Client</th>}
            <th>Period</th>
            <th className="cx-r">Issued</th>
            <th className="cx-r">Due</th>
            <th className="cx-r">Total</th>
            <th className="cx-r">Balance</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(i => (
            <tr key={i.id} className="cx-row-link" onClick={e => { if (!e.target.closest('a')) navigate(`/invoices/${i.id}`) }}>
              <td className="cx-card-title"><Link to={`/invoices/${i.id}`} className="cx-strong-link cx-num">{i.number}</Link></td>
              {showClient && <td data-label="Client">{i.business?.name}</td>}
              <td data-label="Period" className="cx-nowrap"><When at={i.periodStart} /> to <When at={i.periodEnd} /></td>
              <td data-label="Issued" className="cx-r"><When at={i.issuedAt} /></td>
              <td data-label="Due" className={'cx-r' + (i.overdue && i.status === 'OPEN' ? ' cx-text-red' : '')}><When at={i.dueAt} /></td>
              <td data-label="Total" className="cx-r cx-num">{money(i.totalCents)}</td>
              <td data-label="Balance" className="cx-r cx-num">{i.status === 'VOID' ? <span className="cx-muted">-</span> : money(i.balanceCents)}</td>
              <td data-label="Status"><StatusPill status={invoiceStatus(i)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function Invoices() {
  useTitle('Invoices')
  const [query, setQuery] = useQuery()
  const page = Math.max(1, Number(query.page) || 1)
  const [text, setText] = useState(query.q ?? '')
  useEffect(() => {
    const t = setTimeout(() => { if ((query.q ?? '') !== text) setQuery({ q: text }, { replace: true }) }, 300)
    return () => clearTimeout(t)
  }, [text])

  const filters = { status: query.status, q: query.q, from: query.from, to: query.to }
  const res = useLoad(signal => api.listInvoices({ ...filters, limit: LIMIT, offset: (page - 1) * LIMIT }, { signal }), [query.status, query.q, query.from, query.to, page])
  const totals = res.data?.totals

  return (
    <>
      <PageHeader title="Invoices" actions={<a className="cx-btn cx-btn-secondary" href={api.invoicesCsvUrl(filters)} download><Icon name="download" size={16} /><span>Export CSV</span></a>} />
      <div className="cx-toolbar">
        <Chips label="Status" value={query.status ?? ''} onChange={v => setQuery({ status: v })} items={STATUSES} />
        <div className="cx-toolbar-right">
          <label className="cx-inline-field"><span>From</span><input type="date" className="cx-input" value={query.from ?? ''} onChange={e => setQuery({ from: e.target.value })} /></label>
          <label className="cx-inline-field"><span>To</span><input type="date" className="cx-input" value={query.to ?? ''} onChange={e => setQuery({ to: e.target.value })} /></label>
          <input className="cx-input cx-search" type="search" placeholder="Number or client" aria-label="Search invoices" value={text} onChange={e => setText(e.target.value)} />
        </div>
      </div>

      {totals && (
        <div className="cx-totals" aria-label="Totals for these filters">
          <div><span>Billed</span><b className="cx-num">{money(totals.billedCents)}</b></div>
          <div><span>Collected</span><b className="cx-num">{money(totals.collectedCents)}</b></div>
          <div><span>Outstanding</span><b className={'cx-num' + (totals.outstandingCents ? ' cx-text-brass' : '')}>{money(totals.outstandingCents)}</b></div>
        </div>
      )}

      {res.error && !res.data ? <ErrorState error={res.error} onRetry={res.reload} /> : !res.data ? <Skeleton rows={8} cols={6} /> : !res.data.invoices.length ? (
        <Empty title="No invoices match">{query.status || query.q || query.from || query.to ? 'Try other filters.' : 'Invoices appear here once billing runs.'}</Empty>
      ) : (
        <div className={res.loading ? 'is-loading' : ''}>
          <InvoiceTable rows={res.data.invoices} />
          <Pagination total={res.data.total} limit={LIMIT} page={page} onPage={p => setQuery({ page: p })} />
        </div>
      )}
    </>
  )
}
