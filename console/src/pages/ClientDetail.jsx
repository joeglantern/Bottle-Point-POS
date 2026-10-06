import { useState } from 'react'
import { api } from '../api.js'
import { count, date, fromBps, fromCents, money, percent, roleLabel, toBps, toCents, whyNot } from '../format.js'
import { Link, useQuery, useTitle } from '../router.js'
import { useSession } from '../session.js'
import {
  Button, Card, ConfirmDialog, Dialog, Empty, ErrorState, Field, Icon, Meter, PageHeader, SecretDialog, Skeleton,
  StatusPill, Tabs, When, useAction, useLoad
} from '../ui.jsx'
import { InvoiceTable } from './Invoices.jsx'

const TABS = [['overview', 'Overview'], ['subscription', 'Subscription'], ['invoices', 'Invoices'], ['people', 'People'], ['notes', 'Notes'], ['activity', 'Activity']]

export default function ClientDetail({ id }) {
  const [query, setQuery] = useQuery()
  const tab = TABS.some(t => t[0] === query.tab) ? query.tab : 'overview'
  const res = useLoad(signal => api.getTenant(id, { signal }), [id])
  const t = res.data?.tenant
  useTitle(t?.name ?? 'Client')
  const [dialog, setDialog] = useState(null)
  const { can } = useSession()

  if (res.error && !t) {
    return (
      <>
        <Link to="/clients" className="cx-back"><Icon name="back" size={16} />Clients</Link>
        {res.error.status === 404 ? <Empty title="Client not found">It may have been removed, or the link is wrong.</Empty> : <ErrorState error={res.error} onRetry={res.reload} />}
      </>
    )
  }
  if (!t) return <><Link to="/clients" className="cx-back"><Icon name="back" size={16} />Clients</Link><Skeleton rows={8} /></>

  const sub = t.subscription
  const close = () => setDialog(null)
  const done = () => { setDialog(null); res.reload() }
  const suspended = t.status === 'SUSPENDED'

  return (
    <>
      <Link to="/clients" className="cx-back"><Icon name="back" size={16} />Clients</Link>
      <PageHeader
        title={t.name}
        actions={
          <>
            {sub && !suspended && t.status !== 'CANCELLED' && (
              <Button onClick={() => setDialog('suspend')} disabled={!can('tenants.suspend')} title={can('tenants.suspend') ? undefined : whyNot('tenants.suspend')}>Suspend</Button>
            )}
            {suspended && <Button kind="primary" onClick={() => setDialog('reactivate')} disabled={!can('tenants.suspend')} title={can('tenants.suspend') ? undefined : whyNot('tenants.suspend')}>Reactivate</Button>}
            <Button onClick={() => setDialog('plan')} disabled={!can('subscriptions.write')} title={can('subscriptions.write') ? undefined : whyNot('subscriptions.write')}>{sub ? 'Change plan' : 'Choose a plan'}</Button>
          </>
        }
      >
        <div className="cx-head-meta">
          <StatusPill status={t.status} />
          {sub && <span>{sub.plan.name}</span>}
          <span className="cx-muted">Client since {date(t.createdAt)}</span>
        </div>
      </PageHeader>

      {suspended && sub?.suspendedReason && (
        <div className="cx-banner cx-banner-red" role="status">
          <Icon name="alert" />
          <span>Suspended {sub.suspendedAt ? <When at={sub.suspendedAt} /> : null}: {sub.suspendedReason}. Staff can sign in but cannot sell.</span>
        </div>
      )}

      <Tabs label="Client sections" tabs={TABS} value={tab} onChange={k => setQuery({ tab: k === 'overview' ? '' : k })} />

      <div className="cx-tab-body">
        {tab === 'overview' && <OverviewTab t={t} onEdit={() => setDialog('edit')} />}
        {tab === 'subscription' && <SubscriptionTab t={t} openDialog={setDialog} />}
        {tab === 'invoices' && <InvoicesTab t={t} />}
        {tab === 'people' && <PeopleTab t={t} />}
        {tab === 'notes' && <NotesTab t={t} />}
        {tab === 'activity' && <ActivityTab t={t} />}
      </div>

      {dialog === 'suspend' && <SuspendDialog t={t} onClose={close} onDone={done} />}
      {dialog === 'reactivate' && <ReactivateDialog t={t} onClose={close} onDone={done} />}
      {dialog === 'plan' && <PlanDialog t={t} onClose={close} onDone={done} />}
      {dialog === 'terms' && <TermsDialog t={t} onClose={close} onDone={done} />}
      {dialog === 'trial' && <TrialDialog t={t} onClose={close} onDone={done} />}
      {dialog === 'cancel' && <CancelDialog t={t} onClose={close} onDone={done} />}
      {dialog === 'resume' && <ResumeDialog t={t} onClose={close} onDone={done} />}
      {dialog === 'edit' && <EditDialog t={t} onClose={close} onDone={done} />}
    </>
  )
}

// ---------- tabs ----------

function OverviewTab({ t, onEdit }) {
  const { can } = useSession()
  const l = t.limits
  return (
    <div className="cx-grid-2">
      <div className="cx-stack">
        <Card title="Usage">
          <div className="cx-meters">
            <Meter label="Branches" used={t.usage.branches} max={l?.maxBranches ?? null} />
            <Meter label="Staff" used={t.usage.staff} max={l?.maxStaff ?? null} />
            <Meter label="Products" used={t.usage.products} max={l?.maxProducts ?? null} />
          </div>
        </Card>
        <Card title="Activity">
          <dl className="cx-dl">
            <div><dt>Sales, last 30 days</dt><dd className="cx-num">{money(t.sales30dCents)}</dd></div>
            <div><dt>Last sale</dt><dd><When at={t.lastSaleAt} mode="relative" /></dd></div>
            <div><dt>Last sign in</dt><dd><When at={t.lastSignInAt} mode="relative" /></dd></div>
            <div><dt>Monthly value</dt><dd className="cx-num">{money(t.mrrCents)}</dd></div>
            <div><dt>Owed</dt><dd className={'cx-num' + (t.overdueInvoiceCount ? ' cx-text-red' : '')}>{money(t.openInvoiceCents)}{t.overdueInvoiceCount ? ` (${t.overdueInvoiceCount} overdue)` : ''}</dd></div>
          </dl>
        </Card>
      </div>
      <div className="cx-stack">
        <Card title="Business details" actions={<Button size="sm" onClick={onEdit} disabled={!can('tenants.edit')} title={can('tenants.edit') ? undefined : whyNot('tenants.edit')}>Edit</Button>}>
          <dl className="cx-dl">
            <div><dt>Legal name</dt><dd>{t.legalName ?? <span className="cx-muted">Not set</span>}</dd></div>
            <div><dt>KRA PIN</dt><dd className="cx-num">{t.kraPin ?? <span className="cx-muted">Not set</span>}</dd></div>
            <div><dt>Email</dt><dd>{t.email ? <a className="cx-link" href={`mailto:${t.email}`}>{t.email}</a> : <span className="cx-muted">Not set</span>}</dd></div>
            <div><dt>Phone</dt><dd className="cx-num">{t.phone ? <a className="cx-link" href={`tel:${t.phone}`}>{t.phone}</a> : <span className="cx-muted">Not set</span>}</dd></div>
            <div><dt>Address</dt><dd>{t.address ?? <span className="cx-muted">Not set</span>}</dd></div>
          </dl>
        </Card>
        <Card title="Owners">
          <ul className="cx-list">
            {t.owners.map(o => (
              <li key={o.id} className="cx-list-row">
                <span className="cx-list-main"><b>{o.name}</b><small className="cx-num cx-muted">{o.username}</small></span>
                {!o.active && <StatusPill status="OFF" />}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}

function SubscriptionTab({ t, openDialog }) {
  const { can } = useSession()
  const sub = t.subscription
  if (!sub) {
    return (
      <Empty title="No subscription" action={can('subscriptions.write') ? <Button kind="primary" onClick={() => openDialog('plan')}>Choose a plan</Button> : null}>
        This client is not billed. Choose a plan to start billing.
      </Empty>
    )
  }
  const writable = can('subscriptions.write')
  const trialing = sub.status === 'TRIALING'
  const cancelled = sub.status === 'CANCELLED'
  const n = t.nextInvoice
  return (
    <div className="cx-grid-2">
      <div className="cx-stack">
        <Card title="Plan" actions={<Button size="sm" onClick={() => openDialog('plan')} disabled={!writable} title={writable ? undefined : whyNot('subscriptions.write')}>Change plan</Button>}>
          <dl className="cx-dl">
            <div><dt>Plan</dt><dd><b>{sub.plan.name}</b></dd></div>
            <div><dt>Price</dt><dd>{sub.customPriceCents != null ? <>Agreed price <span className="cx-num">{money(sub.customPriceCents)}</span></> : sub.plan.priceText}</dd></div>
            <div><dt>Discount</dt><dd className="cx-num">{sub.discountBps ? percent(sub.discountBps) : <span className="cx-muted">None</span>}</dd></div>
            <div><dt>Status</dt><dd><StatusPill status={sub.status} />{sub.cancelAtPeriodEnd && !cancelled ? <small className="cx-muted cx-after"> ends with this period</small> : null}</dd></div>
            {trialing && <div><dt>Trial ends</dt><dd><When at={sub.trialEndsAt} /> <small className="cx-muted">(<When at={sub.trialEndsAt} mode="relative" />)</small></dd></div>}
            <div><dt>Current period</dt><dd><When at={sub.currentPeriodStart} /> to <When at={sub.currentPeriodEnd} /></dd></div>
          </dl>
          <div className="cx-card-buttons">
            <Button size="sm" onClick={() => openDialog('terms')} disabled={!writable || cancelled} title={writable ? undefined : whyNot('subscriptions.write')}>Discount or agreed price</Button>
            {trialing && <Button size="sm" onClick={() => openDialog('trial')} disabled={!can('trial.extend')} title={can('trial.extend') ? undefined : whyNot('trial.extend')}>Extend trial</Button>}
          </div>
        </Card>
        <Card title="End the subscription" className="cx-danger-zone">
          {cancelled || sub.cancelAtPeriodEnd ? (
            <>
              <p className="cx-muted">{cancelled ? 'This subscription is cancelled. Resuming starts a new period today.' : `This subscription ends on ${date(sub.currentPeriodEnd)}.`}</p>
              <Button onClick={() => openDialog('resume')} disabled={!writable} title={writable ? undefined : whyNot('subscriptions.write')}>Resume subscription</Button>
            </>
          ) : (
            <>
              <p className="cx-muted">Cancelling stops billing. The shop keeps working until the end of the period, or stops at once if you cancel now.</p>
              <Button kind="danger-quiet" onClick={() => openDialog('cancel')} disabled={!writable} title={writable ? undefined : whyNot('subscriptions.write')}>Cancel subscription</Button>
            </>
          )}
        </Card>
      </div>
      <Card title="Next invoice" flush>
        {n ? (
          <>
            <p className="cx-pad cx-muted">For <When at={n.periodStart} /> to <When at={n.periodEnd} />, raised on <When at={n.issueAt} />. An estimate until it is issued.</p>
            <LinesTable lines={n.lines} subtotalCents={n.subtotalCents} taxCents={n.taxCents} totalCents={n.totalCents} />
          </>
        ) : <p className="cx-pad cx-muted">No invoice is coming up for this subscription.</p>}
      </Card>
    </div>
  )
}

export function LinesTable({ lines, subtotalCents, taxCents, totalCents }) {
  return (
    <table className="cx-table cx-lines">
      <thead><tr><th>Description</th><th className="cx-r">Qty</th><th className="cx-r">Unit</th><th className="cx-r">Amount</th></tr></thead>
      <tbody>
        {lines.map((l, i) => (
          <tr key={i}>
            <td>{l.description}</td>
            <td className="cx-r cx-num">{count(l.quantity)}</td>
            <td className="cx-r cx-num">{money(l.unitCents)}</td>
            <td className="cx-r cx-num">{money(l.amountCents)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr><td colSpan={3}>Subtotal</td><td className="cx-r cx-num">{money(subtotalCents)}</td></tr>
        <tr><td colSpan={3}>VAT</td><td className="cx-r cx-num">{money(taxCents)}</td></tr>
        <tr className="cx-total"><td colSpan={3}>Total</td><td className="cx-r cx-num">{money(totalCents)}</td></tr>
      </tfoot>
    </table>
  )
}

function InvoicesTab({ t }) {
  const { can } = useSession()
  const [creating, setCreating] = useState(false)
  const res = useLoad(signal => api.listInvoices({ businessId: t.id, limit: 100 }, { signal }), [t.id])
  return (
    <>
      <div className="cx-tab-actions">
        <Button icon="plus" onClick={() => setCreating(true)} disabled={!can('invoices.write')} title={can('invoices.write') ? undefined : whyNot('invoices.write')}>New invoice</Button>
      </div>
      {res.error && !res.data ? <ErrorState error={res.error} onRetry={res.reload} /> : !res.data ? <Skeleton rows={4} /> : !res.data.invoices.length ? (
        <Empty title="No invoices yet">Invoices raised for this client show up here.</Empty>
      ) : <InvoiceTable rows={res.data.invoices} showClient={false} />}
      {creating && <NewInvoiceDialog t={t} onClose={() => setCreating(false)} onDone={() => { setCreating(false); res.reload() }} />}
    </>
  )
}

function PeopleTab({ t }) {
  const { can } = useSession()
  const res = useLoad(signal => api.listPeople(t.id, { signal }), [t.id])
  const [reset, setReset] = useState(null)
  const [pin, setPin] = useState(null)
  const [signOut, setSignOut] = useState(false)
  const [run, busy, error] = useAction()

  const doReset = async () => {
    const r = await run(() => api.resetPin(t.id, reset.id))
    if (r) { setReset(null); setPin(r); res.reload() }
  }
  const doSignOut = async () => {
    const r = await run(() => api.signOutAll(t.id), null)
    if (r) setSignOut(false)
  }

  return (
    <>
      <div className="cx-tab-actions">
        <Button onClick={() => setSignOut(true)} disabled={!can('sessions.end')} title={can('sessions.end') ? undefined : whyNot('sessions.end')}>Sign out everyone</Button>
      </div>
      {res.error && !res.data ? <ErrorState error={res.error} onRetry={res.reload} /> : !res.data ? <Skeleton rows={4} /> : (
        <div className="cx-table-wrap">
          <table className="cx-table cx-table-cards">
            <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Branches</th><th>Status</th><th className="cx-r">Last sign in</th><th><span className="cx-sr-only">Actions</span></th></tr></thead>
            <tbody>
              {res.data.people.map(p => (
                <tr key={p.id}>
                  <td className="cx-card-title"><b>{p.name}</b></td>
                  <td data-label="Username" className="cx-num">{p.username}</td>
                  <td data-label="Role">{p.role.charAt(0) + p.role.slice(1).toLowerCase()}</td>
                  <td data-label="Branches">{p.role === 'OWNER' ? 'All' : p.branches.map(b => b.name).join(', ') || '-'}</td>
                  <td data-label="Status">{!p.active ? <StatusPill status="OFF" /> : p.locked ? <StatusPill status="LOCKED" /> : <StatusPill status="ACTIVE" />}</td>
                  <td data-label="Last sign in" className="cx-r"><When at={p.lastSignInAt} mode="relative" /></td>
                  <td className="cx-r">
                    {p.role === 'OWNER' && <Button size="sm" onClick={() => setReset(p)} disabled={!can('pins.reset')} title={can('pins.reset') ? undefined : whyNot('pins.reset')}>Reset PIN</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {reset && (
        <ConfirmDialog title={`Reset the PIN for ${reset.name}?`} confirm="Reset PIN" onConfirm={doReset} onClose={() => setReset(null)} busy={busy} error={error}>
          <p>A new PIN is generated and shown to you once. {reset.name} is signed out of every till straight away and any lockout is cleared.</p>
        </ConfirmDialog>
      )}
      {pin && (
        <SecretDialog title="New PIN" label={`PIN for ${pin.user.username}`} value={pin.ownerPin} onClose={() => setPin(null)}>
          <p>{pin.user.name} signs in at the till with the username <b className="cx-num">{pin.user.username}</b> and this PIN.</p>
        </SecretDialog>
      )}
      {signOut && (
        <ConfirmDialog title={`Sign out everyone at ${t.name}?`} confirm="Sign everyone out" danger onConfirm={doSignOut} onClose={() => setSignOut(false)} busy={busy} error={error}>
          <p>Every till and phone signed in to this client is signed out now. Staff can sign in again with their PINs.</p>
        </ConfirmDialog>
      )}
    </>
  )
}

function NotesTab({ t }) {
  const { can, user } = useSession()
  const res = useLoad(signal => api.listNotes(t.id, { signal }), [t.id])
  const [text, setText] = useState('')
  const [run, busy, error] = useAction()
  const add = async e => {
    e.preventDefault()
    if (!text.trim()) return
    const r = await run(() => api.addNote(t.id, text.trim()))
    if (r) { setText(''); res.reload() }
  }
  const remove = async n => {
    if (!window.confirm('Delete this note?')) return
    const r = await run(() => api.deleteNote(t.id, n.id), 'Note deleted')
    if (r) res.reload()
  }
  return (
    <div className="cx-notes">
      <p className="cx-note">Only the Bottle Point team can see these notes. The client never does.</p>
      {can('notes.write') && (
        <form onSubmit={add} className="cx-note-form">
          <label htmlFor="cx-note" className="cx-sr-only">New note</label>
          <textarea id="cx-note" className="cx-input" rows={3} maxLength={2000} value={text} onChange={e => setText(e.target.value)} placeholder="Add a note about this client" />
          <div className="cx-note-form-foot">
            <span className="cx-muted cx-num">{text.length} / 2000</span>
            <Button kind="primary" type="submit" busy={busy} disabled={!text.trim()}>Add note</Button>
          </div>
          {error && <p className="cx-form-error" role="alert">{error.message}</p>}
        </form>
      )}
      {res.error && !res.data ? <ErrorState error={res.error} onRetry={res.reload} /> : !res.data ? <Skeleton rows={3} cols={1} /> : !res.data.notes.length ? (
        <Empty title="No notes yet">Notes are a good place for agreements, contacts and anything the next person should know.</Empty>
      ) : (
        <ol className="cx-timeline">
          {res.data.notes.map(n => (
            <li key={n.id}>
              <div className="cx-timeline-head">
                <b>{n.author.name}</b>
                <small className="cx-muted"><When at={n.createdAt} mode="datetime" /></small>
                {(n.author.id === user.id || user.role === 'SUPER_ADMIN') && can('notes.write') && (
                  <button type="button" className="cx-link cx-link-quiet" onClick={() => remove(n)}>Delete</button>
                )}
              </div>
              <p className="cx-prewrap">{n.body}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

const prettyAction = a => {
  const s = String(a).replace(/^(console|billing)\./, '').replace(/[._]+/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function ActivityTab({ t }) {
  const [pages, setPages] = useState([])
  const [cursor, setCursor] = useState(null)
  const first = useLoad(signal => api.tenantActivity(t.id, { limit: 30 }, { signal }), [t.id])
  const [run, busy] = useAction()
  const rows = [...(first.data?.activity ?? []), ...pages]
  const next = cursor === null ? first.data?.nextBefore : cursor
  const more = async () => {
    const r = await run(() => api.tenantActivity(t.id, { limit: 30, before: next }))
    if (r) { setPages(p => [...p, ...r.activity]); setCursor(r.nextBefore ?? '') }
  }
  if (first.error && !first.data) return <ErrorState error={first.error} onRetry={first.reload} />
  if (!first.data) return <Skeleton rows={6} cols={3} />
  if (!rows.length) return <Empty title="No activity yet">Sign ins, settings changes, billing events and support actions show up here.</Empty>
  return (
    <>
      <div className="cx-table-wrap">
        <table className="cx-table cx-table-cards">
          <thead><tr><th>When</th><th>What</th><th>Who</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td data-label="When" className="cx-nowrap"><When at={r.at} mode="datetime" /></td>
                <td className="cx-card-title">{prettyAction(r.action)}</td>
                <td data-label="Who">{r.actor.name}<small className="cx-muted"> {r.actor.kind === 'platform' ? '(Bottle Point team)' : r.actor.kind === 'system' ? '(automatic)' : ''}</small></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {next ? <div className="cx-more"><Button onClick={more} busy={busy}>Show older</Button></div> : null}
    </>
  )
}

// ---------- dialogs ----------

function SuspendDialog({ t, onClose, onDone }) {
  const [reason, setReason] = useState('')
  const [run, busy, error] = useAction()
  const go = async () => { if (reason.trim().length < 3) return; if (await run(() => api.suspendTenant(t.id, reason.trim()), `${t.name} is suspended`)) onDone() }
  return (
    <ConfirmDialog title={`Suspend ${t.name}?`} confirm="Suspend client" danger onConfirm={go} onClose={onClose} busy={busy} error={error}>
      <p>Staff can still sign in and see their billing page, but every till stops selling at once until you reactivate the client.</p>
      <Field label="Reason, shown to the client" error={reason && reason.trim().length < 3 ? 'At least 3 characters' : null}>
        <textarea className="cx-input" rows={3} maxLength={300} value={reason} onChange={e => setReason(e.target.value)} placeholder="For example: Invoice INV-2026-000123 is 30 days overdue" />
      </Field>
    </ConfirmDialog>
  )
}

function ReactivateDialog({ t, onClose, onDone }) {
  const [run, busy, error] = useAction()
  const go = async () => { if (await run(() => api.reactivateTenant(t.id), `${t.name} is active again`)) onDone() }
  return (
    <ConfirmDialog title={`Reactivate ${t.name}?`} confirm="Reactivate" onConfirm={go} onClose={onClose} busy={busy} error={error}>
      <p>The tills start selling again straight away. {t.overdueInvoiceCount ? `The client still has ${t.overdueInvoiceCount} overdue invoice${t.overdueInvoiceCount === 1 ? '' : 's'}, so it comes back as past due.` : ''}</p>
    </ConfirmDialog>
  )
}

function PlanDialog({ t, onClose, onDone }) {
  const plans = useLoad(signal => api.listPlans(false, { signal }), [])
  const current = t.subscription?.plan.id
  const [planId, setPlanId] = useState('')
  const [run, busy, error, clear] = useAction()
  const over = error?.code === 'over_plan_limits' ? error.details?.over ?? [] : null
  const list = plans.data?.plans ?? []
  const chosen = planId || list.find(p => p.id !== current)?.id || ''
  const go = async force => {
    const r = await run(() => api.changePlan(t.id, chosen, force), 'Plan changed')
    if (r) onDone()
  }
  return (
    <Dialog
      title={t.subscription ? 'Change plan' : 'Choose a plan'}
      subtitle={t.subscription ? `${t.name} is on ${t.subscription.plan.name}. The change applies now and the next invoice uses the new plan.` : `Billing for ${t.name} starts today.`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          {over ? <Button kind="danger" busy={busy} onClick={() => go(true)}>Change anyway</Button> : <Button kind="primary" busy={busy} disabled={!chosen} onClick={() => go(false)}>Change plan</Button>}
        </>
      }
    >
      {!plans.data ? <Skeleton rows={4} cols={2} /> : (
        <div className="cx-radio-list" role="radiogroup" aria-label="Plan">
          {list.map(p => (
            <label key={p.id} className={'cx-radio' + (chosen === p.id ? ' is-on' : '') + (p.id === current ? ' is-current' : '')}>
              <input type="radio" name="plan" value={p.id} checked={chosen === p.id} disabled={p.id === current} onChange={() => { setPlanId(p.id); clear() }} />
              <span>
                <b>{p.name}</b>{p.id === current && <small className="cx-muted"> (current)</small>}{!p.public && <small className="cx-muted"> (private)</small>}
                <small className="cx-muted cx-block">{p.priceText}</small>
              </span>
            </label>
          ))}
        </div>
      )}
      {over ? (
        <div className="cx-banner cx-banner-amber" role="alert">
          <Icon name="alert" />
          <div>
            <p>This client uses more than the new plan allows:</p>
            <ul>{over.map(o => <li key={o.what}>{o.used} {o.what}, the plan allows {o.max}</li>)}</ul>
            <p>Changing anyway keeps everything working, but they cannot add more until they are under the limit.</p>
          </div>
        </div>
      ) : error ? <p className="cx-form-error" role="alert">{error.message}</p> : null}
    </Dialog>
  )
}

function TermsDialog({ t, onClose, onDone }) {
  const sub = t.subscription
  const [discount, setDiscount] = useState(sub.discountBps ? fromBps(sub.discountBps) : '')
  const [agreed, setAgreed] = useState(sub.customPriceCents != null)
  const [price, setPrice] = useState(sub.customPriceCents != null ? fromCents(sub.customPriceCents) : '')
  const [run, busy, error] = useAction()
  const bps = discount === '' ? 0 : toBps(discount)
  const cents = agreed ? toCents(price) : null
  const invalid = bps == null || (agreed && cents == null)
  const go = async () => {
    if (invalid) return
    const r = await run(() => api.setTerms(t.id, { discountBps: bps, customPriceCents: agreed ? cents : null }), 'Terms saved')
    if (r) onDone()
  }
  return (
    <Dialog title="Discount and agreed price" subtitle={`${t.name}, ${sub.plan.name}: ${sub.plan.priceText}`} onClose={onClose} busy={busy} size="sm"
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button kind="primary" busy={busy} disabled={invalid} onClick={go}>Save</Button></>}>
      <Field label="Discount (%)" hint="Taken off every invoice from the next one. Leave empty for none." error={bps == null ? 'A percentage from 0 to 100' : null}>
        <input className="cx-input cx-num" inputMode="decimal" value={discount} onChange={e => setDiscount(e.target.value)} placeholder="0" />
      </Field>
      <label className="cx-check">
        <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} />
        <span>Agreed fixed price instead of the plan price</span>
      </label>
      {agreed && (
        <Field label={`Agreed price per ${sub.plan.interval === 'YEAR' ? 'year' : 'month'} (KSh, before VAT)`} error={price && cents == null ? 'Enter an amount in shillings' : null}>
          <input className="cx-input cx-num" inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} autoFocus />
        </Field>
      )}
      {error && <p className="cx-form-error" role="alert">{error.message}</p>}
    </Dialog>
  )
}

function TrialDialog({ t, onClose, onDone }) {
  const [days, setDays] = useState('7')
  const [run, busy, error] = useAction()
  const n = Number(days)
  const ok = Number.isInteger(n) && n >= 1 && n <= 90
  const go = async () => { if (ok && (await run(() => api.extendTrial(t.id, n), 'Trial extended'))) onDone() }
  const until = ok && t.subscription?.trialEndsAt ? new Date(new Date(t.subscription.trialEndsAt).getTime() + n * 86400000) : null
  return (
    <ConfirmDialog title="Extend the trial" confirm="Extend trial" onConfirm={go} onClose={onClose} busy={busy} error={error}>
      <Field label="Extra days" hint={until ? `The trial will end on ${date(until)}.` : '1 to 90 days'} error={days && !ok ? '1 to 90 days' : null}>
        <input className="cx-input cx-num" inputMode="numeric" value={days} onChange={e => setDays(e.target.value.replace(/\D/g, '').slice(0, 2))} autoFocus />
      </Field>
    </ConfirmDialog>
  )
}

function CancelDialog({ t, onClose, onDone }) {
  const sub = t.subscription
  const [when, setWhen] = useState('end')
  const [reason, setReason] = useState('')
  const [run, busy, error] = useAction()
  const go = async () => {
    const r = await run(() => api.cancelSubscription(t.id, { atPeriodEnd: when === 'end', ...(reason.trim() ? { reason: reason.trim() } : {}) }), 'Subscription cancelled')
    if (r) onDone()
  }
  return (
    <ConfirmDialog title={`Cancel ${t.name}?`} confirm="Cancel subscription" danger onConfirm={go} onClose={onClose} busy={busy} error={error}>
      <div className="cx-radio-list" role="radiogroup" aria-label="When">
        <label className={'cx-radio' + (when === 'end' ? ' is-on' : '')}>
          <input type="radio" name="when" checked={when === 'end'} onChange={() => setWhen('end')} />
          <span><b>At the end of the period</b><small className="cx-muted cx-block">The shop keeps working until {date(sub.currentPeriodEnd)}, then stops. No more invoices.</small></span>
        </label>
        <label className={'cx-radio' + (when === 'now' ? ' is-on' : '')}>
          <input type="radio" name="when" checked={when === 'now'} onChange={() => setWhen('now')} />
          <span><b>Now</b><small className="cx-muted cx-block">The tills stop selling straight away.</small></span>
        </label>
      </div>
      <Field label="Reason (optional, internal)">
        <input className="cx-input" maxLength={300} value={reason} onChange={e => setReason(e.target.value)} />
      </Field>
    </ConfirmDialog>
  )
}

function ResumeDialog({ t, onClose, onDone }) {
  const [run, busy, error] = useAction()
  const go = async () => { if (await run(() => api.resumeSubscription(t.id), 'Subscription resumed')) onDone() }
  return (
    <ConfirmDialog title={`Resume ${t.name}?`} confirm="Resume" onConfirm={go} onClose={onClose} busy={busy} error={error}>
      <p>{t.subscription.status === 'CANCELLED' ? 'A new billing period starts today on the same plan, and the tills start selling again.' : 'The subscription carries on past the end of this period as normal.'}</p>
    </ConfirmDialog>
  )
}

function EditDialog({ t, onClose, onDone }) {
  const [f, setF] = useState({ name: t.name, legalName: t.legalName ?? '', email: t.email ?? '', phone: t.phone ?? '', address: t.address ?? '', kraPin: t.kraPin ?? '' })
  const [run, busy, error] = useAction()
  const set = k => e => setF(x => ({ ...x, [k]: e.target.value }))
  const fe = error?.fields ?? {}
  const kraBad = f.kraPin && !/^[A-Za-z]\d{9}[A-Za-z]$/.test(f.kraPin.trim())
  const go = async e => {
    e.preventDefault()
    if (f.name.trim().length < 2 || kraBad) return
    const r = await run(() => api.updateTenant(t.id, { ...f, kraPin: f.kraPin.trim().toUpperCase() }), 'Details saved')
    if (r) onDone()
  }
  return (
    <Dialog title="Business details" onClose={onClose} busy={busy}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button kind="primary" type="submit" form="cx-edit-client" busy={busy}>Save</Button></>}>
      <form id="cx-edit-client" onSubmit={go} noValidate className="cx-form-grid">
        <Field label="Name" error={fe.name ?? (f.name.trim().length < 2 ? 'At least 2 characters' : null)}><input className="cx-input" value={f.name} onChange={set('name')} /></Field>
        <Field label="Legal name" error={fe.legalName}><input className="cx-input" value={f.legalName} onChange={set('legalName')} /></Field>
        <Field label="Email" error={fe.email}><input className="cx-input" type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="Phone" error={fe.phone}><input className="cx-input" type="tel" value={f.phone} onChange={set('phone')} /></Field>
        <Field label="KRA PIN" error={fe.kraPin ?? (kraBad ? 'A letter, nine digits and a letter' : null)}><input className="cx-input cx-num" value={f.kraPin} onChange={set('kraPin')} autoCapitalize="characters" /></Field>
        <Field label="Address" error={fe.address} className="cx-span-2"><input className="cx-input" value={f.address} onChange={set('address')} /></Field>
      </form>
      {error && !Object.keys(fe).length && <p className="cx-form-error" role="alert">{error.message}</p>}
    </Dialog>
  )
}

function NewInvoiceDialog({ t, onClose, onDone }) {
  const [lines, setLines] = useState([{ description: '', quantity: '1', unit: '' }])
  const [due, setDue] = useState('7')
  const [notes, setNotes] = useState('')
  const [run, busy, error] = useAction()
  const set = (i, k, v) => setLines(ls => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)))
  const parsed = lines.map(l => ({ description: l.description.trim(), quantity: Number(l.quantity), unitCents: toCents(l.unit) }))
  const valid = parsed.length > 0 && parsed.every(l => l.description && Number.isInteger(l.quantity) && l.quantity >= 1 && l.quantity <= 1000 && l.unitCents != null) && Number(due) >= 0 && Number(due) <= 90
  const subtotal = parsed.reduce((a, l) => a + (l.unitCents ?? 0) * (Number.isFinite(l.quantity) ? l.quantity : 0), 0)
  const go = async () => {
    if (!valid) return
    const r = await run(() => api.createInvoice(t.id, { lines: parsed, dueInDays: Number(due), ...(notes.trim() ? { notes: notes.trim() } : {}) }), 'Invoice created')
    if (r) onDone()
  }
  return (
    <Dialog title="New invoice" subtitle={`A one off invoice for ${t.name}. VAT is added.`} onClose={onClose} busy={busy} size="lg"
      footer={<><span className="cx-muted cx-num cx-foot-left">Subtotal {money(subtotal)} before VAT</span><Button onClick={onClose} disabled={busy}>Cancel</Button><Button kind="primary" busy={busy} disabled={!valid} onClick={go}>Create invoice</Button></>}>
      <div className="cx-line-editor">
        <div className="cx-line-head" aria-hidden="true"><span>Description</span><span>Qty</span><span>Unit price (KSh)</span><span /></div>
        {lines.map((l, i) => (
          <div key={i} className="cx-line-row">
            <input className="cx-input" aria-label={`Line ${i + 1} description`} value={l.description} onChange={e => set(i, 'description', e.target.value)} placeholder="For example: Setup and training" />
            <input className="cx-input cx-num" aria-label={`Line ${i + 1} quantity`} inputMode="numeric" value={l.quantity} onChange={e => set(i, 'quantity', e.target.value.replace(/\D/g, ''))} />
            <input className="cx-input cx-num" aria-label={`Line ${i + 1} unit price`} inputMode="decimal" value={l.unit} onChange={e => set(i, 'unit', e.target.value)} />
            <button type="button" className="cx-iconbtn" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines(ls => ls.filter((_, j) => j !== i))}><Icon name="close" /></button>
          </div>
        ))}
        <Button size="sm" icon="plus" onClick={() => setLines(ls => [...ls, { description: '', quantity: '1', unit: '' }])} disabled={lines.length >= 20}>Add a line</Button>
      </div>
      <div className="cx-form-grid">
        <Field label="Due in (days)"><input className="cx-input cx-num" inputMode="numeric" value={due} onChange={e => setDue(e.target.value.replace(/\D/g, '').slice(0, 2))} /></Field>
        <Field label="Notes on the invoice (optional)"><input className="cx-input" maxLength={500} value={notes} onChange={e => setNotes(e.target.value)} /></Field>
      </div>
      {error && <p className="cx-form-error" role="alert">{error.message}</p>}
    </Dialog>
  )
}
