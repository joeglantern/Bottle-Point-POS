// Shared console building blocks. Every class is prefixed cx-.
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
import { count, date, dateTime, money, moneyShort, monthLabel, relative, statusLabel, statusTone } from './format.js'

// ---------- icons (18px, 1.5 stroke) ----------

const PATHS = {
  overview: 'M3 13h7V3H3v10Zm0 8h7v-6H3v6Zm11 0h7V11h-7v10Zm0-18v6h7V3h-7Z',
  clients: 'M3 21V8l9-5 9 5v13M9 21v-6h6v6M3 21h18',
  subscriptions: 'M4 7h16M4 12h16M4 17h10M17 15l2 2 3-3',
  invoices: 'M6 2h9l5 5v15H6V2Zm9 0v5h5M9 12h8M9 16h8M9 8h3',
  plans: 'M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 3.5h7M16.5 13v7',
  team: 'M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm13 9v-1a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  audit: 'M12 8v4l3 2M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
  account: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9a8 8 0 0 1 16 0',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm10 3-4.3-4.3',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M6 6l12 12M18 6 6 18',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z',
  out: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l-5-5 5-5M5 12h11',
  plus: 'M12 5v14M5 12h14',
  chevron: 'm9 6 6 6-6 6',
  back: 'm15 6-6 6 6 6',
  copy: 'M9 9h11v11H9V9Zm-5 6V4h11',
  download: 'M12 4v11m0 0 4-4m-4 4-4-4M5 20h14',
  print: 'M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7v-7Z',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  check: 'm5 12 5 5 9-10',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6'
}

export function Icon({ name, size = 18, className = '' }) {
  return (
    <svg className={'cx-icon ' + className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  )
}

// ---------- buttons and small pieces ----------

export function Button({ kind = 'secondary', size, icon, busy, children, className = '', type = 'button', disabled, ...rest }) {
  const cls = ['cx-btn', `cx-btn-${kind}`, size ? `cx-btn-${size}` : '', busy ? 'is-busy' : '', className].filter(Boolean).join(' ')
  return (
    <button type={type} className={cls} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <span className="cx-spin" aria-hidden="true" /> : icon ? <Icon name={icon} size={16} /> : null}
      {children && <span>{children}</span>}
    </button>
  )
}

export function IconButton({ icon, label, className = '', ...rest }) {
  return (
    <button type="button" className={'cx-iconbtn ' + className} aria-label={label} title={label} {...rest}>
      <Icon name={icon} />
    </button>
  )
}

export function StatusPill({ status, label }) {
  return (
    <span className={'cx-pill cx-tone-' + statusTone(status)}>
      <i aria-hidden="true" />
      {label ?? statusLabel(status)}
    </span>
  )
}

export const Money = ({ cents, className = '' }) => <span className={'cx-num ' + className}>{money(cents ?? 0)}</span>

export function When({ at, mode = 'date' }) {
  if (!at) return <span className="cx-muted">-</span>
  const text = mode === 'relative' ? relative(at) : mode === 'datetime' ? dateTime(at) : date(at)
  return <time dateTime={at} title={dateTime(at)}>{text}</time>
}

export function Field({ label, hint, error, children, className = '' }) {
  const id = useId()
  const child = typeof children === 'function' ? children(id) : children
  return (
    <div className={'cx-field ' + (error ? 'has-error ' : '') + className}>
      <label htmlFor={id}>{label}</label>
      {typeof children === 'function' ? child : <FieldInput id={id}>{child}</FieldInput>}
      {error ? <p className="cx-field-error" role="alert">{error}</p> : hint ? <p className="cx-hint">{hint}</p> : null}
    </div>
  )
}
// Gives the first form control inside the id the label points at.
function FieldInput({ id, children }) {
  if (children && typeof children === 'object' && 'props' in children && !children.props.id) {
    return { ...children, props: { ...children.props, id } }
  }
  return children
}

export function Meter({ used, max, label }) {
  const pct = max ? Math.min(100, Math.round((used / max) * 100)) : 0
  const over = max != null && used > max
  return (
    <div className="cx-meter">
      <div className="cx-meter-head">
        <span>{label}</span>
        <span className="cx-num">{count(used)}{max != null ? ` of ${count(max)}` : ''}{max == null ? <span className="cx-muted"> (no limit)</span> : null}</span>
      </div>
      <div className={'cx-meter-bar' + (over ? ' is-over' : pct >= 80 ? ' is-near' : '')} role="progressbar" aria-valuenow={used} aria-valuemin={0} aria-valuemax={max ?? used} aria-label={label}>
        <i style={{ width: (max == null ? 0 : pct) + '%' }} />
      </div>
    </div>
  )
}

// ---------- states ----------

export function Skeleton({ rows = 5, cols = 4 }) {
  return (
    <div className="cx-skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="cx-skel-row">
          {Array.from({ length: cols }, (_, c) => <span key={c} style={{ width: `${40 + ((r * 7 + c * 13) % 45)}%` }} />)}
        </div>
      ))}
    </div>
  )
}

export function Empty({ title, children, action }) {
  return (
    <div className="cx-empty">
      <p className="cx-empty-title">{title}</p>
      {children && <p className="cx-muted">{children}</p>}
      {action}
    </div>
  )
}

export function ErrorState({ error, onRetry }) {
  return (
    <div className="cx-errorstate" role="alert">
      <Icon name="alert" />
      <div>
        <p>{error?.message ?? 'Something went wrong.'}</p>
        {onRetry && <Button size="sm" icon="refresh" onClick={onRetry}>Try again</Button>}
      </div>
    </div>
  )
}

// ---------- data hooks ----------

// Loads with fn(signal). Re-runs when deps change. Keeps the last good data
// while reloading so lists do not flash.
export function useLoad(fn, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true })
  const seq = useRef(0)
  const fnRef = useRef(fn)
  fnRef.current = fn
  const load = useCallback(() => {
    const n = ++seq.current
    const ctl = new AbortController()
    setState(s => ({ ...s, loading: true, error: null }))
    fnRef.current(ctl.signal).then(
      data => n === seq.current && setState({ data, error: null, loading: false }),
      error => {
        if (error?.name === 'AbortError' || n !== seq.current) return
        setState(s => ({ data: s.data, error, loading: false }))
      }
    )
    return () => ctl.abort()
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => load(), [load])
  return { ...state, reload: load, setData: d => setState(s => ({ ...s, data: typeof d === 'function' ? d(s.data) : d })) }
}

// Runs a mutation once at a time. Returns [run, busy, error, clearError].
// run(fn, successMessage) resolves to the result, or undefined on failure.
export function useAction() {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const lock = useRef(false)
  const run = useCallback(async (fn, okMessage) => {
    if (lock.current) return undefined
    lock.current = true
    setBusy(true)
    setError(null)
    try {
      const r = await fn()
      if (okMessage) toast(okMessage, 'ok')
      return r ?? true
    } catch (e) {
      setError(e)
      return undefined
    } finally {
      lock.current = false
      setBusy(false)
    }
  }, [toast])
  return [run, busy, error, () => setError(null)]
}

// ---------- toasts ----------

const ToastContext = createContext(() => {})
export const useToast = () => useContext(ToastContext)

export function ToastProvider({ children }) {
  const [items, setItems] = useState([])
  const push = useCallback((message, tone = 'info') => {
    const id = Math.random().toString(36).slice(2)
    setItems(xs => [...xs.slice(-2), { id, message, tone }])
    setTimeout(() => setItems(xs => xs.filter(x => x.id !== id)), tone === 'error' ? 6000 : 3200)
  }, [])
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="cx-toasts" role="status" aria-live="polite">
        {items.map(t => (
          <div key={t.id} className={'cx-toast cx-toast-' + t.tone}>
            {t.tone === 'ok' && <Icon name="check" size={16} />}
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

// ---------- dialogs ----------

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
let openDialogs = 0

// Modal dialog: focus moves in and is kept there, Escape closes, focus goes
// back to whatever opened it, the page behind does not scroll. On phones it
// is shown as a sheet from the bottom.
export function Dialog({ title, subtitle, onClose, children, footer, size = 'md', busy = false }) {
  const ref = useRef(null)
  const titleId = useId()
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const busyRef = useRef(busy)
  busyRef.current = busy

  useEffect(() => {
    const before = document.activeElement
    openDialogs += 1
    document.documentElement.classList.add('cx-locked')
    const node = ref.current
    const first = node.querySelector('[autofocus]') ?? node.querySelector('input, select, textarea') ?? node.querySelector(FOCUSABLE)
    ;(first ?? node).focus()
    const onKey = e => {
      if (e.key === 'Escape' && !busyRef.current) {
        e.stopPropagation()
        closeRef.current?.()
      }
      if (e.key !== 'Tab') return
      const items = [...node.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null)
      if (!items.length) return
      const a = items[0]
      const z = items[items.length - 1]
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus() }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus() }
    }
    node.addEventListener('keydown', onKey)
    return () => {
      node.removeEventListener('keydown', onKey)
      openDialogs -= 1
      if (!openDialogs) document.documentElement.classList.remove('cx-locked')
      if (before && before.focus) before.focus()
    }
  }, [])

  return (
    <div className="cx-scrim" onMouseDown={e => e.target === e.currentTarget && !busy && onClose?.()}>
      <div ref={ref} className={'cx-dialog cx-dialog-' + size} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="cx-dialog-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p className="cx-muted">{subtitle}</p>}
          </div>
          {onClose && <IconButton icon="close" label="Close" onClick={onClose} disabled={busy} />}
        </header>
        <div className="cx-dialog-body">{children}</div>
        {footer && <footer className="cx-dialog-foot">{footer}</footer>}
      </div>
    </div>
  )
}

export function ConfirmDialog({ title, children, confirm = 'Confirm', danger = false, onConfirm, onClose, busy, error }) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      busy={busy}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button kind={danger ? 'danger' : 'primary'} busy={busy} onClick={onConfirm}>{confirm}</Button>
        </>
      }
    >
      {children}
      {error && <p className="cx-form-error" role="alert">{error.message}</p>}
    </Dialog>
  )
}

export function CopyButton({ value, label = 'Copy' }) {
  const [done, setDone] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // clipboard blocked (plain http): select the text so it can be copied by hand
      const el = document.createElement('textarea')
      el.value = value
      document.body.appendChild(el)
      el.select()
      try { document.execCommand('copy') } catch {}
      el.remove()
    }
    setDone(true)
    setTimeout(() => setDone(false), 1800)
  }
  return <Button size="sm" icon={done ? 'check' : 'copy'} onClick={copy}>{done ? 'Copied' : label}</Button>
}

// A secret shown exactly once: a generated PIN or temporary password.
export function SecretDialog({ title, label, value, children, onClose }) {
  return (
    <Dialog title={title} onClose={onClose} size="sm" footer={<Button kind="primary" onClick={onClose}>I have saved it</Button>}>
      {children}
      <div className="cx-secret">
        <span className="cx-secret-label">{label}</span>
        <code className="cx-secret-value">{value}</code>
        <CopyButton value={value} />
      </div>
      <p className="cx-warn">This will not be shown again. Share it with the person directly and never by public message.</p>
    </Dialog>
  )
}

// ---------- layout pieces ----------

export function PageHeader({ title, eyebrow, actions, children }) {
  return (
    <header className="cx-page-head">
      <div className="cx-page-title">
        {eyebrow && <div className="cx-eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {children}
      </div>
      {actions && <div className="cx-page-actions">{actions}</div>}
    </header>
  )
}

export function Card({ title, actions, children, className = '', flush = false }) {
  return (
    <section className={'cx-card ' + (flush ? 'is-flush ' : '') + className}>
      {(title || actions) && (
        <header className="cx-card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="cx-card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export function Tabs({ tabs, value, onChange, label }) {
  return (
    <div className="cx-tabs" role="tablist" aria-label={label}>
      {tabs.map(([key, text, n]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={value === key}
          className={value === key ? 'is-on' : ''}
          onClick={() => onChange(key)}
        >
          {text}
          {n != null && <span className="cx-tab-count">{n}</span>}
        </button>
      ))}
    </div>
  )
}

export function Chips({ items, value, onChange, label }) {
  return (
    <div className="cx-chips" role="group" aria-label={label}>
      {items.map(([key, text, n]) => (
        <button key={key || 'all'} type="button" aria-pressed={value === key} className={value === key ? 'is-on' : ''} onClick={() => onChange(key)}>
          {text}
          {n != null && <span className="cx-num">{n}</span>}
        </button>
      ))}
    </div>
  )
}

export function Pagination({ total, limit, page, onPage }) {
  const pages = Math.max(1, Math.ceil(total / limit))
  if (total <= limit) return null
  const from = (page - 1) * limit + 1
  const to = Math.min(total, page * limit)
  return (
    <nav className="cx-pager" aria-label="Pages">
      <span className="cx-muted cx-num">{count(from)} to {count(to)} of {count(total)}</span>
      <div>
        <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
        <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
      </div>
    </nav>
  )
}

export function SortHeader({ field, label, sort, dir, onSort, className = '' }) {
  const active = sort === field
  return (
    <th className={className} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="cx-sort" onClick={() => onSort(field)}>
        {label}
        <span aria-hidden="true">{active ? (dir === 'asc' ? '↑' : '↓') : ''}</span>
      </button>
    </th>
  )
}

// ---------- charts ----------

// Twelve month bars: two series side by side. Values in cents.
export function MonthBars({ rows, series, label }) {
  const max = Math.max(1, ...rows.flatMap(r => series.map(s => r[s.key] ?? 0)))
  const [hover, setHover] = useState(null)
  const h = 160
  const step = 100 / rows.length
  const ticks = [0, 0.5, 1].map(f => Math.round(max * f))
  return (
    <figure className="cx-chart" aria-label={label}>
      <div className="cx-chart-area">
        <div className="cx-chart-ticks" aria-hidden="true">
          {ticks.slice().reverse().map(t => <span key={t}>{moneyShort(t)}</span>)}
        </div>
        <svg viewBox={`0 0 100 ${h}`} preserveAspectRatio="none" role="img" aria-hidden="true">
          {[0, 0.5, 1].map(f => <line key={f} x1="0" x2="100" y1={h - f * h + 0.5} y2={h - f * h + 0.5} className="cx-chart-grid" />)}
          {rows.map((r, i) => {
            const w = (step * 0.72) / series.length
            return series.map((s, j) => {
              const v = r[s.key] ?? 0
              const bh = Math.max(v > 0 ? 1.5 : 0, (v / max) * (h - 4))
              return (
                <rect
                  key={s.key + i}
                  x={i * step + step * 0.14 + j * w}
                  y={h - bh}
                  width={w * 0.9}
                  height={bh}
                  className={'cx-bar cx-bar-' + s.tone + (hover === i ? ' is-hover' : '')}
                />
              )
            })
          })}
          {rows.map((r, i) => (
            <rect key={'hit' + i} x={i * step} y="0" width={step} height={h} fill="transparent" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
          ))}
        </svg>
      </div>
      <div className="cx-chart-x" aria-hidden="true">
        {rows.map((r, i) => <span key={i} className={hover === i ? 'is-hover' : ''}>{monthLabel(r.month)}</span>)}
      </div>
      <figcaption className="cx-chart-legend">
        {series.map(s => (
          <span key={s.key}><i className={'cx-bar-' + s.tone} />{s.label}{hover != null ? <b className="cx-num">{money(rows[hover]?.[s.key] ?? 0)}</b> : null}</span>
        ))}
        {hover != null && <span className="cx-muted">{monthLabel(rows[hover].month)} {rows[hover].month.slice(0, 4)}</span>}
      </figcaption>
      <table className="cx-sr-only">
        <caption>{label}</caption>
        <thead><tr><th>Month</th>{series.map(s => <th key={s.key}>{s.label}</th>)}</tr></thead>
        <tbody>{rows.map(r => <tr key={r.month}><td>{r.month}</td>{series.map(s => <td key={s.key}>{money(r[s.key] ?? 0)}</td>)}</tr>)}</tbody>
      </table>
    </figure>
  )
}

// Thin line for a twelve month series.
export function Sparkline({ values }) {
  const max = Math.max(1, ...values)
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * 100},${38 - (v / max) * 34}`).join(' ')
  return (
    <svg className="cx-spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
