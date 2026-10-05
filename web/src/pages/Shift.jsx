import { useState } from 'react'
import { api } from '../api.js'
import { useSession } from '../session.jsx'
import { Field, Modal, MoneyInput, ksh, timeOf, useAction } from '../ui.jsx'

export function OpenShift({ onOpened, onSkip, canSkip }) {
  const { user, branch, logout } = useSession()
  const [cents, setCents] = useState(500000)
  const [run, busy] = useAction()

  const open = () =>
    run(
      async () => {
        const r = await api.post('/shifts/open', { openingFloatCents: cents })
        onOpened(r.shift)
      },
      null,
      e => {
        // already open on another device: carry on with it
        if (e.code !== 'shift_already_open') return false
        api.get('/shifts/current').then(r => onOpened(r.shift))
        return true
      }
    )

  return (
    <div className="center-screen">
      <div className="modal static">
        <img src="/brand/bottle-point-mark.png" alt="" width="40" />
        <h3 className="title-serif sm">Open your shift</h3>
        <p className="muted">Hi {user.name.split(' ')[0]}. Count the cash in the {branch?.name} till and enter the opening float.</p>
        <Field label="Opening float (KSh)">
          <MoneyInput cents={cents} onCents={setCents} autoFocus />
        </Field>
        <button className="gold wide" disabled={busy} onClick={open}>{busy ? 'Opening...' : 'Open shift'}</button>
        {canSkip && <button className="outline wide" onClick={onSkip}>Not now, I will not take cash</button>}
        <button className="ghost" onClick={logout}>Back to sign in</button>
      </div>
    </div>
  )
}

// Live till figures and closing the shift with a cash count.
export function ShiftModal({ shift, onClose, onClosed }) {
  const [counted, setCounted] = useState(null)
  const [note, setNote] = useState('')
  const [run, busy] = useAction()
  const variance = counted == null ? null : counted - shift.expectedCashCents

  const close = () =>
    run(async () => {
      const r = await api.post(`/shifts/${shift.id}/close`, { countedCashCents: counted, note: note || undefined })
      onClosed(r.shift)
    }, 'Shift closed')

  return (
    <Modal title="Your shift" eyebrow={'Open since ' + timeOf(shift.openedAt)} onClose={onClose}>
      <div className="recon">
        <div><span>Opening float</span><b>{ksh(shift.openingFloatCents)}</b></div>
        <div><span>Cash taken</span><b>+ {ksh(shift.cashTakenCents)}</b></div>
        <div><span>Cash refunds</span><b>{'−'} {ksh(shift.cashRefundsCents)}</b></div>
        <div className="sum"><span>Expected in till</span><b>{ksh(shift.expectedCashCents)}</b></div>
        <div><span>M-Pesa taken (not in till)</span><b>{ksh(shift.mpesaTakenCents)}</b></div>
      </div>
      <Field label="Counted cash (KSh)">
        <MoneyInput cents={counted} onCents={setCounted} placeholder="Count the drawer" />
      </Field>
      {variance !== null && (
        <div className={'variance ' + (variance === 0 ? 'ok' : variance < 0 ? 'short' : 'over')}>
          {variance === 0 ? 'Till balances.' : variance < 0 ? `Short by ${ksh(-variance)}` : `Over by ${ksh(variance)}`}
        </div>
      )}
      <Field label="Note (optional)">
        <input className="label-in" value={note} onChange={e => setNote(e.target.value)} placeholder="Anything the manager should know" />
      </Field>
      <button className="gold wide" disabled={busy || counted == null} onClick={close}>Close shift</button>
    </Modal>
  )
}
