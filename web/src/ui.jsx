import { createContext, useContext, useEffect, useState } from 'react'

// Small shared pieces used across screens.

export const ksh = cents => 'KSh ' + Math.round((cents || 0) / 100).toLocaleString('en-KE')
export const kshExact = cents =>
  'KSh ' + ((cents || 0) / 100).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
export const toCents = v => Math.round(Number(String(v).replace(/,/g, '') || 0) * 100)
export const digits = v => String(v).replace(/\D/g, '')

export function ago(t) {
  const m = Math.round((Date.now() - new Date(t).getTime()) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return m + ' min ago'
  const h = Math.floor(m / 60)
  if (h < 24) return h + 'h ' + (m % 60) + 'm ago'
  return Math.floor(h / 24) + 'd ago'
}
export const timeOf = t => new Date(t).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' })
export const dateOf = t => new Date(t).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', timeZone: 'Africa/Nairobi' })
export const todayNairobi = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10)
export const statusLabel = s => ({ OPEN: 'open', SAVED: 'unpaid', PAID: 'paid', CANCELLED: 'cancelled', REFUNDED: 'refunded' })[s] ?? String(s).toLowerCase()

export function Logo({ className = 'logo' }) {
  return (
    <span className={className}>
      <img src="/brand/bottle-point-lockup.png" alt="Bottle Point" className="on-dark" />
      <img src="/brand/bottle-point-lockup-light.png" alt="Bottle Point" className="on-light" />
    </span>
  )
}

const TINTS = { whisky: '#3a2412', vodka: '#2a2a32', gin: '#20302a', wine: '#3a1020', beer: '#3a3010', rum: '#3a2010', cognac: '#3a1c0c', tequila: '#3a3416', brandy: '#33180c' }
export const tintFor = category => TINTS[String(category || '').toLowerCase()] ?? '#2c2a26'

export function Bottle({ tint }) {
  return (
    <svg viewBox="0 0 40 80" className="bottle" aria-hidden="true">
      <path d="M16 2h8v4h-1v14c0 5 10 7 10 16v38c0 2-1 3-3 3H10c-2 0-3-1-3-3V36c0-9 10-11 10-16V6h-1z" fill={tint} />
      <path d="M16 2h8v4h-8z" fill="#C9A45C" opacity=".8" />
      <rect x="10" y="44" width="20" height="16" rx="1.5" fill="#C9A45C" opacity=".22" />
      <path d="M11 38c0-6 6-8 7-12" stroke="#fff" strokeOpacity=".18" strokeWidth="1.5" fill="none" />
    </svg>
  )
}

const ICONS = {
  till: <path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6M10 21h.01M17 21h.01" />,
  history: <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3" />,
  stock: <path d="M21 8 12 3 3 8v8l9 5 9-5V8ZM3 8l9 5 9-5M12 13v8" />,
  today: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  branches: <path d="M12 21s-7-5.6-7-11a7 7 0 0 1 14 0c0 5.4-7 11-7 11Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />,
  customers: <path d="M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 20v-1a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" />,
  staff: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1M19 8l1.5 1.5L23 7" />,
  approvals: <path d="M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9" />,
  out: <path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l-5-5 5-5M5 12h11" />,
  scan: <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M10 8v8M13 8v8M17 8v8" />,
  phone: <path d="M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM11 18h2" />,
  refresh: <path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16v4ZM14 6l4 4" />
}
export const Icon = ({ k, className = 'ico' }) => <svg viewBox="0 0 24 24" className={className}>{ICONS[k]}</svg>

export function Modal({ title, eyebrow, onClose, children, wide = false, className = '' }) {
  useEffect(() => {
    const onKey = e => e.key === 'Escape' && onClose && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="scrim" onMouseDown={e => e.target === e.currentTarget && onClose && onClose()}>
      <div className={'modal' + (wide ? ' wide' : '') + (className ? ' ' + className : '')} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            {eyebrow && <small className="eyebrow">{eyebrow}</small>}
            <h3 className="title-serif sm">{title}</h3>
          </div>
          {onClose && <button className="ghost" onClick={onClose}>Close</button>}
        </div>
        {children}
      </div>
    </div>
  )
}

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small className="hint">{hint}</small>}
    </label>
  )
}

export function Stat({ label, value, note, tone }) {
  return (
    <div className={'stat' + (tone ? ' ' + tone : '')}>
      <small>{label}</small>
      <b>{value}</b>
      {note && <span>{note}</span>}
    </div>
  )
}

export function Empty({ children }) {
  return <p className="empty-state">{children}</p>
}

export function Loading({ label = 'Loading' }) {
  return <div className="loading"><span className="spinner" />{label}</div>
}

export function ErrorNote({ error, onRetry }) {
  if (!error) return null
  return (
    <div className="error-note">
      <span>{error.message}</span>
      {onRetry && <button className="mini" onClick={onRetry}>Try again</button>}
    </div>
  )
}

// Toasts
const ToastCtx = createContext(() => {})
export const useToast = () => useContext(ToastCtx)
export function ToastProvider({ children }) {
  const [items, setItems] = useState([])
  const push = (msg, tone = 'info') => {
    const id = Math.random()
    setItems(xs => [...xs.slice(-2), { id, msg, tone }])
    setTimeout(() => setItems(xs => xs.filter(x => x.id !== id)), tone === 'error' ? 5000 : 2800)
  }
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map(t => <div key={t.id} className={'toast ' + t.tone}>{t.msg}</div>)}
      </div>
    </ToastCtx.Provider>
  )
}

// Runs an async action, shows its error as a toast, tracks busy state.
export function useAction() {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  // onError(e) may return true to say it handled the error itself.
  // Never throws: returns the result, or undefined when it failed.
  const run = async (fn, okMsg, onError) => {
    if (busy) return
    setBusy(true)
    try {
      const r = await fn()
      if (okMsg) toast(okMsg, 'ok')
      return r ?? true
    } catch (e) {
      if (!(onError && onError(e))) toast(e.message || 'Something went wrong.', 'error')
      return undefined
    } finally {
      setBusy(false)
    }
  }
  return [run, busy]
}

// Money input in shillings that reports cents.
export function MoneyInput({ cents, onCents, placeholder = '0', autoFocus, ...rest }) {
  const [text, setText] = useState(cents ? String(Math.round(cents / 100)) : '')
  useEffect(() => {
    if (cents == null) return
    if (toCents(text) !== cents) setText(cents ? String(cents / 100) : '')
  }, [cents])
  return (
    <input
      inputMode="decimal"
      value={text}
      autoFocus={autoFocus}
      placeholder={placeholder}
      onChange={e => {
        const v = e.target.value.replace(/[^\d.]/g, '')
        setText(v)
        onCents(toCents(v))
      }}
      {...rest}
    />
  )
}

export function ThemeButton({ theme, toggle }) {
  return (
    <button className="theme-btn" onClick={toggle} title={theme === 'dark' ? 'Light theme' : 'Dark theme'} aria-label="Switch theme">
      {theme === 'dark'
        ? <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
        : <svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" /></svg>}
    </button>
  )
}

export function useTheme() {
  const initial = () => {
    try {
      const saved = localStorage.getItem('bp-theme')
      if (saved === 'light' || saved === 'dark') return saved
    } catch {}
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  const [theme, setTheme] = useState(initial)
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem('bp-theme', theme) } catch {}
  }, [theme])
  return [theme, () => setTheme(t => (t === 'dark' ? 'light' : 'dark'))]
}

// Ask for a reason (and optionally more) before an approval request.
export function ReasonModal({ title, eyebrow, label = 'Reason', confirm = 'Send to manager', onClose, onSubmit, children, busy }) {
  const [reason, setReason] = useState('')
  return (
    <Modal title={title} eyebrow={eyebrow} onClose={onClose}>
      {children}
      <Field label={label}>
        <textarea rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="What happened?" autoFocus />
      </Field>
      <button className="gold wide" disabled={busy || reason.trim().length < 3} onClick={() => onSubmit(reason.trim())}>{confirm}</button>
    </Modal>
  )
}
