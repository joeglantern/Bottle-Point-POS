import { Hono } from 'hono'
import { z } from 'zod'
import { prisma, Prisma, type Shift } from '../db.js'
import { audit } from '../lib/audit.js'
import { AppError, forbidden, notFound, unprocessable } from '../lib/errors.js'
import { body, cents, query } from '../lib/validate.js'
import { atLeast, branchFor, requireRole, type AppEnv } from '../middleware/auth.js'
import { emitToBranch, Events } from '../realtime.js'
import { openShift } from '../rules/sale-core.js'
import { dayQuery, dayRange, todayNairobi } from '../rules/reports.js'
import { expectedCash, shiftDTO, shiftFigures, shiftsOverlapping } from '../rules/shifts.js'

export const shiftRoutes = new Hono<AppEnv>()

const openBody = z.object({ openingFloatCents: cents })
const closeBody = z.object({ countedCashCents: cents, note: z.string().trim().max(300).optional() })

const alreadyOpen = async (shift: Shift) =>
  new AppError(409, 'shift_already_open', 'You already have an open shift in this branch. Close it first.', {
    shift: await shiftDTO(prisma, shift)
  })

shiftRoutes.post('/open', async c => {
  const actor = c.get('actor')
  const branchId = branchFor(c)
  const input = await body(c, openBody)

  const existing = await openShift(prisma, actor.id, branchId)
  if (existing) throw await alreadyOpen(existing)

  let shift: Shift
  try {
    shift = await prisma.$transaction(async tx => {
      const s = await tx.shift.create({ data: { branchId, userId: actor.id, openingFloatCents: input.openingFloatCents } })
      await audit(tx, actor, 'shift.open', 'shift', s.id, { openingFloatCents: s.openingFloatCents }, branchId)
      return s
    })
  } catch (err) {
    // two taps on "open shift" at once: the unique partial index lets one through
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const s = await openShift(prisma, actor.id, branchId)
      if (s) throw await alreadyOpen(s)
    }
    throw err
  }

  const dto = await shiftDTO(prisma, shift)
  emitToBranch(branchId, Events.shiftUpdated, { shift: dto })
  return c.json({ shift: dto }, 201)
})

shiftRoutes.get('/current', async c => {
  const actor = c.get('actor')
  const branchId = branchFor(c)
  const shift = await openShift(prisma, actor.id, branchId)
  return c.json({ shift: shift ? await shiftDTO(prisma, shift) : null })
})

shiftRoutes.get('/', requireRole('MANAGER'), async c => {
  const q = query(c, dayQuery)
  const branchId = branchFor(c, q.branchId)
  const date = q.date ?? todayNairobi()
  const { start, end } = dayRange(date)
  return c.json({ date, shifts: await shiftsOverlapping(prisma, branchId, start, end) })
})

// Payments are written under a lock on the sale, and the sales code only
// attaches a payment to a shift that is open when it looks. Holding a row lock
// on the shift here means the figures cannot move while we count them; a
// payment arriving after the close finds no open shift and is refused.
shiftRoutes.post('/:id/close', async c => {
  const actor = c.get('actor')
  const id = c.req.param('id')
  const input = await body(c, closeBody)

  const found = await prisma.shift.findUnique({ where: { id } })
  if (!found || !actor.branchIds.includes(found.branchId)) throw notFound('Shift')
  if (found.userId !== actor.id && !atLeast(actor, 'MANAGER')) throw forbidden('Only the cashier who opened this shift or a manager can close it.')

  const shift = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Shift" WHERE id = ${id} FOR UPDATE`
    const s = await tx.shift.findUniqueOrThrow({ where: { id } })
    if (s.closedAt) throw unprocessable('This shift is already closed.', 'shift_closed')
    const f = (await shiftFigures(tx, [id])).get(id)!
    const expected = expectedCash(s, f)
    const closed = await tx.shift.update({
      where: { id },
      data: {
        closedAt: new Date(),
        expectedCashCents: expected,
        countedCashCents: input.countedCashCents,
        varianceCents: input.countedCashCents - expected,
        closeNote: input.note || null
      }
    })
    await audit(
      tx,
      actor,
      'shift.close',
      'shift',
      id,
      { ...f, expectedCashCents: expected, countedCashCents: input.countedCashCents, varianceCents: closed.varianceCents, note: input.note },
      s.branchId
    )
    return closed
  })

  const dto = await shiftDTO(prisma, shift)
  emitToBranch(shift.branchId, Events.shiftUpdated, { shift: dto })
  return c.json({ shift: dto })
})
