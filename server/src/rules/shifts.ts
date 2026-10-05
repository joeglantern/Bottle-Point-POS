// Till figures for shifts. A shift's cash drawer should hold:
//   opening float + cash payments taken on the shift - cash refunds paid out of it

import type { Db, Shift } from '../db.js'

export type ShiftFigures = { cashTakenCents: number; mpesaTakenCents: number; cashRefundsCents: number }

export async function shiftFigures(db: Db, shiftIds: string[]) {
  const out = new Map<string, ShiftFigures>()
  for (const id of shiftIds) out.set(id, { cashTakenCents: 0, mpesaTakenCents: 0, cashRefundsCents: 0 })
  if (!shiftIds.length) return out
  const [pays, refunds] = await Promise.all([
    db.payment.groupBy({ by: ['shiftId', 'method'], where: { shiftId: { in: shiftIds } }, _sum: { amountCents: true } }),
    db.refund.groupBy({ by: ['shiftId'], where: { shiftId: { in: shiftIds }, method: 'CASH' }, _sum: { amountCents: true } })
  ])
  for (const p of pays) {
    const f = out.get(p.shiftId!)
    if (!f) continue
    if (p.method === 'CASH') f.cashTakenCents += p._sum.amountCents ?? 0
    else f.mpesaTakenCents += p._sum.amountCents ?? 0
  }
  for (const r of refunds) {
    const f = out.get(r.shiftId!)
    if (f) f.cashRefundsCents += r._sum.amountCents ?? 0
  }
  return out
}

export function expectedCash(s: Pick<Shift, 'openingFloatCents'>, f: ShiftFigures) {
  return s.openingFloatCents + f.cashTakenCents - f.cashRefundsCents
}

export function toShiftDTO(s: Shift, f: ShiftFigures, userName: string | null) {
  const live = expectedCash(s, f)
  return {
    id: s.id,
    branchId: s.branchId,
    userId: s.userId,
    userName,
    openedAt: s.openedAt,
    closedAt: s.closedAt,
    open: s.closedAt == null,
    openingFloatCents: s.openingFloatCents,
    cashTakenCents: f.cashTakenCents,
    mpesaTakenCents: f.mpesaTakenCents,
    cashRefundsCents: f.cashRefundsCents,
    // closed shifts report what was recorded at close; open ones are live
    expectedCashCents: s.closedAt ? (s.expectedCashCents ?? live) : live,
    countedCashCents: s.countedCashCents,
    varianceCents: s.varianceCents,
    closeNote: s.closeNote
  }
}
export type ShiftDTO = ReturnType<typeof toShiftDTO>

export async function shiftDTOs(db: Db, shifts: Shift[]) {
  const [figs, users] = await Promise.all([
    shiftFigures(db, shifts.map(s => s.id)),
    db.user.findMany({ where: { id: { in: [...new Set(shifts.map(s => s.userId))] } }, select: { id: true, name: true } })
  ])
  const names = new Map(users.map(u => [u.id, u.name]))
  return shifts.map(s => toShiftDTO(s, figs.get(s.id)!, names.get(s.userId) ?? null))
}

export async function shiftDTO(db: Db, shift: Shift) {
  return (await shiftDTOs(db, [shift]))[0]!
}

// Shifts that were open at any moment of [start, end).
export async function shiftsOverlapping(db: Db, branchId: string, start: Date, end: Date) {
  const shifts = await db.shift.findMany({
    where: { branchId, openedAt: { lt: end }, OR: [{ closedAt: null }, { closedAt: { gte: start } }] },
    orderBy: { openedAt: 'asc' }
  })
  return shiftDTOs(db, shifts)
}
