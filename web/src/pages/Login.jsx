import { useState } from 'react'
import { useSession } from '../session.jsx'
import { Logo } from '../ui.jsx'

// Demo accounts from the seed. Kept on the sign in screen for now so the
// demo is quick to show; any other staff member types their username.
const DEMO = [
  { username: 'wanjiru', name: 'Wanjiru K.', role: 'Cashier' },
  { username: 'brian', name: 'Brian M.', role: 'Cashier' },
  { username: 'otieno', name: 'Otieno J.', role: 'Manager' },
  { username: 'achieng', name: 'Achieng O.', role: 'Owner' }
]

export default function Login({ themeBtn }) {
  const { login } = useSession()
  const [username, setUsername] = useState(DEMO[0].username)
  const [other, setOther] = useState(false)
  const [pin, setPin] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async value => {
    if (!username || busy) return
    setBusy(true)
    try {
      await login(username.trim().toLowerCase(), value)
    } catch (e) {
      setErr(e.message)
      setPin('')
    } finally {
      setBusy(false)
    }
  }

  const press = d => {
    setErr('')
    if (d === 'del') return setPin(p => p.slice(0, -1))
    if (d === 'ok') return pin.length >= 4 && submit(pin)
    const next = (pin + d).slice(0, 6)
    setPin(next)
    // most PINs are 4 digits: sign in straight away, longer ones press OK
    if (next.length === 4 && !other) submit(next)
  }

  return (
    <div className="login">
      {themeBtn}
      <div className="login-art">
        <h1 className="login-brand"><Logo className="logo xl" /></h1>
        <p className="login-sub">Point of sale for wines, spirits and local pubs.</p>
      </div>
      <div className="login-card">
        <h2>Sign in</h2>
        <p className="muted">Pick your name and enter your PIN.</p>
        <div className="user-list">
          {DEMO.map(u => (
            <button key={u.username} className={'user-pill' + (!other && u.username === username ? ' on' : '')} onClick={() => { setOther(false); setUsername(u.username); setPin(''); setErr('') }}>
              <span className="avatar">{u.name[0]}</span>
              <span><b>{u.name}</b><small>{u.role}</small></span>
            </button>
          ))}
        </div>
        {other ? (
          <input className="label-in" value={username} onChange={e => setUsername(e.target.value)} placeholder="Username" autoFocus autoCapitalize="none" />
        ) : (
          <button className="ghost other-user" onClick={() => { setOther(true); setUsername(''); setPin('') }}>Someone else? Sign in with a username</button>
        )}
        <div className="pin-dots" aria-label={pin.length + ' digits entered'}>
          {[0, 1, 2, 3].concat(pin.length > 4 ? [4, 5].slice(0, pin.length - 4) : []).map(i => <span key={i} className={i < pin.length ? 'full' : ''} />)}
        </div>
        <div className="err" role="alert">{busy ? 'Signing in...' : err}</div>
        <div className="pad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'].map(d => (
            <button key={d} disabled={busy} onClick={() => press(d)} className={d === 'ok' ? 'pad-ok' : ''}>
              {d === 'del' ? '⌫' : d === 'ok' ? 'OK' : d}
            </button>
          ))}
        </div>
        <p className="muted small demo-note">Demo accounts use PIN 1234.</p>
      </div>
    </div>
  )
}
