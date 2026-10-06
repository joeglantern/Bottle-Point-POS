import { useState } from 'react'
import { api } from '../api.js'
import { ROLES, roleLabel, whyNot } from '../format.js'
import { useTitle } from '../router.js'
import { useSession } from '../session.js'
import { Button, ConfirmDialog, Dialog, ErrorState, Field, PageHeader, SecretDialog, Skeleton, StatusPill, When, useAction, useLoad } from '../ui.jsx'

const ROLE_HELP = {
  SUPER_ADMIN: 'Everything, including the team',
  SUPPORT: 'Clients, onboarding, suspensions, PINs and notes',
  BILLING: 'Plans, subscriptions, invoices and payments'
}

export default function Team() {
  useTitle('Team')
  const { can, user } = useSession()
  const res = useLoad(signal => api.listTeam({ signal }), [])
  const [dialog, setDialog] = useState(null)
  const [secret, setSecret] = useState(null)
  const manage = can('team.manage')
  const done = () => { setDialog(null); res.reload() }

  return (
    <>
      <PageHeader title="Team" actions={<Button kind="primary" icon="plus" onClick={() => setDialog({ kind: 'invite' })} disabled={!manage} title={manage ? undefined : whyNot('team.manage')}>Add someone</Button>}>
        <p className="cx-muted">People at Bottle Point who can sign in to this console.</p>
      </PageHeader>
      {res.error && !res.data ? <ErrorState error={res.error} onRetry={res.reload} /> : !res.data ? <Skeleton rows={4} cols={5} /> : (
        <div className="cx-table-wrap">
          <table className="cx-table cx-table-cards">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th className="cx-r">Last sign in</th><th><span className="cx-sr-only">Actions</span></th></tr></thead>
            <tbody>
              {res.data.team.map(m => (
                <tr key={m.id}>
                  <td className="cx-card-title"><b>{m.name}</b>{m.id === user.id && <small className="cx-muted"> (you)</small>}</td>
                  <td data-label="Email">{m.email}</td>
                  <td data-label="Role">{roleLabel(m.role)}</td>
                  <td data-label="Status">{!m.active ? <StatusPill status="OFF" /> : m.locked ? <StatusPill status="LOCKED" /> : <StatusPill status="ACTIVE" />}</td>
                  <td data-label="Last sign in" className="cx-r"><When at={m.lastSignInAt} mode="relative" /></td>
                  <td className="cx-r cx-actions">
                    {manage && m.id !== user.id && (
                      <>
                        <Button size="sm" onClick={() => setDialog({ kind: 'edit', m })}>Edit</Button>
                        <Button size="sm" onClick={() => setDialog({ kind: 'reset', m })}>New password</Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog?.kind === 'invite' && <InviteDialog onClose={() => setDialog(null)} onDone={r => { done(); setSecret({ name: r.member.name, email: r.member.email, value: r.temporaryPassword }) }} />}
      {dialog?.kind === 'edit' && <EditDialog m={dialog.m} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === 'reset' && <ResetDialog m={dialog.m} onClose={() => setDialog(null)} onDone={r => { done(); setSecret({ name: r.member.name, email: r.member.email, value: r.temporaryPassword }) }} />}
      {secret && (
        <SecretDialog title="Temporary password" label={`For ${secret.email}`} value={secret.value} onClose={() => setSecret(null)}>
          <p>{secret.name} signs in with this password, then changes it under Account.</p>
        </SecretDialog>
      )}
    </>
  )
}

function RolePicker({ value, onChange, disabled }) {
  return (
    <div className="cx-radio-list" role="radiogroup" aria-label="Role">
      {ROLES.map(r => (
        <label key={r} className={'cx-radio' + (value === r ? ' is-on' : '')}>
          <input type="radio" name="role" checked={value === r} disabled={disabled} onChange={() => onChange(r)} />
          <span><b>{roleLabel(r)}</b><small className="cx-muted cx-block">{ROLE_HELP[r]}</small></span>
        </label>
      ))}
    </div>
  )
}

function InviteDialog({ onClose, onDone }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('SUPPORT')
  const [run, busy, error] = useAction()
  const valid = name.trim() && /^\S+@\S+\.\S+$/.test(email.trim())
  const go = async e => {
    e?.preventDefault()
    if (!valid) return
    const r = await run(() => api.inviteTeamMember({ name: name.trim(), email: email.trim().toLowerCase(), role }))
    if (r) onDone(r)
  }
  return (
    <Dialog title="Add someone to the team" onClose={onClose} busy={busy}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button kind="primary" busy={busy} disabled={!valid} onClick={go}>Add and create password</Button></>}>
      <form onSubmit={go} className="cx-form" noValidate>
        <Field label="Full name" error={error?.fields?.name}><input className="cx-input" value={name} onChange={e => setName(e.target.value)} autoFocus /></Field>
        <Field label="Email" error={error?.fields?.email}><input className="cx-input" type="email" value={email} onChange={e => setEmail(e.target.value)} /></Field>
        <Field label="Role">{() => <RolePicker value={role} onChange={setRole} />}</Field>
      </form>
      {error && !error.fields?.name && !error.fields?.email && <p className="cx-form-error" role="alert">{error.message}</p>}
    </Dialog>
  )
}

function EditDialog({ m, onClose, onDone }) {
  const [name, setName] = useState(m.name)
  const [role, setRole] = useState(m.role)
  const [active, setActive] = useState(m.active)
  const [run, busy, error] = useAction()
  const go = async () => {
    const body = {}
    if (name.trim() !== m.name) body.name = name.trim()
    if (role !== m.role) body.role = role
    if (active !== m.active) body.active = active
    if (!Object.keys(body).length) return onClose()
    const r = await run(() => api.updateTeamMember(m.id, body), 'Saved')
    if (r) onDone()
  }
  return (
    <Dialog title={`Edit ${m.name}`} subtitle={m.email} onClose={onClose} busy={busy}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button kind="primary" busy={busy} disabled={!name.trim()} onClick={go}>Save</Button></>}>
      <Field label="Full name"><input className="cx-input" value={name} onChange={e => setName(e.target.value)} /></Field>
      <Field label="Role">{() => <RolePicker value={role} onChange={setRole} />}</Field>
      <label className="cx-check">
        <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
        <span>Can sign in. Turning this off or changing the role signs them out everywhere.</span>
      </label>
      {error && <p className="cx-form-error" role="alert">{error.message}</p>}
    </Dialog>
  )
}

function ResetDialog({ m, onClose, onDone }) {
  const [run, busy, error] = useAction()
  const go = async () => { const r = await run(() => api.resetTeamPassword(m.id)); if (r) onDone(r) }
  return (
    <ConfirmDialog title={`New password for ${m.name}?`} confirm="Create new password" onConfirm={go} onClose={onClose} busy={busy} error={error}>
      <p>Their current password stops working and they are signed out everywhere. You get a temporary password to pass on.</p>
    </ConfirmDialog>
  )
}
