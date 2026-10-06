import { useState } from 'react'
import { api } from '../api.js'
import { count, fromBps, fromCents, intervalLabel, modelLabel, priceText, toBps, toCents, whyNot } from '../format.js'
import { useTitle } from '../router.js'
import { useSession } from '../session.js'
import { Button, ConfirmDialog, Dialog, Empty, ErrorState, Field, PageHeader, Skeleton, StatusPill, useAction, useLoad } from '../ui.jsx'

const MODELS = [
  ['FLAT', 'Flat fee', 'One price every month or year'],
  ['PER_BRANCH', 'Per branch', 'Optional base fee plus a price for each branch'],
  ['PERCENT_OF_SALES', 'Share of sales', 'A percentage of what the shop sells, with a minimum'],
  ['ONE_TIME', 'One time licence', 'Paid once, never renews']
]

export default function Plans() {
  useTitle('Plans')
  const { can } = useSession()
  const [showArchived, setShowArchived] = useState(false)
  const [editing, setEditing] = useState(null)
  const [archiving, setArchiving] = useState(null)
  const res = useLoad(signal => api.listPlans(true, { signal }), [])
  const all = res.data?.plans ?? []
  const shown = all.filter(p => showArchived || p.active)
  const archivedCount = all.filter(p => !p.active).length
  const writable = can('plans.write')

  return (
    <>
      <PageHeader title="Plans" actions={<Button kind="primary" icon="plus" onClick={() => setEditing({})} disabled={!writable} title={writable ? undefined : whyNot('plans.write')}>New plan</Button>} />
      {archivedCount > 0 && (
        <label className="cx-check cx-toolbar-check">
          <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
          <span>Show archived plans ({archivedCount})</span>
        </label>
      )}
      {res.error && !res.data ? <ErrorState error={res.error} onRetry={res.reload} /> : !res.data ? <Skeleton rows={5} cols={4} /> : !shown.length ? (
        <Empty title="No plans yet" action={writable ? <Button kind="primary" onClick={() => setEditing({})}>Create the first plan</Button> : null}>Clients subscribe to a plan. Create one to start billing.</Empty>
      ) : (
        <div className="cx-plans">
          {shown.map(p => (
            <article key={p.id} className={'cx-plan' + (p.active ? '' : ' is-archived')}>
              <header>
                <div>
                  <h2>{p.name}</h2>
                  <span className="cx-num cx-muted">{p.code}</span>
                </div>
                <div className="cx-plan-tags">
                  {!p.active && <StatusPill status="ARCHIVED" />}
                  {p.active && !p.public && <StatusPill status="PRIVATE" />}
                </div>
              </header>
              <p className="cx-plan-price">{p.priceText}</p>
              {p.description && <p className="cx-muted">{p.description}</p>}
              <dl className="cx-dl cx-dl-compact">
                <div><dt>Model</dt><dd>{modelLabel(p.model)}, {intervalLabel(p.interval).toLowerCase()}</dd></div>
                <div><dt>Limits</dt><dd>{limitText(p)}</dd></div>
                <div><dt>Trial</dt><dd>{p.trialDays ? `${p.trialDays} days` : 'None'}</dd></div>
                <div><dt>Clients</dt><dd className="cx-num">{count(p.clients)}</dd></div>
              </dl>
              <footer>
                <Button size="sm" onClick={() => setEditing(p)} disabled={!writable} title={writable ? undefined : whyNot('plans.write')}>Edit</Button>
                <Button size="sm" kind="ghost" onClick={() => setArchiving(p)} disabled={!writable} title={writable ? undefined : whyNot('plans.write')}>{p.active ? 'Archive' : 'Restore'}</Button>
              </footer>
            </article>
          ))}
        </div>
      )}
      {editing && <PlanForm plan={editing.id ? editing : null} onClose={() => setEditing(null)} onDone={() => { setEditing(null); res.reload() }} />}
      {archiving && <ArchiveDialog plan={archiving} onClose={() => setArchiving(null)} onDone={() => { setArchiving(null); res.reload() }} />}
    </>
  )
}

function limitText(p) {
  const parts = [
    p.maxBranches != null ? `${p.maxBranches} branch${p.maxBranches === 1 ? '' : 'es'}` : null,
    p.maxStaff != null ? `${p.maxStaff} staff` : null,
    p.maxProducts != null ? `${p.maxProducts} products` : null
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : 'No limits'
}

function ArchiveDialog({ plan, onClose, onDone }) {
  const [run, busy, error] = useAction()
  const go = async () => {
    const r = await run(() => (plan.active ? api.archivePlan(plan.id) : api.unarchivePlan(plan.id)), plan.active ? 'Plan archived' : 'Plan restored')
    if (r) onDone()
  }
  return (
    <ConfirmDialog title={plan.active ? `Archive ${plan.name}?` : `Restore ${plan.name}?`} confirm={plan.active ? 'Archive' : 'Restore'} onConfirm={go} onClose={onClose} busy={busy} error={error}>
      <p>{plan.active ? `New clients cannot be put on it. The ${count(plan.clients)} client${plan.clients === 1 ? '' : 's'} already on it keep it and are billed as before.` : 'It can be offered to clients again.'}</p>
    </ConfirmDialog>
  )
}

const num = v => (v === '' ? null : Number(v))

function PlanForm({ plan, onClose, onDone }) {
  const isNew = !plan
  const [f, setF] = useState(() => ({
    name: plan?.name ?? '',
    code: plan?.code ?? '',
    description: plan?.description ?? '',
    model: plan?.model ?? 'FLAT',
    interval: plan?.interval ?? 'MONTH',
    price: plan ? fromCents(plan.priceCents) : '',
    perBranch: plan ? fromCents(plan.perBranchCents) : '',
    percent: plan ? fromBps(plan.percentBps) : '',
    minimum: plan ? fromCents(plan.minimumCents) : '',
    trialDays: String(plan?.trialDays ?? 14),
    maxBranches: plan?.maxBranches != null ? String(plan.maxBranches) : '',
    maxStaff: plan?.maxStaff != null ? String(plan.maxStaff) : '',
    maxProducts: plan?.maxProducts != null ? String(plan.maxProducts) : '',
    public: plan?.public ?? true,
    sortOrder: String(plan?.sortOrder ?? 0)
  }))
  const [codeTouched, setCodeTouched] = useState(!isNew)
  const [run, busy, error] = useAction()
  const set = k => e => setF(x => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  const digits = k => e => setF(x => ({ ...x, [k]: e.target.value.replace(/\D/g, '').slice(0, 6) }))

  const pickModel = m => setF(x => ({ ...x, model: m, interval: m === 'ONE_TIME' ? 'ONCE' : m === 'PERCENT_OF_SALES' ? 'MONTH' : x.interval === 'ONCE' ? 'MONTH' : x.interval, trialDays: m === 'ONE_TIME' && isNew ? '0' : x.trialDays }))

  const priceCents = f.price === '' ? 0 : toCents(f.price)
  const perBranchCents = f.perBranch === '' ? 0 : toCents(f.perBranch)
  const percentBps = f.percent === '' ? 0 : toBps(f.percent)
  const minimumCents = f.minimum === '' ? 0 : toCents(f.minimum)

  const errors = {}
  if (!f.name.trim()) errors.name = 'Name the plan'
  if (isNew && !/^[a-z0-9-]{2,40}$/.test(f.code)) errors.code = 'Lowercase letters, digits and dashes'
  if ((f.model === 'FLAT' || f.model === 'ONE_TIME' || f.model === 'PER_BRANCH') && priceCents == null) errors.price = 'Enter an amount in shillings'
  if (f.model === 'PER_BRANCH' && !(perBranchCents > 0)) errors.perBranch = 'Enter the price per branch'
  if (f.model === 'PERCENT_OF_SALES' && !(percentBps >= 1 && percentBps <= 5000)) errors.percent = 'Between 0.01% and 50%'
  if (f.model === 'PERCENT_OF_SALES' && minimumCents == null) errors.minimum = 'Enter an amount in shillings'
  if (!(Number(f.trialDays) >= 0 && Number(f.trialDays) <= 365)) errors.trialDays = '0 to 365 days'
  const fe = error?.fields ?? {}

  const preview = priceText({ model: f.model, interval: f.interval, priceCents: priceCents ?? 0, perBranchCents: perBranchCents ?? 0, percentBps: percentBps ?? 0, minimumCents: minimumCents ?? 0 })

  const submit = async e => {
    e.preventDefault()
    if (Object.keys(errors).length) return
    const body = {
      name: f.name.trim(),
      description: f.description.trim() || null,
      model: f.model,
      interval: f.interval,
      priceCents: f.model === 'PERCENT_OF_SALES' ? 0 : priceCents,
      perBranchCents: f.model === 'PER_BRANCH' ? perBranchCents : 0,
      percentBps: f.model === 'PERCENT_OF_SALES' ? percentBps : 0,
      minimumCents: f.model === 'PERCENT_OF_SALES' ? minimumCents : 0,
      trialDays: Number(f.trialDays),
      maxBranches: num(f.maxBranches),
      maxStaff: num(f.maxStaff),
      maxProducts: num(f.maxProducts),
      public: f.public,
      sortOrder: Number(f.sortOrder) || 0
    }
    const r = await run(() => (isNew ? api.createPlan({ ...body, code: f.code }) : api.updatePlan(plan.id, body)), isNew ? 'Plan created' : 'Plan saved')
    if (r) onDone()
  }

  return (
    <Dialog title={isNew ? 'New plan' : `Edit ${plan.name}`} subtitle={isNew ? null : 'Price changes apply to future invoices only.'} onClose={onClose} busy={busy} size="lg"
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button kind="primary" type="submit" form="cx-plan-form" busy={busy}>{isNew ? 'Create plan' : 'Save plan'}</Button></>}>
      <form id="cx-plan-form" onSubmit={submit} noValidate className="cx-form">
        <div className="cx-form-grid">
          <Field label="Name" error={errors.name ?? fe.name}>
            <input className="cx-input" value={f.name} onChange={e => { const v = e.target.value; setF(x => ({ ...x, name: v, code: codeTouched ? x.code : v.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) })) }} autoFocus />
          </Field>
          <Field label="Code" hint={isNew ? 'Used in exports. Cannot change later.' : 'Cannot be changed'} error={(isNew ? errors.code : null) ?? fe.code}>
            <input className="cx-input cx-num" value={f.code} disabled={!isNew} onChange={e => { setCodeTouched(true); setF(x => ({ ...x, code: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })) }} />
          </Field>
          <Field label="Description (optional)" className="cx-span-2"><input className="cx-input" maxLength={300} value={f.description} onChange={set('description')} /></Field>
        </div>

        <fieldset>
          <legend>Pricing</legend>
          <div className="cx-radio-grid" role="radiogroup" aria-label="Pricing model">
            {MODELS.map(([k, label, hint]) => (
              <label key={k} className={'cx-radio' + (f.model === k ? ' is-on' : '')}>
                <input type="radio" name="model" checked={f.model === k} onChange={() => pickModel(k)} />
                <span><b>{label}</b><small className="cx-muted cx-block">{hint}</small></span>
              </label>
            ))}
          </div>
          <div className="cx-form-grid">
            {(f.model === 'FLAT' || f.model === 'PER_BRANCH') && (
              <Field label="Billed">
                <select className="cx-select" value={f.interval} onChange={set('interval')}>
                  <option value="MONTH">Monthly</option>
                  <option value="YEAR">Yearly</option>
                </select>
              </Field>
            )}
            {(f.model === 'FLAT' || f.model === 'ONE_TIME') && (
              <Field label="Price (KSh, before VAT)" error={errors.price ?? fe.priceCents}><input className="cx-input cx-num" inputMode="decimal" value={f.price} onChange={set('price')} /></Field>
            )}
            {f.model === 'PER_BRANCH' && (
              <>
                <Field label="Base fee (KSh, optional)" error={errors.price ?? fe.priceCents}><input className="cx-input cx-num" inputMode="decimal" value={f.price} onChange={set('price')} placeholder="0" /></Field>
                <Field label="Per branch (KSh)" error={errors.perBranch ?? fe.perBranchCents}><input className="cx-input cx-num" inputMode="decimal" value={f.perBranch} onChange={set('perBranch')} /></Field>
              </>
            )}
            {f.model === 'PERCENT_OF_SALES' && (
              <>
                <Field label="Share of sales (%)" error={errors.percent ?? fe.percentBps}><input className="cx-input cx-num" inputMode="decimal" value={f.percent} onChange={set('percent')} placeholder="1.5" /></Field>
                <Field label="Monthly minimum (KSh)" error={errors.minimum ?? fe.minimumCents}><input className="cx-input cx-num" inputMode="decimal" value={f.minimum} onChange={set('minimum')} placeholder="0" /></Field>
              </>
            )}
          </div>
          <p className="cx-price-preview" aria-live="polite"><span className="cx-muted">Clients see:</span> {preview}{f.model === 'PERCENT_OF_SALES' ? ', billed after each month' : ''}</p>
        </fieldset>

        <fieldset>
          <legend>Limits and trial</legend>
          <div className="cx-form-grid cx-form-grid-4">
            <Field label="Branches" hint="Empty for no limit"><input className="cx-input cx-num" inputMode="numeric" value={f.maxBranches} onChange={digits('maxBranches')} /></Field>
            <Field label="Staff" hint="Empty for no limit"><input className="cx-input cx-num" inputMode="numeric" value={f.maxStaff} onChange={digits('maxStaff')} /></Field>
            <Field label="Products" hint="Empty for no limit"><input className="cx-input cx-num" inputMode="numeric" value={f.maxProducts} onChange={digits('maxProducts')} /></Field>
            <Field label="Trial days" error={errors.trialDays ?? fe.trialDays}><input className="cx-input cx-num" inputMode="numeric" value={f.trialDays} onChange={digits('trialDays')} /></Field>
          </div>
          <label className="cx-check">
            <input type="checkbox" checked={f.public} onChange={set('public')} />
            <span>Public plan. Turn off for negotiated deals that only the team can assign.</span>
          </label>
        </fieldset>
        {error && !Object.keys(fe).length && <p className="cx-form-error" role="alert">{error.message}</p>}
      </form>
    </Dialog>
  )
}
