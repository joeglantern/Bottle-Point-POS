import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { useOnline, useSession } from '../session.jsx'
import { Logo } from '../ui.jsx'

// The username is remembered on this device so a till only needs the PIN.
const KEY = 'bp-last-user'
const remembered = () => {
  try { return localStorage.getItem(KEY) || '' } catch { return '' }
}

export default function Login({ themeBtn }) {
  const { login, notice } = useSession()
  const online = useOnline()
  const [shop, setShop] = useState({ loading: true, name: null, missing: false })
  const [username, setUsername] = useState(remembered)
  const [pin, setPin] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const userRef = useRef(null)

  // Which shop this address belongs to (nyrolix.pos.flarehub.co.ke -> Nyrolix).
  useEffect(() => {
    api.get('/session/tenant').then(
      r => setShop({ loading: false, name: r.tenant?.name ?? null, missing: false }),
      e => {
        // the shop changed its address: go there, keeping the path
        if (e.code === 'shop_moved' && e.details?.url) {
          setShop({ loading: true, name: null, missing: false, moved: e.details })
          window.location.replace(e.details.url + window.location.pathname + window.location.search)
          return
        }
        setShop({ loading: false, name: null, missing: e.code === 'no_shop' })
      }
    )
  }, [])

  useEffect(() => {
    if (shop.name) document.title = `${shop.name} · Bottle Point`
  }, [shop.name])

  const submit = async value => {
    const name = username.trim().toLowerCase()
    if (busy) return
    if (!name) {
      setErr('Enter your username first.')
      userRef.current?.focus()
      setPin('')
      return
    }
    setBusy(true)
    try {
      await login(name, value)
      try { localStorage.setItem(KEY, name) } catch {}
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
    setPin(p => (p + d).slice(0, 6))
  }

  // Digits typed on a hardware keyboard work like the on screen pad.
  const pressRef = useRef(press)
  pressRef.current = press
  useEffect(() => {
    const onKey = e => {
      if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return
      if (/^[0-9]$/.test(e.key)) pressRef.current(e.key)
      else if (e.key === 'Backspace') pressRef.current('del')
      else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') pressRef.current('ok')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (shop.moved) {
    return (
      <div className="login login-missing">
        <div className="login-card">
          <Logo className="logo" />
          <h2>{shop.moved.name} has moved</h2>
          <p className="muted">Taking you to <a href={shop.moved.url}>{shop.moved.url.replace('https://', '')}</a>. Update your bookmark or home screen icon.</p>
        </div>
      </div>
    )
  }

  if (shop.missing) {
    return (
      <div className="login login-missing">
        {themeBtn}
        <div className="login-card">
          <Logo className="logo" />
          <h2>No shop here</h2>
          <p className="muted">There is no Bottle Point shop at this address. Check the link you were given, or ask whoever set up your account.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="login">
      {themeBtn}
      <div className="login-art">
        <h1 className="login-brand"><Logo className="logo xl" /></h1>
        <p className="login-sub">{shop.name ? shop.name : 'Point of sale for wines, spirits and local pubs.'}</p>
      </div>
      <div className="login-card">
        <h2>Sign in</h2>
        <p className="muted">{shop.name ? `Staff of ${shop.name}: your username and PIN.` : 'Your username and PIN.'}</p>
        {notice && <p className="login-notice" role="status">{notice}</p>}
        {!online && <p className="login-notice offline" role="status">No internet. Anyone who has signed in on this till in the last 14 days can still sign in and sell.</p>}
        <label className="field login-user">
          <span>Username</span>
          <input
            ref={userRef}
            className="label-in"
            value={username}
            onChange={e => { setUsername(e.target.value); setErr('') }}
            autoFocus={!username}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="username"
            spellCheck={false}
            enterKeyHint="next"
          />
          {username && (
            <button type="button" className="login-clear" aria-label="Clear username, someone else is signing in" onClick={() => { setUsername(''); setPin(''); setErr(''); try { localStorage.removeItem(KEY) } catch {} ; userRef.current?.focus() }}>
              Not you?
            </button>
          )}
        </label>
        <div className="pin-dots" aria-label={pin.length + ' digits entered'}>
          {[0, 1, 2, 3].concat(pin.length > 4 ? [4, 5].slice(0, pin.length - 4) : []).map(i => <span key={i} className={i < pin.length ? 'full' : ''} />)}
        </div>
        <div className="err" role="alert">{busy ? 'Signing in...' : err}</div>
        <div className="pad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'].map(d => (
            <button key={d} disabled={busy || (d === 'ok' && pin.length < 4)} onClick={() => press(d)} className={d === 'ok' ? 'pad-ok' : ''} aria-label={d === 'del' ? 'Delete last digit' : d === 'ok' ? 'Sign in' : undefined}>
              {d === 'del' ? '⌫' : d === 'ok' ? 'Sign in' : d}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
