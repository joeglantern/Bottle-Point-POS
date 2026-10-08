import { Fragment, useEffect, useRef, useState } from 'react'
import { applyBrand, contrast, logoFromFile, paletteFrom } from '../brand.js'
import { api, qs } from '../api.js'
import { useApi, useSession } from '../session.jsx'
import { Empty, ErrorNote, Field, Icon, Loading, Modal, ago, dateOf, ksh, kshExact, timeOf, todayNairobi, useAction } from '../ui.jsx'

// Settings for the owner of a business: how it appears on receipts, its own
// M-Pesa, what Bottle Point bills it, signed in devices, the activity log and
// data exports.

const SECTIONS = [
  ['business', 'Business'],
  ['mpesa', 'M-Pesa'],
  ['billing', 'Billing'],
  ['devices', 'Devices'],
  ['activity', 'Activity'],
  ['exports', 'Exports']
]

export default function Admin({ initial = 'business' }) {
  const [section, setSection] = useState(initial)
  return (
    <div className="page admin">
      <div className="page-head">
        <h2>Settings</h2>
        <p className="muted">Only the owner sees this.</p>
      </div>
      <div className="admin-tabs" role="tablist" aria-label="Settings sections">
        {SECTIONS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={section === k} className={section === k ? 'on' : ''} onClick={() => setSection(k)}>{l}</button>
        ))}
      </div>
      <div className="admin-body">
        {section === 'business' && <><BrandSetting /><BusinessSection /><StockSetting /><MpesaCodeSetting /></>}
        {section === 'mpesa' && <MpesaSection />}
        {section === 'billing' && <BillingSection />}
        {section === 'devices' && <><DevicesSection /><TillsSection /></>}
        {section === 'activity' && <ActivitySection />}
        {section === 'exports' && <ExportsSection />}
      </div>
    </div>
  )
}

// ---------- business details ----------

function BusinessSection() {
  const res = useApi('/admin/business')
  const [f, setF] = useState(null)
  const [run, busy] = useAction()
  const [errors, setErrors] = useState({})
  const b = res.data?.business

  useEffect(() => {
    if (b) setF({ name: b.name ?? '', legalName: b.legalName ?? '', email: b.email ?? '', phone: b.phone ?? '', address: b.address ?? '', kraPin: b.kraPin ?? '', receiptFooter: b.receiptFooter ?? '', vat: String((b.vatRateBps ?? 1600) / 100) })
  }, [b])

  if (res.error && !b) return <ErrorNote error={res.error} onRetry={res.reload} />
  if (!f) return <Loading />

  const set = k => e => setF(x => ({ ...x, [k]: e.target.value }))
  const vatBps = Math.round(Number(f.vat) * 100)
  const local = {}
  if (f.name.trim().length < 2) local.name = 'At least 2 characters'
  if (f.kraPin && !/^[A-Za-z]\d{9}[A-Za-z]$/.test(f.kraPin.trim())) local.kraPin = 'A letter, 9 digits and a letter'
  if (!(vatBps >= 0 && vatBps <= 5000) || f.vat === '') local.vat = 'Between 0 and 50'
  const err = k => local[k] ?? errors[k]

  const save = async e => {
    e.preventDefault()
    if (Object.keys(local).length) return
    setErrors({})
    const r = await run(
      async () => {
        const out = await api.patch('/admin/business', {
          name: f.name.trim(),
          legalName: f.legalName,
          email: f.email,
          phone: f.phone,
          address: f.address,
          kraPin: f.kraPin,
          receiptFooter: f.receiptFooter,
          vatRateBps: vatBps
        })
        res.setData(out)
      },
      'Business details saved',
      e => {
        const fe = e.details?.fieldErrors
        if (!fe) return false
        setErrors(Object.fromEntries(Object.entries(fe).map(([k, v]) => [k === 'vatRateBps' ? 'vat' : k, v[0]])))
        return true
      }
    )
    return r
  }

  return (
    <form className="admin-grid" onSubmit={save} noValidate>
      <section className="card">
        <h4>On every receipt</h4>
        <div className="split-grid">
          <Field label="Business name">
            <input className="label-in" value={f.name} onChange={set('name')} maxLength={80} />
            {err('name') && <small className="field-err">{err('name')}</small>}
          </Field>
          <Field label="Registered name (optional)" hint="If it differs from the shop name">
            <input className="label-in" value={f.legalName} onChange={set('legalName')} maxLength={120} />
          </Field>
          <Field label="Phone">
            <input className="label-in" value={f.phone} onChange={set('phone')} inputMode="tel" maxLength={40} />
          </Field>
          <Field label="Email">
            <input className="label-in" value={f.email} onChange={set('email')} inputMode="email" autoCapitalize="none" maxLength={120} />
            {err('email') && <small className="field-err">{err('email')}</small>}
          </Field>
        </div>
        <Field label="Address">
          <input className="label-in" value={f.address} onChange={set('address')} maxLength={200} />
        </Field>
        <Field label="Message at the bottom of the receipt" hint="For example opening hours or your returns policy">
          <input className="label-in" value={f.receiptFooter} onChange={set('receiptFooter')} maxLength={200} />
        </Field>
      </section>
      <section className="card">
        <h4>Tax</h4>
        <Field label="KRA PIN" hint="Printed on receipts when set">
          <input className="label-in mono" value={f.kraPin} onChange={e => setF(x => ({ ...x, kraPin: e.target.value.toUpperCase() }))} maxLength={11} autoCapitalize="characters" />
          {err('kraPin') && <small className="field-err">{err('kraPin')}</small>}
        </Field>
        <Field label="VAT included in prices (%)" hint="16 for most shops. 0 if the business is not registered for VAT.">
          <input className="label-in mono" inputMode="decimal" value={f.vat} onChange={set('vat')} />
          {err('vat') && <small className="field-err">{err('vat')}</small>}
        </Field>
        <button className="gold wide" type="submit" disabled={busy}>{busy ? 'Saving...' : 'Save details'}</button>
      </section>
    </form>
  )
}

// ---------- M-Pesa ----------

const MODES = [
  ['MOCK', 'Simulation', 'For training only. No real money moves, so the till hides the prompt on the live site.'],
  ['SANDBOX', 'Safaricom sandbox', 'Safaricom test system, with test credentials.'],
  ['PRODUCTION', 'Live', 'Real payments to your Paybill or Till.']
]

function MpesaSection() {
  const res = useApi('/admin/mpesa')
  const c = res.data?.config
  const [f, setF] = useState(null)
  const [run, busy] = useAction()
  const [test, setTest] = useState(null)
  const [testing, setTesting] = useState(false)
  const [wipe, setWipe] = useState(false)

  useEffect(() => {
    if (c) setF({ enabled: c.enabled, mode: c.mode, transactionType: c.transactionType, shortcode: c.shortcode ?? '', partyB: c.partyB ?? '', consumerKey: '', consumerSecret: '', passkey: '' })
  }, [c])

  if (res.error && !c) return <ErrorNote error={res.error} onRetry={res.reload} />
  if (!f) return <Loading />

  const set = k => e => setF(x => ({ ...x, [k]: e.target.value }))
  const till = f.transactionType === 'CustomerBuyGoodsOnline'
  const live = f.mode !== 'MOCK'

  const save = e => {
    e.preventDefault()
    run(async () => {
      const out = await api.put('/admin/mpesa', {
        enabled: f.enabled,
        mode: f.mode,
        transactionType: f.transactionType,
        shortcode: f.shortcode || null,
        partyB: till ? f.partyB || null : null,
        consumerKey: f.consumerKey || null,
        consumerSecret: f.consumerSecret || null,
        passkey: f.passkey || null
      })
      res.setData(out)
      setTest(null)
    }, 'M-Pesa settings saved')
  }

  const runTest = async () => {
    setTesting(true)
    try { setTest(await api.post('/admin/mpesa/test')) } catch (e) { setTest({ ok: false, message: e.message }) } finally { setTesting(false) }
  }

  const doWipe = () => run(async () => { res.setData(await api.del('/admin/mpesa/secrets')); setWipe(false) }, 'Keys removed and M-Pesa switched off')

  return (
    <form className="admin-grid" onSubmit={save} noValidate>
      <section className="card">
        <h4>How customers pay you</h4>
        <label className="toggle">
          <input type="checkbox" checked={f.enabled} onChange={e => setF(x => ({ ...x, enabled: e.target.checked }))} />
          <span />Use these settings for M-Pesa prompts
        </label>
        {(!f.enabled || !live) && <p className="muted small">The till does not send M-Pesa prompts until you switch this on with your own Paybill or Till keys. Until then cashiers take cash or type the M-Pesa code from the customer's message, which a manager checks against the statement.</p>}
        <div className="choice-list" role="radiogroup" aria-label="Mode">
          {MODES.map(([k, l, hint]) => (
            <label key={k} className={'choice' + (f.mode === k ? ' on' : '')}>
              <input type="radio" name="mode" checked={f.mode === k} onChange={() => setF(x => ({ ...x, mode: k }))} />
              <span><b>{l}</b><small>{hint}</small></span>
            </label>
          ))}
        </div>
        <Field label="Account type">
          <div className="seg two">
            <button type="button" className={!till ? 'on' : ''} onClick={() => setF(x => ({ ...x, transactionType: 'CustomerPayBillOnline' }))}>Paybill</button>
            <button type="button" className={till ? 'on' : ''} onClick={() => setF(x => ({ ...x, transactionType: 'CustomerBuyGoodsOnline' }))}>Buy Goods till</button>
          </div>
        </Field>
        <div className="split-grid">
          <Field label={till ? 'Store number (head office)' : 'Paybill number'} hint="The shortcode from Safaricom">
            <input className="label-in mono" inputMode="numeric" value={f.shortcode} onChange={e => setF(x => ({ ...x, shortcode: e.target.value.replace(/\D/g, '').slice(0, 7) }))} />
          </Field>
          {till && (
            <Field label="Till number" hint="Where the money lands">
              <input className="label-in mono" inputMode="numeric" value={f.partyB} onChange={e => setF(x => ({ ...x, partyB: e.target.value.replace(/\D/g, '').slice(0, 10) }))} />
            </Field>
          )}
        </div>
      </section>

      <section className="card">
        <h4>Daraja keys</h4>
        <p className="muted small">From your app on the Safaricom developer portal. They are stored encrypted and never shown again. Leave a box empty to keep the saved one.</p>
        <Field label="Consumer key" hint={c.consumerKeyHint ? `Saved: ${c.consumerKeyHint}` : 'Not saved'}>
          <input className="label-in mono" value={f.consumerKey} onChange={set('consumerKey')} autoComplete="off" spellCheck={false} disabled={!live} />
        </Field>
        <Field label="Consumer secret" hint={c.consumerSecretHint ? `Saved: ${c.consumerSecretHint}` : 'Not saved'}>
          <input className="label-in mono" type="password" value={f.consumerSecret} onChange={set('consumerSecret')} autoComplete="new-password" disabled={!live} />
        </Field>
        <Field label="Passkey" hint={c.passkeyHint ? `Saved: ${c.passkeyHint}` : 'Not saved'}>
          <input className="label-in mono" type="password" value={f.passkey} onChange={set('passkey')} autoComplete="new-password" disabled={!live} />
        </Field>
        <div className="admin-actions">
          <button className="gold" type="submit" disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
          <button className="outline" type="button" disabled={testing} onClick={runTest}>{testing ? 'Testing...' : 'Test connection'}</button>
        </div>
        {test && <div className={'test-result ' + (test.ok ? 'ok' : 'bad')} role="status">{test.message}</div>}
        {(c.consumerKeyHint || c.consumerSecretHint || c.passkeyHint) && (
          <button type="button" className="ghost danger" onClick={() => setWipe(true)}>Remove the saved keys</button>
        )}
        {c.updatedAt && <p className="muted small">Last changed {dateOf(c.updatedAt)} at {timeOf(c.updatedAt)}.</p>}
      </section>
      {wipe && (
        <Modal title="Remove the saved keys?" onClose={() => setWipe(false)}>
          <p>The consumer key, secret and passkey are deleted and M-Pesa prompts switch off until new keys are saved. Typed codes keep working.</p>
          <button className="gold wide" disabled={busy} onClick={doWipe}>Remove keys</button>
        </Modal>
      )}
    </form>
  )
}

// ---------- billing ----------

const SUB_LABEL = { TRIALING: 'Free trial', ACTIVE: 'Active', PAST_DUE: 'Payment overdue', SUSPENDED: 'Suspended', CANCELLED: 'Cancelled' }

function BillingSection() {
  const res = useApi('/admin/billing')
  const [open, setOpen] = useState(null)
  const d = res.data
  if (res.error && !d) return <ErrorNote error={res.error} onRetry={res.reload} />
  if (!d) return <Loading />
  const s = d.subscription

  return (
    <div className="admin-grid">
      <section className="card">
        <h4>Your plan</h4>
        {!s ? (
          <p className="muted">You are not on a paid plan. Bottle Point has not set up billing for this account.</p>
        ) : (
          <>
            <div className="plan-head">
              <b>{d.plan?.name}</b>
              <span className={'tag ' + (s.status === 'ACTIVE' ? 'ok' : s.status === 'TRIALING' ? 'saved' : 'cancelled')}>{SUB_LABEL[s.status] ?? s.status}</span>
            </div>
            <p className="muted">{d.plan?.priceText}{s.discountBps ? `, ${s.discountBps / 100}% discount` : ''}</p>
            {s.status === 'TRIALING' && s.trialEndsAt && <p>Your trial ends on <b>{dateOf(s.trialEndsAt)}</b>.</p>}
            {s.status === 'SUSPENDED' && <p className="warn-note">{s.suspendedReason ?? 'This account is suspended.'} Settle the outstanding invoice or contact Bottle Point support.</p>}
            {s.cancelAtPeriodEnd && <p className="warn-note">The subscription ends on {dateOf(s.currentPeriodEnd)}.</p>}
          </>
        )}
        <div className="usage-list">
          <Usage label="Branches" used={d.usage.branches} max={d.plan?.limits?.maxBranches} />
          <Usage label="Staff" used={d.usage.staff} max={d.plan?.limits?.maxStaff} />
          <Usage label="Products" used={d.usage.products} max={d.plan?.limits?.maxProducts} />
        </div>
      </section>
      <section className="card">
        <h4>Money</h4>
        <div className="kv"><span>Owed now</span><b className={d.outstandingCents ? 'gold-t' : ''}>{kshExact(d.outstandingCents)}</b></div>
        {d.nextInvoice && (
          <>
            <div className="kv"><span>Next invoice</span><b>{kshExact(d.nextInvoice.totalCents)}</b></div>
            <p className="muted small">For {dateOf(d.nextInvoice.periodStart)} to {dateOf(d.nextInvoice.periodEnd)}, raised on {dateOf(d.nextInvoice.issuedOn)}.{d.nextInvoice.note ? ' ' + d.nextInvoice.note : ''}</p>
          </>
        )}
        <h4 className="mt">Invoices</h4>
        {!d.invoices.length ? <Empty>No invoices yet.</Empty> : (
          <table className="cards-sm">
            <thead><tr><th>Invoice</th><th>Period</th><th className="r">Total</th><th>Status</th></tr></thead>
            <tbody>
              {d.invoices.map(i => (
                <tr key={i.id} className="click" onClick={() => setOpen(i.id)}>
                  <td data-label="Invoice" className="mono">{i.number}</td>
                  <td data-label="Period">{dateOf(i.periodStart)} to {dateOf(i.periodEnd)}</td>
                  <td data-label="Total" className="r">{kshExact(i.totalCents)}</td>
                  <td data-label="Status"><span className={'tag ' + (i.status === 'PAID' ? 'ok' : i.overdue ? 'cancelled' : 'saved')}>{i.status === 'OPEN' ? (i.overdue ? 'overdue' : 'due') : i.status.toLowerCase()}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {open && <InvoiceModal id={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

function Usage({ label, used, max }) {
  const pct = max ? Math.min(100, Math.round((used / max) * 100)) : 0
  return (
    <div className="usage">
      <div className="kv"><span>{label}</span><b>{used}{max != null ? ` of ${max}` : ''}</b></div>
      {max != null && <div className="track"><i style={{ width: pct + '%' }} /></div>}
    </div>
  )
}

function InvoiceModal({ id, onClose }) {
  const res = useApi('/admin/billing/invoices/' + id)
  const inv = res.data?.invoice
  return (
    <Modal title={inv ? inv.number : 'Invoice'} eyebrow="From Bottle Point" onClose={onClose} wide>
      {res.error ? <ErrorNote error={res.error} /> : !inv ? <Loading /> : (
        <div className="invoice-view">
          <div className="kv"><span>Period</span><b>{dateOf(inv.periodStart)} to {dateOf(inv.periodEnd)}</b></div>
          <div className="kv"><span>Due</span><b>{dateOf(inv.dueAt)}</b></div>
          <table>
            <thead><tr><th>Description</th><th className="r">Amount</th></tr></thead>
            <tbody>{inv.lines.map((l, i) => <tr key={i}><td>{l.description}{l.quantity > 1 ? ` (${l.quantity})` : ''}</td><td className="r">{kshExact(l.amountCents)}</td></tr>)}</tbody>
          </table>
          <div className="kv"><span>Subtotal</span><b>{kshExact(inv.subtotalCents)}</b></div>
          <div className="kv"><span>VAT</span><b>{kshExact(inv.taxCents)}</b></div>
          <div className="kv total"><span>Total</span><b>{kshExact(inv.totalCents)}</b></div>
          <div className="kv"><span>Paid</span><b>{kshExact(inv.paidCents)}</b></div>
          {inv.status === 'OPEN' && <div className="kv"><span>Balance</span><b className="gold-t">{kshExact(inv.balanceCents)}</b></div>}
          {inv.payments.length > 0 && (
            <>
              <h4 className="mt">Payments received</h4>
              {inv.payments.map(p => <div key={p.id} className="kv"><span>{dateOf(p.receivedAt)}, {p.method === 'MPESA' ? 'M-Pesa' : p.method.toLowerCase()}{p.reference ? ` ${p.reference}` : ''}</span><b>{kshExact(p.amountCents)}</b></div>)}
            </>
          )}
        </div>
      )}
    </Modal>
  )
}

// ---------- devices ----------

function DevicesSection() {
  const res = useApi('/admin/sessions')
  const [run, busy] = useAction()
  const list = res.data?.sessions ?? []
  const signOut = s => run(async () => { await api.del('/admin/sessions/' + s.id); res.reload() }, `${s.device} signed out`)

  if (res.error && !res.data) return <ErrorNote error={res.error} onRetry={res.reload} />
  if (!res.data) return <Loading />
  return (
    <section className="card">
      <h4>Signed in now</h4>
      <p className="muted small">Every phone, tablet and computer signed in to your business. Sign out one you do not recognise, or a lost device. To lock a person out everywhere, switch them off under Staff.</p>
      {!list.length ? <Empty>No one is signed in.</Empty> : (
        <table className="cards-sm">
          <thead><tr><th>Device</th><th>Person</th><th>Last active</th><th>Since</th><th></th></tr></thead>
          <tbody>
            {list.map(s => (
              <tr key={s.id}>
                <td data-label="Device"><b>{s.device}</b>{s.current && <span className="tag ok"> this device</span>}{s.ip && <small className="muted block mono">{s.ip}</small>}</td>
                <td data-label="Person">{s.user.name} <small className="muted">{s.user.role.toLowerCase()}</small></td>
                <td data-label="Last active">{ago(s.lastSeenAt)}</td>
                <td data-label="Since">{dateOf(s.createdAt)}</td>
                <td className="r">{!s.current && <button className="mini" disabled={busy} onClick={() => signOut(s)}>Sign out</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

// Browsers registered as tills. Each can sell without internet and send those
// sales later with its own key. Remove a lost or retired one: anything it
// still holds can then no longer be sent.
function TillsSection() {
  const res = useApi('/offline/devices')
  const [run, busy] = useAction()
  const list = (res.data?.devices ?? []).filter(d => !d.revokedAt)
  const remove = d =>
    window.confirm(`Remove till ${d.code}? It can no longer send sales made offline. Only do this for a lost or retired till.`) &&
    run(async () => { await api.post(`/offline/devices/${d.id}/revoke`); res.reload() }, `Till ${d.code} removed`)
  if (res.error && !res.data) return <ErrorNote error={res.error} onRetry={res.reload} />
  if (!res.data) return <Loading />
  return (
    <section className="card">
      <h4>Tills</h4>
      <p className="muted small">Each browser used as a till gets a code (T1, T2...) the first time someone signs in on it. It keeps selling without internet and sends those sales when the connection is back. Receipts printed offline carry this code.</p>
      {!list.length ? <Empty>No tills yet.</Empty> : (
        <table className="cards-sm">
          <thead><tr><th>Till</th><th>Set up by</th><th>Last synced</th><th>Since</th><th></th></tr></thead>
          <tbody>
            {list.map(d => (
              <tr key={d.id}>
                <td data-label="Till"><b>{d.code}</b>{d.name && <small className="muted block">{d.name}</small>}</td>
                <td data-label="Set up by">{d.createdBy ?? ''}</td>
                <td data-label="Last synced">{d.lastSeenAt ? ago(d.lastSeenAt) : 'Never'}</td>
                <td data-label="Since">{dateOf(d.createdAt)}</td>
                <td className="r"><button className="mini" disabled={busy} onClick={() => remove(d)}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

// The shop's own logo and colour. The logo shows on the till, the sign in
// screen and receipts only once uploaded; the colour replaces Bottle Point's
// brass on buttons and highlights, picked from the logo or chosen freely.
const BRASS = '#c9a45c'

function BrandSetting() {
  const { branding, refresh } = useSession()
  const [run, busy] = useAction()
  const [swatches, setSwatches] = useState([])
  const [picked, setPicked] = useState(branding?.accent ?? null)
  const [err, setErr] = useState('')
  const file = useRef(null)
  const saved = branding?.accent ?? null
  const logo = branding?.logoUrl ?? null

  // colours the logo suggests
  useEffect(() => {
    let live = true
    if (!logo) { setSwatches([]); return }
    paletteFrom(logo).then(s => live && setSwatches(s), () => live && setSwatches([]))
    return () => { live = false }
  }, [logo])
  useEffect(() => { setPicked(saved) }, [saved])
  // preview while choosing; back to what is saved when leaving
  useEffect(() => { applyBrand(picked) }, [picked])
  useEffect(() => () => applyBrand(saved), [saved])

  const upload = async e => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setErr('')
    let image
    try { image = await logoFromFile(f) } catch (x) { setErr(x.message); return }
    run(async () => {
      await api.put('/admin/business/logo', { image })
      await refresh()
    }, 'Logo saved')
  }
  const remove = () =>
    window.confirm('Remove the logo? The till and receipts show the shop name instead.') &&
    run(async () => { await api.del('/admin/business/logo'); await refresh() }, 'Logo removed')
  const saveColour = () =>
    run(async () => { await api.patch('/admin/business', { brandColor: picked }); await refresh() }, picked ? 'Colour saved' : 'Back to Bottle Point brass')

  const options = [...new Set([...swatches, ...(saved && !swatches.includes(saved) ? [saved] : [])])]
  const weak = picked && contrast(picked, '#ffffff') < 1.6 && contrast(picked, '#09090a') < 3

  return (
    <section className="card brand-card">
      <h4>Your brand</h4>
      <p className="muted small">Your logo shows at the top of the till, on the sign in screen and on receipts. Until you upload one, your shop name shows instead. Bottle Point stays small in a corner.</p>
      <div className="brand-logos">
        <div className="brand-tile dark">{logo ? <img src={logo} alt="Your logo on dark" /> : <span>{branding?.name}</span>}</div>
        <div className="brand-tile light">{logo ? <img src={logo} alt="Your logo on light" /> : <span>{branding?.name}</span>}</div>
      </div>
      <div className="admin-actions">
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={upload} />
        <button type="button" className="outline" disabled={busy} onClick={() => file.current?.click()}>{logo ? 'Replace logo' : 'Upload logo'}</button>
        {logo && <button type="button" className="ghost danger" disabled={busy} onClick={remove}>Remove</button>}
      </div>
      <p className="muted small">PNG, JPEG or WebP. A logo on a transparent background looks best on both light and dark screens.</p>
      {err && <p className="form-problem">{err}</p>}

      <h4 className="brand-sub">Colour</h4>
      <p className="muted small">{swatches.length ? 'Colours from your logo. Pick one to see it across the till, then save.' : logo ? 'Your logo has no strong colour. Pick any colour below.' : 'Upload your logo to get colours from it, or pick any colour.'}</p>
      <div className="swatches" role="radiogroup" aria-label="Till colour">
        <button type="button" role="radio" aria-checked={!picked} className={'swatch brass' + (!picked ? ' on' : '')} onClick={() => setPicked(null)} title="Bottle Point brass">
          <span style={{ background: BRASS }} /><small>Brass</small>
        </button>
        {options.map(c => (
          <button type="button" role="radio" aria-checked={picked === c} key={c} className={'swatch' + (picked === c ? ' on' : '')} onClick={() => setPicked(c)} title={c}>
            <span style={{ background: c }} /><small>{c}</small>
          </button>
        ))}
        <label className="swatch custom" title="Any colour">
          <input type="color" value={picked ?? BRASS} onChange={e => setPicked(e.target.value.toLowerCase())} aria-label="Pick any colour" />
          <small>Other</small>
        </label>
      </div>
      <div className="brand-preview" aria-hidden="true">
        <span className="gold brand-btn">Pay now</span>
        <span className="badge">3</span>
        <span className="tag saved">Saved</span>
        <span className="brand-link">A link</span>
      </div>
      {weak && <p className="muted small">This colour is very light or very dark; text on it is adjusted to stay readable.</p>}
      <div className="admin-actions">
        <button type="button" className="gold" disabled={busy || picked === saved} onClick={saveColour}>Save colour</button>
        {picked !== saved && <button type="button" className="ghost" onClick={() => setPicked(saved)}>Undo</button>}
      </div>
    </section>
  )
}

// Whether the shop counts its bottles. Off suits a shop that has not counted
// yet: the till shows no stock levels and nothing is ever out of stock. Sales
// still record what was sold, so switching on later only needs one count.
function StockSetting() {
  const { user, refresh } = useSession()
  const [run, busy] = useAction()
  const on = user.trackStock !== false
  const flip = () =>
    run(async () => {
      await api.patch('/admin/business', { trackStock: !on })
      await refresh()
    }, on ? 'Stock tracking switched off' : 'Stock tracking switched on')
  return (
    <section className="card">
      <h4>Stock</h4>
      <label className="toggle">
        <input type="checkbox" checked={on} disabled={busy} onChange={flip} />
        <span />
        Track stock levels
      </label>
      <p className="muted small">
        {on
          ? 'The till shows how many of each product are left, warns when one runs low, and marks it out of stock at zero.'
          : 'Off: the till shows no stock levels and never says out of stock. Sales still record what was sold. To switch on, count the shelves first (Inventory, Count), then switch this on.'}
      </p>
    </section>
  )
}

// Whether an M-Pesa payment needs its transaction code at the till. Off suits a
// shop whose M-Pesa is not connected: cashiers record M-Pesa by amount, and a
// manager checks each one against the statement.
function MpesaCodeSetting() {
  const { user, refresh } = useSession()
  const [run, busy] = useAction()
  const on = user.requireMpesaCode !== false
  const flip = () =>
    run(async () => {
      await api.patch('/admin/business', { requireMpesaCode: !on })
      await refresh()
    }, on ? 'M-Pesa code no longer required' : 'M-Pesa code required')
  return (
    <section className="card">
      <h4>M-Pesa at the till</h4>
      <label className="toggle">
        <input type="checkbox" checked={on} disabled={busy} onChange={flip} />
        <span />
        Require the M-Pesa code
      </label>
      <p className="muted small">
        {on
          ? "Cashiers type the code from the customer's M-Pesa message for every M-Pesa payment (unless the prompt confirmed it)."
          : 'Off: cashiers record an M-Pesa payment by its amount, and may type the code. Every one appears under Typed M-Pesa codes to check, so a manager can match it with the statement. Switch this on once M-Pesa is connected.'}
      </p>
    </section>
  )
}

// ---------- activity ----------

const GROUPS = [['', 'Everything'], ['sales', 'Sales'], ['payments', 'Payments'], ['stock', 'Stock'], ['staff', 'Staff'], ['settings', 'Settings'], ['signin', 'Sign ins']]

function ActivitySection() {
  const [group, setGroup] = useState('')
  const [rows, setRows] = useState([])
  const [next, setNext] = useState(null)
  const [state, setState] = useState({ loading: true, error: null })
  const [open, setOpen] = useState(null)

  const load = async (before = null) => {
    setState({ loading: true, error: null })
    try {
      const r = await api.get('/admin/audit' + qs({ group, before, limit: 50 }))
      setRows(x => (before ? [...x, ...r.entries] : r.entries))
      setNext(r.nextBefore)
      setState({ loading: false, error: null })
    } catch (error) {
      setState({ loading: false, error })
    }
  }
  useEffect(() => { load() }, [group])

  return (
    <section className="card">
      <h4>Activity log</h4>
      <p className="muted small">Everything that changed in your business, newest first. It cannot be edited or deleted.</p>
      <div className="chips">
        {GROUPS.map(([k, l]) => <button key={k || 'all'} className={group === k ? 'on' : ''} onClick={() => setGroup(k)}>{l}</button>)}
      </div>
      <ErrorNote error={state.error} onRetry={() => load()} />
      {!rows.length && state.loading ? <Loading /> : !rows.length ? <Empty>Nothing recorded yet.</Empty> : (
        <ol className="activity">
          {rows.map(r => (
            <Fragment key={r.id}>
              <li>
                <button className="activity-row" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                  <span className="activity-when"><b>{timeOf(r.at)}</b><small>{dateOf(r.at)}</small></span>
                  <span className="activity-what">{r.summary}{r.branch && <small className="muted"> {r.branch.name}</small>}</span>
                </button>
                {open === r.id && r.data && <pre className="activity-data">{JSON.stringify(r.data, null, 2)}</pre>}
              </li>
            </Fragment>
          ))}
        </ol>
      )}
      {next && <button className="outline wide" disabled={state.loading} onClick={() => load(next)}>{state.loading ? 'Loading...' : 'Show older'}</button>}
    </section>
  )
}

// ---------- exports ----------

const EXPORTS = [
  ['sales', 'Sales', 'One row per sale: totals, who served, how it was paid', true],
  ['sale-lines', 'Items sold', 'One row per item on every sale', true],
  ['payments', 'Payments', 'Every cash and M-Pesa payment, with codes', true],
  ['stock', 'Stock now', 'Current quantities and value in every branch', false],
  ['products', 'Products', 'Your full product list with prices and barcodes', false]
]

function ExportsSection() {
  const { branches } = useSession()
  const today = todayNairobi()
  const [from, setFrom] = useState(today.slice(0, 8) + '01')
  const [to, setTo] = useState(today)
  const [branchId, setBranchId] = useState('')
  const badRange = !from || !to || from > to
  const href = (kind, ranged) => '/api/admin/export/' + kind + '.csv' + qs(ranged ? { from, to, branchId } : { branchId })

  return (
    <section className="card">
      <h4>Download your data</h4>
      <p className="muted small">CSV files that open in Excel or Google Sheets. Dates are in Nairobi time and amounts in shillings.</p>
      <div className="export-filters">
        <Field label="From"><input type="date" className="date-in" value={from} max={to || today} onChange={e => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" className="date-in" value={to} min={from} max={today} onChange={e => setTo(e.target.value)} /></Field>
        {branches.length > 1 && (
          <Field label="Branch">
            <select className="label-in" value={branchId} onChange={e => setBranchId(e.target.value)}>
              <option value="">All branches</option>
              {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
        )}
      </div>
      {badRange && <p className="warn-note">Choose a start date on or before the end date.</p>}
      <div className="export-list">
        {EXPORTS.map(([kind, label, hint, ranged]) => (
          <a key={kind} className={'export-item' + (ranged && badRange ? ' disabled' : '')} href={ranged && badRange ? undefined : href(kind, ranged)} download aria-disabled={ranged && badRange}>
            <Icon k="download" />
            <span><b>{label}</b><small>{hint}{ranged ? '' : '. Not limited by dates.'}</small></span>
          </a>
        ))}
      </div>
    </section>
  )
}

// Small strip shown to everyone when the subscription needs attention.
export function BillingBanner({ status, onOpen }) {
  if (!status || !['TRIALING', 'PAST_DUE', 'SUSPENDED', 'CANCELLED'].includes(status.status)) return null
  if (status.status === 'TRIALING' && (status.daysLeftInTrial ?? 99) > 7) return null
  const text = {
    TRIALING: `Free trial: ${status.daysLeftInTrial} day${status.daysLeftInTrial === 1 ? '' : 's'} left.`,
    PAST_DUE: 'A Bottle Point invoice is overdue. Please settle it to avoid interruption.',
    SUSPENDED: status.suspendedReason ? `Account suspended: ${status.suspendedReason}` : 'This account is suspended.',
    CANCELLED: 'This subscription has ended.'
  }[status.status]
  return (
    <div className={'billing-banner ' + status.status.toLowerCase()} role="status">
      <span>{text}</span>
      {onOpen && <button className="mini" onClick={onOpen}>See billing</button>}
    </div>
  )
}

// Full screen when the shop cannot trade at all.
export function SuspendedScreen({ message, isOwner, onBilling, onSignOut }) {
  return (
    <div className="center-screen">
      <div className="modal static suspended">
        <img src="/brand/bottle-point-mark.png" alt="" width="40" />
        <h3 className="title-serif sm">Selling is paused</h3>
        <p>{message}</p>
        {isOwner ? <button className="gold wide" onClick={onBilling}>See billing</button> : <p className="muted">Ask the owner to contact Bottle Point.</p>}
        <button className="ghost" onClick={onSignOut}>Sign out</button>
      </div>
    </div>
  )
}
