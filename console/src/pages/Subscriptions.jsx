import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { count, money, percent, whyNot } from '../format.js'
import { Link, navigate, useQuery, useTitle } from '../router.js'
import { useSession } from '../session.js'
import { Button, Chips, Dialog, Empty, ErrorState, PageHeader, Pagination, Skeleton, StatusPill, When, useAction, useLoad } from '../ui.jsx'

const LIMIT = 30
const STATUSES = [['', 'All'], ['ACTIVE', 'Active'], ['TRIALING', 'Trialing'], ['PAST_DUE', 'Past due'], ['SUSPENDED', 'Suspended'], ['CANCELLED', 'Cancelled']]

export default function Subscriptions() {
  useTitle('Subscriptions')
  const { can } = useSession()
  const [query, setQuery] = useQuery()
  const page = Math.max(1, Number(query.page) || 1)
  const [text, setText] = useState(query.q ?? '')
  const [billing, setBilling] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => { if ((query.q ?? '') !== text) setQuery({ q: text }, { replace: true }) }, 300)
    return () => clearTimeout(t)
  }, [text])

  const plans = useLoad(signal => api.listPlans(true, { signal }), [])
  const res = useLoad(signal => api.listSubscriptions({ status: query.status, planId: query.plan, q: query.q, limit: LIMIT, offset: (page - 1) * LIMIT }, { signal }), [query.status, query.plan, query.q, page])
  const rows = res.data?.subscriptions ?? []

  return (
    <>
      <PageHeader
        title="Subscriptions"
        actions={<Button onClick={() => setBilling(true)} disabled={!can('billing.run')} title={can('billing.run') ? undefined : whyNot('billing.run')}>Run billing</Button>}
      />
      <div className="cx-toolbar">
        <Chips label="Status" value={query.status ?? ''} onChange={v => setQuery({ status: v })} items={STATUSES} />
        <div className="cx-toolbar-right">
          <select className="cx-select" aria-label="Plan" value={query.plan ?? ''} onChange={e => setQuery({ plan: e.target.value })}>
            <option value="">All plans</option>
            {(plans.data?.plans ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input className="cx-input cx-search" type="search" placeholder="Client name" aria-label="Search subscriptions" value={text} onChange={e => setText(e.target.value)} />
        </div>
      </div>
      {res.error && !res.data ? <ErrorState error={res.error} onRetry={res.reload} /> : !res.data ? <Skeleton rows={8} cols={6} /> : !rows.length ? (
        <Empty title="No subscriptions match">Try other filters.</Empty>
      ) : (
        <div className={'cx-table-wrap' + (res.loading ? ' is-loading' : '')}>
          <table className="cx-table cx-table-cards">
            <thead>
              <tr><th>Client</th><th>Plan</th><th>Status</th><th className="cx-r">Period ends</th><th className="cx-r">Next amount</th><th className="cx-r">Terms</th></tr>
            </thead>
            <tbody>
              {rows.map(s => (
                <tr key={s.id} className="cx-row-link" onClick={e => { if (!e.target.closest('a')) navigate(`/clients/${s.businessId}?tab=subscription`) }}>
                  <td className="cx-card-title"><Link to={`/clients/${s.businessId}?tab=subscription`} className="cx-strong-link">{s.businessName}</Link></td>
                  <td data-label="Plan">{s.plan.name}</td>
                  <td data-label="Status">
                    <StatusPill status={s.status} />
                    {s.cancelAtPeriodEnd && s.status !== 'CANCELLED' ? <small className="cx-muted cx-after"> ending</small> : null}
                  </td>
                  <td data-label="Period ends" className="cx-r"><When at={s.status === 'TRIALING' ? s.trialEndsAt : s.currentPeriodEnd} /></td>
                  <td data-label="Next amount" className="cx-r cx-num">{s.nextAmountCents == null ? <span className="cx-muted">-</span> : money(s.nextAmountCents)}</td>
                  <td data-label="Terms" className="cx-r">
                    {s.customPriceCents != null ? <span className="cx-tag">Agreed price</span> : null}
                    {s.discountBps ? <span className="cx-tag cx-num">{percent(s.discountBps)} off</span> : null}
                    {s.customPriceCents == null && !s.discountBps ? <span className="cx-muted">Standard</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination total={res.data.total} limit={LIMIT} page={page} onPage={p => setQuery({ page: p })} />
        </div>
      )}
      {billing && <BillingDialog onClose={() => setBilling(false)} onDone={() => res.reload()} />}
    </>
  )
}

const ACTION_TEXT = {
  convert_trial: 'Trial ends, becomes paying',
  advance_period: 'Starts a new period',
  invoice: 'Invoice',
  cancel: 'Cancelled at period end',
  past_due: 'Marked past due',
  suspend: 'Suspended for non payment'
}

function BillingDialog({ onClose, onDone }) {
  const preview = useLoad(signal => api.billingPreview({ signal }), [])
  const [run, busy, error] = useAction()
  const [summary, setSummary] = useState(null)
  const p = preview.data?.preview
  const go = async () => {
    const r = await run(() => api.runBilling())
    if (r) { setSummary(r.summary); onDone() }
  }

  if (summary) {
    return (
      <Dialog title="Billing run finished" onClose={onClose} size="sm" footer={<Button kind="primary" onClick={onClose}>Done</Button>}>
        <dl className="cx-dl">
          <div><dt>Invoices raised</dt><dd className="cx-num">{count(summary.invoicesCreated)}</dd></div>
          <div><dt>Trials converted</dt><dd className="cx-num">{count(summary.trialsConverted)}</dd></div>
          <div><dt>Marked past due</dt><dd className="cx-num">{count(summary.markedPastDue)}</dd></div>
          <div><dt>Suspended</dt><dd className="cx-num">{count(summary.suspended)}</dd></div>
          <div><dt>Cancelled</dt><dd className="cx-num">{count(summary.cancelled)}</dd></div>
        </dl>
        {summary.errors?.length ? (
          <div className="cx-banner cx-banner-red" role="alert">
            <div>
              <p>{summary.errors.length} client{summary.errors.length === 1 ? '' : 's'} could not be billed:</p>
              <ul>{summary.errors.map(e => <li key={e.businessId}><Link to={`/clients/${e.businessId}`} className="cx-link">{e.businessId}</Link>: {e.message}</li>)}</ul>
            </div>
          </div>
        ) : null}
      </Dialog>
    )
  }

  return (
    <Dialog
      title="Run billing now"
      subtitle="Billing also runs by itself every hour. Running it twice never bills anyone twice."
      onClose={onClose}
      busy={busy}
      size="lg"
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button kind="primary" busy={busy} disabled={!p} onClick={go}>{p && !p.items.length ? 'Run anyway' : 'Run billing'}</Button></>}
    >
      {preview.error ? <ErrorState error={preview.error} onRetry={preview.reload} /> : !p ? <Skeleton rows={4} cols={3} /> : !p.items.length ? (
        <p className="cx-muted">Nothing is due right now. Every client is up to date.</p>
      ) : (
        <>
          <p>{p.items.length} client{p.items.length === 1 ? '' : 's'} will change. New invoices total <b className="cx-num">{money(p.totals.invoiceTotalCents)}</b>.</p>
          <div className="cx-table-wrap">
            <table className="cx-table cx-table-cards">
              <thead><tr><th>Client</th><th>What happens</th><th className="cx-r">Amount</th></tr></thead>
              <tbody>
                {p.items.map(it => (
                  <tr key={it.businessId}>
                    <td className="cx-card-title">{it.businessName}<small className="cx-muted cx-block">{it.plan?.name}</small></td>
                    <td data-label="What happens">{it.actions.map((a, i) => <div key={i}>{ACTION_TEXT[a.type] ?? a.type}{a.invoiceNumber ? ` (${a.invoiceNumber})` : ''}</div>)}</td>
                    <td data-label="Amount" className="cx-r cx-num">{money(it.actions.filter(a => a.type === 'invoice').reduce((s, a) => s + a.totalCents, 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {error && <p className="cx-form-error" role="alert">{error.message}</p>}
    </Dialog>
  )
}
