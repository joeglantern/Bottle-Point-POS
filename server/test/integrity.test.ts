import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { applyPayment } from '../src/rules/sale-core.js'
import { Client, resetDb, seedFixture, type Fixture } from './helpers.js'

let fx: Fixture
beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
})

async function savedSale(totalCents = 28000) {
  return prisma.sale.create({
    data: {
      number: Math.floor(Math.random() * 1e6),
      branchId: fx.branches.west.id,
      createdById: fx.users.cashier.id,
      status: 'SAVED',
      subtotalCents: totalCents,
      totalCents,
      lines: { create: [{ productId: fx.products.beer.id, name: 'Tusker Lager', unitCents: totalCents, qty: 1 }] }
    }
  })
}

describe('money cannot land in a closed shift', () => {
  it('refuses cash into a closed shift', async () => {
    const shift = await prisma.shift.create({
      data: { branchId: fx.branches.west.id, userId: fx.users.cashier.id, openingFloatCents: 0, closedAt: new Date() }
    })
    const sale = await savedSale()
    await expect(
      prisma.$transaction(tx =>
        applyPayment(tx, { saleId: sale.id, method: 'CASH', amountCents: 28000, verification: 'CASH', receivedById: fx.users.cashier.id, shiftId: shift.id })
      )
    ).rejects.toMatchObject({ code: 'shift_closed' })
  })

  it('still records a late M-Pesa confirmation, without the closed shift', async () => {
    const shift = await prisma.shift.create({
      data: { branchId: fx.branches.west.id, userId: fx.users.cashier.id, openingFloatCents: 0, closedAt: new Date() }
    })
    const sale = await savedSale()
    const r = await prisma.$transaction(tx =>
      applyPayment(tx, {
        saleId: sale.id, method: 'MPESA', amountCents: 28000, mpesaRef: 'SLATE00001', verification: 'STK_CONFIRMED',
        receivedById: fx.users.cashier.id, shiftId: shift.id
      })
    )
    expect(r.paid).toBe(true)
    expect(r.payment.shiftId).toBeNull()
  })

  it('a close racing a cash payment never loses the cash from the count', async () => {
    for (let round = 0; round < 5; round++) {
      await resetDb()
      fx = await seedFixture()
      const c = await Client.login('cashier')
      const opened = await c.post('/api/shifts/open', { openingFloatCents: 100000 })
      expect(opened.status).toBe(201)
      const shiftId = opened.body.shift.id
      const sale = await savedSale()

      const [pay, close] = await Promise.all([
        c.post(`/api/sales/${sale.id}/pay`, { payments: [{ method: 'CASH', amountCents: 28000, tenderedCents: 30000 }] }),
        c.post(`/api/shifts/${shiftId}/close`, { countedCashCents: 100000 })
      ])
      expect(close.status).toBe(200)
      const shift = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })
      const cashInShift = await prisma.payment.aggregate({ where: { shiftId, method: 'CASH' }, _sum: { amountCents: true } })
      // whatever the order, the recorded expectation matches the cash that is linked to the shift
      expect(shift.expectedCashCents).toBe(100000 + (cashInShift._sum.amountCents ?? 0))
      if (pay.status !== 200) expect(pay.body.error.code).toMatch(/shift_closed|no_open_shift/)
    }
  })
})
