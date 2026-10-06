import { api } from '../api.js'
import { count, money, percent, statusLabel } from '../format.js'
import { Link, useTitle } from '../router.js'
import { Card, ErrorState, MonthBars, PageHeader, Skeleton, Sparkline, StatusPill, When, useLoad } from '../ui.jsx'

const REASON = { past_due: 'Past due', suspended: 'Suspended', trial_ending: 'Trial ending' }

export default function Overview() {
  useTitle('Overview')
  const { data, error, loading, reload } = useLoad(signal => api.overview({ signal }), [])
  const o = data?.overview

  if (error && !o) return <><PageHeader title="Overview" /><ErrorState error={error} onRetry={reload} /></>
  if (!o) return <><PageHeader title="Overview" /><div className="cx-figures">{[0, 1, 2, 3].map(i => <div key={i} className="cx-figure is-loading" />)}</div><Skeleton rows={6} /></>

  const counts = o.counts ?? {}
  const live = (counts.ACTIVE ?? 0) + (counts.PAST_DUE ?? 0)
  const sales = (o.salesByMonth ?? []).map(r => r.salesCents)
  const salesTotal = sales.reduce((a, b) => a + b, 0)
  const mixTotal = Math.max(1, ...[(o.planMix ?? []).reduce((a, p) => a + p.mrrCents, 0)])

  return (
    <>
      <PageHeader title="Overview" eyebrow={loading ? 'Refreshing' : null} />

      <div className="cx-figures">
        <div className="cx-figure">
          <span className="cx-figure-label">Monthly recurring revenue</span>
          <b className="cx-num">{money(o.mrrCents)}</b>
          <span className="cx-muted">ARR {money(o.arrCents)}</span>
        </div>
        <div className="cx-figure">
          <span className="cx-figure-label">Paying clients</span>
          <b className="cx-num">{count(live)}</b>
          <span className="cx-muted">{count(counts.TRIALING ?? 0)} on trial, {count(o.newClientsThisMonth)} new this month</span>
        </div>
        <div className="cx-figure">
          <span className="cx-figure-label">Outstanding</span>
          <b className="cx-num">{money(o.outstandingCents)}</b>
          <span className={o.overdueCount ? 'cx-text-red' : 'cx-muted'}>{o.overdueCount ? `${money(o.overdueCents)} overdue on ${count(o.overdueCount)} invoice${o.overdueCount === 1 ? '' : 's'}` : `${count(o.outstandingCount)} open, none overdue`}</span>
        </div>
        <div className="cx-figure">
          <span className="cx-figure-label">Collected this month</span>
          <b className="cx-num">{money(o.collectedThisMonthCents)}</b>
          <span className="cx-muted">{count(o.churnedThisMonth)} cancelled this month</span>
        </div>
      </div>

      <div className="cx-grid-2">
        <div className="cx-stack">
          <Card title="Revenue, last 12 months">
            <MonthBars
              label="Invoiced and collected per month"
              rows={o.revenueByMonth ?? []}
              series={[
                { key: 'invoicedCents', label: 'Invoiced', tone: 'quiet' },
                { key: 'collectedCents', label: 'Collected', tone: 'brass' }
              ]}
            />
          </Card>
          <Card title="Sales through client tills" actions={<span className="cx-num cx-muted">{money(salesTotal)} in 12 months</span>}>
            <Sparkline values={sales.length ? sales : [0, 0]} />
          </Card>
          <Card title="Plans" flush>
            <table className="cx-table">
              <thead><tr><th>Plan</th><th className="cx-r">Clients</th><th className="cx-r">MRR</th><th className="cx-hide-sm">Share</th></tr></thead>
              <tbody>
                {(o.planMix ?? []).map(p => (
                  <tr key={p.planId}>
                    <td data-label="Plan">{p.name}</td>
                    <td data-label="Clients" className="cx-r cx-num">{count(p.clients)}</td>
                    <td data-label="MRR" className="cx-r cx-num">{money(p.mrrCents)}</td>
                    <td className="cx-hide-sm"><div className="cx-share"><i style={{ width: `${(p.mrrCents / mixTotal) * 100}%` }} /><span className="cx-num">{percent(Math.round((p.mrrCents / mixTotal) * 10000))}</span></div></td>
                  </tr>
                ))}
                {!o.planMix?.length && <tr><td colSpan={4} className="cx-muted">No clients on a plan yet.</td></tr>}
              </tbody>
            </table>
          </Card>
        </div>

        <div className="cx-stack">
          <Card title="Needs attention" actions={<span className="cx-num cx-muted">{o.attention?.length ?? 0}</span>}>
            {o.attention?.length ? (
              <ul className="cx-list">
                {o.attention.map(a => (
                  <li key={a.kind + a.businessId}>
                    <Link to={`/clients/${a.businessId}`} className="cx-list-link">
                      <span className="cx-list-main">
                        <b>{a.name}</b>
                        <small className="cx-muted">{a.reason}</small>
                      </span>
                      <span className="cx-list-side">
                        <StatusPill status={a.status} label={REASON[a.kind] ?? statusLabel(a.status)} />
                        {a.amountCents ? <span className="cx-num cx-muted">{money(a.amountCents)}</span> : null}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <p className="cx-muted cx-pad">Nothing needs attention. Every client is paid up.</p>}
          </Card>

          <Card title="Recent activity" actions={<Link to="/audit" className="cx-link">Audit log</Link>}>
            {o.recentActivity?.length ? (
              <ul className="cx-feed">
                {o.recentActivity.map(r => (
                  <li key={r.id}>
                    <p>{r.summary}</p>
                    <small className="cx-muted"><When at={r.at} mode="relative" />{r.actor?.name ? ` · ${r.actor.name}` : ''}</small>
                  </li>
                ))}
              </ul>
            ) : <p className="cx-muted cx-pad">No activity yet.</p>}
          </Card>
        </div>
      </div>
    </>
  )
}
