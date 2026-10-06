import { useState } from 'react'
import { api } from '../api.js'
import { roleLabel } from '../format.js'
import { useTitle } from '../router.js'
import { useSession } from '../session.js'
import { Button, Card, Field, PageHeader, useAction } from '../ui.jsx'

function strength(p) {
  if (!p) return null
  let score = 0
  if (p.length >= 10) score++
  if (p.length >= 14) score++
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) score++
  if (/\d/.test(p)) score++
  if (/[^A-Za-z0-9]/.test(p)) score++
  return score <= 1 ? 'Weak' : score <= 3 ? 'Fair' : 'Strong'
}

export default function Account() {
  useTitle('Account')
  const { user, signOut } = useSession()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [run, busy, error] = useAction()
  const tooShort = next && next.length < 10
  const mismatch = confirm && confirm !== next
  const valid = current && next.length >= 10 && next === confirm

  const submit = async e => {
    e.preventDefault()
    if (!valid) return
    const r = await run(() => api.changePassword(current, next), 'Password changed. Other devices were signed out.')
    if (r) { setCurrent(''); setNext(''); setConfirm('') }
  }

  return (
    <>
      <PageHeader title="Account" />
      <div className="cx-grid-2">
        <Card title="You">
          <dl className="cx-dl">
            <div><dt>Name</dt><dd>{user.name}</dd></div>
            <div><dt>Email</dt><dd>{user.email}</dd></div>
            <div><dt>Role</dt><dd>{roleLabel(user.role)}</dd></div>
          </dl>
          <div className="cx-card-buttons"><Button onClick={signOut} icon="out">Sign out</Button></div>
        </Card>
        <Card title="Change password">
          <form onSubmit={submit} className="cx-form" noValidate>
            <Field label="Current password" error={error?.code === 'bad_request' && !error.fields?.newPassword ? error.message : null}>
              <input className="cx-input" type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} />
            </Field>
            <Field label="New password" hint={next ? `Strength: ${strength(next)}` : 'At least 10 characters. A short sentence works well.'} error={tooShort ? 'At least 10 characters' : error?.fields?.newPassword}>
              <input className="cx-input" type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} />
            </Field>
            <Field label="Type it again" error={mismatch ? 'The two passwords do not match' : null}>
              <input className="cx-input" type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} />
            </Field>
            {error && error.code !== 'bad_request' && <p className="cx-form-error" role="alert">{error.message}</p>}
            <div><Button kind="primary" type="submit" busy={busy} disabled={!valid}>Change password</Button></div>
          </form>
        </Card>
      </div>
    </>
  )
}
