import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { count, money, whyNot } from '../format.js'
import { Link, navigate, useQuery, useTitle } from '../router.js'
import { useSession } from '../session.js'
import { Button, Chips, Dialog, Empty, ErrorState, Field, PageHeader, Pagination, SecretDialog, Skeleton, SortHeader, StatusPill, When, useAction, useLoad } from '../ui.jsx'

const LIMIT = 25
const STATUSES = [['', 'All'], ['ACTIVE', 'Active'], ['TRIALING', 'Trialing'], ['PAST_DUE', 'Past due'], ['SUSPENDED', 'Suspended'], ['CANCELLED', 'Cancelled'], ['NONE', 'No plan']]

export default function Clients() {
  useTitle('Clients')
  const { can } = useSession()
  const [query, setQuery] = useQuery()
  const page = Math.max(1, Number(query.page) || 1)
  const sort = query.sort || 'name'
  const dir = query.dir || (sort === 'name' ? 'asc' : 'desc')
  const [text, setText] = useState(query.q ?? '')
  const [adding, setAdding] = useState(false)
  const [created, setCreated] = useState(null)

  // search box writes to the URL after a short pause
  useEffect(() => {
    const t = setTimeout(() => { if ((query.q ?? '') !== text) setQuery({ q: text }, { replace: true }) }, 300)
    return () => clearTimeout(t)
  }, [text])

  const plans = useLoad(signal => api.listPlans(true, { signal }), [])
  const res = useLoad(
    signal => api.listTenants({ q: query.q, status: query.status, planId: query.plan, sort, dir, limit: LIMIT, offset: (page - 1) * LIMIT }, { signal }),
    [query.q, query.status, query.plan, sort, dir, page]
  )
  const rows = res.data?.tenants ?? []
  const counts = res.data?.counts ?? {}

  const onSort = field => setQuery({ sort: field, dir: sort === field ? (dir === 'asc' ? 'desc' : 'asc') : field === 'name' ? 'asc' : 'desc' })

  return (
    <>
      <PageHeader
        title="Clients"
        actions={<Button kind="primary" icon="plus" onClick={() => setAdding(true)} disabled={!can('tenants.create')} title={can('tenants.create') ? undefined : whyNot('tenants.create')}>New client</Button>}
      />

      <div className="cx-toolbar">
        <Chips label="Status" value={query.status ?? ''} onChange={v => setQuery({ status: v })} items={STATUSES.map(([k, l]) => [k, l, k ? counts[k] ?? 0 : counts.ALL])} />
        <div className="cx-toolbar-right">
          <select className="cx-select" aria-label="Plan" value={query.plan ?? ''} onChange={e => setQuery({ plan: e.target.value })}>
            <option value="">All plans</option>
            {(plans.data?.plans ?? []).map(p => <option key={p.id} value={p.id}>{p.name}{p.active ? '' : ' (archived)'}</option>)}
          </select>
          <input className="cx-input cx-search" type="search" placeholder="Search name or owner" aria-label="Search clients" value={text} onChange={e => setText(e.target.value)} />
        </div>
      </div>

      {res.error && !res.data ? <ErrorState error={res.error} onRetry={res.reload} /> : !res.data ? <Skeleton rows={8} cols={6} /> : !rows.length ? (
        <Empty title={query.q || query.status || query.plan ? 'No clients match these filters' : 'No clients yet'} action={can('tenants.create') && !query.q ? <Button kind="primary" onClick={() => setAdding(true)}>Add the first client</Button> : null}>
          {query.q || query.status || query.plan ? 'Try a different search or clear the filters.' : 'Every shop that uses Bottle Point shows up here.'}
        </Empty>
      ) : (
        <div className={'cx-table-wrap' + (res.loading ? ' is-loading' : '')}>
          <table className="cx-table cx-table-cards">
            <thead>
              <tr>
                <SortHeader field="name" label="Client" sort={sort} dir={dir} onSort={onSort} />
                <th>Plan</th>
                <th>Status</th>
                <th className="cx-r">Branches</th>
                <th className="cx-r">Staff</th>
                <SortHeader field="sales" label="Sales, 30 days" sort={sort} dir={dir} onSort={onSort} className="cx-r" />
                <SortHeader field="mrr" label="MRR" sort={sort} dir={dir} onSort={onSort} className="cx-r" />
                <SortHeader field="joined" label="Joined" sort={sort} dir={dir} onSort={onSort} className="cx-r" />
              </tr>
            </thead>
            <tbody>
              {rows.map(t => (
                <tr key={t.id} className="cx-row-link" onClick={e => { if (!e.target.closest('a')) navigate(`/clients/${t.id}`) }}>
                  <td className="cx-card-title"><Link to={`/clients/${t.id}`} className="cx-strong-link">{t.name}</Link></td>
                  <td data-label="Plan">{t.plan?.name ?? <span className="cx-muted">None</span>}</td>
                  <td data-label="Status"><StatusPill status={t.status} />{t.status === 'TRIALING' && t.trialEndsAt ? <small className="cx-muted cx-after"> ends <When at={t.trialEndsAt} /></small> : null}</td>
                  <td data-label="Branches" className="cx-r cx-num">{count(t.branches)}</td>
                  <td data-label="Staff" className="cx-r cx-num">{count(t.staff)}</td>
                  <td data-label="Sales, 30 days" className="cx-r cx-num">{money(t.sales30dCents)}</td>
                  <td data-label="MRR" className="cx-r cx-num">{money(t.mrrCents)}</td>
                  <td data-label="Joined" className="cx-r"><When at={t.createdAt} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination total={res.data.total} limit={LIMIT} page={page} onPage={p => setQuery({ page: p })} />
        </div>
      )}

      {adding && (
        <NewClientDialog
          plans={(plans.data?.plans ?? []).filter(p => p.active)}
          onClose={() => setAdding(false)}
          onCreated={r => { setAdding(false); if (r.ownerPin) setCreated(r); else navigate(`/clients/${r.tenant.id}`) }}
        />
      )}
      {created?.ownerPin && (
        <SecretDialog title={`${created.tenant.name} is ready`} label={`PIN for ${created.owner.username}`} value={created.ownerPin} onClose={() => { const id = created.tenant.id; setCreated(null); navigate(`/clients/${id}`) }}>
          <p>The owner signs in at the till with the username <b className="cx-num">{created.owner.username}</b> and this PIN, then adds their own staff.</p>
        </SecretDialog>
      )}
    </>
  )
}

const USERNAME = /^[a-z0-9._]{3,32}$/

function NewClientDialog({ plans, onClose, onCreated }) {
  const [f, setF] = useState({ businessName: '', branchName: 'Main', ownerName: '', ownerUsername: '', ownerPin: '', planId: plans[0]?.id ?? '', trialDays: '', email: '', phone: '' })
  const [touched, setTouched] = useState(false)
  const [run, busy, error] = useAction()
  const set = k => e => setF(x => ({ ...x, [k]: e.target.value }))
  const plan = plans.find(p => p.id === f.planId)

  const errors = {}
  if (f.businessName.trim().length < 2) errors.businessName = 'Enter the business name'
  if (f.branchName.trim().length < 2) errors.branchName = 'Name the first branch'
  if (!f.ownerName.trim()) errors.ownerName = 'Enter the owner name'
  if (!USERNAME.test(f.ownerUsername)) errors.ownerUsername = '3 to 32 lowercase letters, digits, dots or underscores'
  if (f.ownerPin && !/^\d{4,6}$/.test(f.ownerPin)) errors.ownerPin = '4 to 6 digits, or leave empty to generate one'
  if (!f.planId) errors.planId = 'Choose a plan'
  if (f.trialDays !== '' && !(Number(f.trialDays) >= 0 && Number(f.trialDays) <= 90)) errors.trialDays = '0 to 90 days'
  const server = error?.fields ?? {}

  const submit = async e => {
    e.preventDefault()
    setTouched(true)
    if (Object.keys(errors).length) return
    const body = {
      businessName: f.businessName.trim(),
      branchName: f.branchName.trim(),
      ownerName: f.ownerName.trim(),
      ownerUsername: f.ownerUsername,
      planId: f.planId,
      ...(f.ownerPin ? { ownerPin: f.ownerPin } : {}),
      ...(f.trialDays !== '' ? { trialDays: Number(f.trialDays) } : {}),
      ...(f.email.trim() ? { email: f.email.trim() } : {}),
      ...(f.phone.trim() ? { phone: f.phone.trim() } : {})
    }
    const r = await run(() => api.createTenant(body), 'Client added')
    if (r) onCreated(r)
  }
  const err = k => (touched ? errors[k] : null) ?? server[k]

  return (
    <Dialog
      title="New client"
      subtitle="Creates the business, its first branch and the owner account."
      onClose={onClose}
      busy={busy}
      size="lg"
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button kind="primary" type="submit" form="cx-new-client" busy={busy}>Create client</Button></>}
    >
      <form id="cx-new-client" onSubmit={submit} noValidate className="cx-form">
        <fieldset>
          <legend>Business</legend>
          <div className="cx-form-grid">
            <Field label="Business name" error={err('businessName')}><input className="cx-input" value={f.businessName} onChange={set('businessName')} autoFocus /></Field>
            <Field label="First branch" error={err('branchName')}><input className="cx-input" value={f.branchName} onChange={set('branchName')} /></Field>
            <Field label="Email (optional)" error={err('email')}><input className="cx-input" type="email" value={f.email} onChange={set('email')} /></Field>
            <Field label="Phone (optional)" error={err('phone')}><input className="cx-input" type="tel" value={f.phone} onChange={set('phone')} /></Field>
          </div>
        </fieldset>
        <fieldset>
          <legend>Owner account</legend>
          <div className="cx-form-grid">
            <Field label="Owner name" error={err('ownerName')}><input className="cx-input" value={f.ownerName} onChange={set('ownerName')} /></Field>
            <Field label="Username" hint="Used to sign in at the till" error={err('ownerUsername')}>
              <input className="cx-input cx-num" value={f.ownerUsername} onChange={e => setF(x => ({ ...x, ownerUsername: e.target.value.toLowerCase().replace(/\s/g, '') }))} autoCapitalize="none" spellCheck={false} />
            </Field>
            <Field label="PIN (optional)" hint="Leave empty and a PIN is generated and shown once" error={err('ownerPin')}>
              <input className="cx-input cx-num" inputMode="numeric" autoComplete="off" value={f.ownerPin} onChange={e => setF(x => ({ ...x, ownerPin: e.target.value.replace(/\D/g, '').slice(0, 6) }))} />
            </Field>
          </div>
        </fieldset>
        <fieldset>
          <legend>Plan</legend>
          <div className="cx-form-grid">
            <Field label="Plan" error={err('planId')}>
              <select className="cx-select" value={f.planId} onChange={set('planId')}>
                {plans.map(p => <option key={p.id} value={p.id}>{p.name}, {p.priceText}</option>)}
              </select>
            </Field>
            <Field label="Trial days" hint={plan ? `Default for ${plan.name}: ${plan.trialDays}. 0 starts billing now.` : null} error={err('trialDays')}>
              <input className="cx-input cx-num" inputMode="numeric" value={f.trialDays} placeholder={plan ? String(plan.trialDays) : ''} onChange={e => setF(x => ({ ...x, trialDays: e.target.value.replace(/\D/g, '').slice(0, 2) }))} />
            </Field>
          </div>
        </fieldset>
        {error && !Object.keys(server).length && <p className="cx-form-error" role="alert">{error.message}</p>}
      </form>
    </Dialog>
  )
}
