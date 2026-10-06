import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Button, IconButton } from '../ui.jsx'

export default function Login({ ended, theme, onTheme, onSignedIn }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { document.title = 'Sign in · Bottle Point Console' }, [])

  const submit = async e => {
    e.preventDefault()
    if (busy) return
    if (!email.trim() || !password) { setError('Enter your email and password.'); return }
    setBusy(true)
    setError('')
    try {
      await api.login(email.trim(), password)
      setPassword('')
      await onSignedIn()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  const pos = import.meta.env.VITE_POS_URL

  return (
    <div className="cx-login">
      <IconButton icon={theme === 'dark' ? 'sun' : 'moon'} label={theme === 'dark' ? 'Light theme' : 'Dark theme'} className="cx-login-theme" onClick={onTheme} />
      <form className="cx-login-card" onSubmit={submit} noValidate>
        <div className="cx-login-brand">
          <img src="/brand/bottle-point-lockup.png" alt="Bottle Point" className="cx-on-dark" />
          <img src="/brand/bottle-point-lockup-light.png" alt="Bottle Point" className="cx-on-light" />
          <span className="cx-console-tag">Console</span>
        </div>
        <h1>Sign in</h1>
        <p className="cx-muted">For the Bottle Point team. Shop staff sign in at the till.</p>
        {ended && !error && <p className="cx-note" role="status">Your session ended. Sign in again to carry on where you were.</p>}

        <div className="cx-field">
          <label htmlFor="cx-email">Email</label>
          <input id="cx-email" type="email" autoComplete="username" inputMode="email" value={email} onChange={e => setEmail(e.target.value)} autoFocus spellCheck={false} />
        </div>
        <div className="cx-field">
          <label htmlFor="cx-password">Password</label>
          <div className="cx-input-group">
            <input id="cx-password" type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
            <button type="button" className="cx-input-addon" onClick={() => setShow(s => !s)} aria-pressed={show}>{show ? 'Hide' : 'Show'}</button>
          </div>
        </div>
        {error && <p className="cx-form-error" role="alert">{error}</p>}
        <Button kind="primary" type="submit" busy={busy} className="cx-btn-block">Sign in</Button>
        {pos && <a className="cx-login-pos" href={pos}>Go to the till</a>}
      </form>
    </div>
  )
}
