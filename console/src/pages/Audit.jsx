import { Fragment, useEffect, useState } from 'react'
import { api } from '../api.js'
import { Link, useQuery, useTitle } from '../router.js'
import { Button, Chips, Empty, ErrorState, PageHeader, Skeleton, When, useAction, useLoad } from '../ui.jsx'

const GROUPS = [['', 'Everything'], ['billing', 'Billing'], ['clients', 'Clients'], ['signin', 'Sign ins'], ['team', 'Team'], ['shop', 'In shops']]
const KIND = { platform: 'Bottle Point team', shop: 'Shop staff', system: 'Automatic' }

export default function Audit() {
  useTitle('Audit log')
  const [query, setQuery] = useQuery()
  const filters = { group: query.group, from: query.from, to: query.to, businessId: query.client }
  const first = useLoad(signal => api.listAudit({ ...filters, limit: 50 }, { signal }), [query.group, query.from, query.to, query.client])
  const [more, setMore] = useState({ rows: [], next: undefined })
  const [open, setOpen] = useState(null)
  const [run, busy] = useAction()
  useEffect(() => setMore({ rows: [], next: undefined }), [first.data])

  const rows = [...(first.data?.entries ?? []), ...more.rows]
  const next = more.next === undefined ? first.data?.nextBefore : more.next
  const loadMore = async () => {
    const r = await run(() => api.listAudit({ ...filters, limit: 50, before: next }))
    if (r) setMore(m => ({ rows: [...m.rows, ...r.entries], next: r.nextBefore }))
  }

  return (
    <>
      <PageHeader title="Audit log"><p className="cx-muted">Everything changed by the team, by shops and by the system. Entries cannot be edited or deleted.</p></PageHeader>
      <div className="cx-toolbar">
        <Chips label="Kind" value={query.group ?? ''} onChange={v => setQuery({ group: v })} items={GROUPS} />
        <div className="cx-toolbar-right">
          <label className="cx-inline-field"><span>From</span><input type="date" className="cx-input" value={query.from ?? ''} onChange={e => setQuery({ from: e.target.value })} /></label>
          <label className="cx-inline-field"><span>To</span><input type="date" className="cx-input" value={query.to ?? ''} onChange={e => setQuery({ to: e.target.value })} /></label>
          {query.client && <Button size="sm" onClick={() => setQuery({ client: '' })}>Clear client filter</Button>}
        </div>
      </div>
      {first.error && !first.data ? <ErrorState error={first.error} onRetry={first.reload} /> : !first.data ? <Skeleton rows={10} cols={4} /> : !rows.length ? (
        <Empty title="Nothing recorded for these filters" />
      ) : (
        <>
          <div className="cx-table-wrap">
            <table className="cx-table cx-table-cards">
              <thead><tr><th>When</th><th>What happened</th><th>Who</th><th>Client</th></tr></thead>
              <tbody>
                {rows.map(r => (
                  <Fragment key={r.id}>
                    <tr className="cx-row-link" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                      <td data-label="When" className="cx-nowrap"><When at={r.at} mode="datetime" /></td>
                      <td className="cx-card-title">{r.summary}</td>
                      <td data-label="Who">{r.actor.name}<small className="cx-muted cx-block">{KIND[r.actor.kind]}</small></td>
                      <td data-label="Client">{r.business ? <Link to={`/clients/${r.business.id}`} className="cx-link" onClick={e => e.stopPropagation()}>{r.business.name}</Link> : <span className="cx-muted">-</span>}</td>
                    </tr>
                    {open === r.id && (
                      <tr className="cx-row-detail">
                        <td colSpan={4}>
                          <div className="cx-detail">
                            <span className="cx-muted cx-num">{r.action}</span>
                            {r.data ? <pre className="cx-json">{JSON.stringify(r.data, null, 2)}</pre> : <span className="cx-muted">No details</span>}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {next ? <div className="cx-more"><Button onClick={loadMore} busy={busy}>Show older</Button></div> : null}
        </>
      )}
    </>
  )
}
