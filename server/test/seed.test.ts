import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { DEMO_BUSINESS, seedDemo } from '../prisma/seed.js'
import { Client, resetDb } from './helpers.js'

const quiet = () => {}

beforeAll(async () => {
  await resetDb()
})

describe('demo seed', () => {
  it('creates a consistent demo business', async () => {
    const r = await seedDemo({ log: quiet })
    expect(r.created).toBe(true)

    const business = await prisma.business.findFirstOrThrow({ where: { name: DEMO_BUSINESS } })
    expect(await prisma.branch.count({ where: { businessId: business.id } })).toBe(3)
    expect(await prisma.product.count({ where: { businessId: business.id } })).toBe(15)
    expect(await prisma.customer.count({ where: { businessId: business.id } })).toBe(6)

    // every paid sale is fully covered by its payments, and nothing is overpaid
    const sales = await prisma.sale.findMany({ include: { payments: true, lines: true } })
    expect(sales.length).toBeGreaterThan(0)
    for (const s of sales) {
      const lines = s.lines.reduce((a, l) => a + l.unitCents * l.qty, 0)
      expect(s.subtotalCents).toBe(lines)
      const paid = s.payments.reduce((a, p) => a + p.amountCents, 0)
      if (s.status === 'PAID') expect(paid).toBe(s.totalCents)
      else expect(paid).toBeLessThan(s.totalCents)
    }
    expect(sales.some(s => s.status === 'SAVED')).toBe(true)

    // stock movements for sales match the paid lines
    const movements = await prisma.stockMovement.aggregate({ where: { reason: 'SALE' }, _sum: { delta: true } })
    const soldQty = sales.filter(s => s.status === 'PAID').flatMap(s => s.lines).reduce((a, l) => a + l.qty, 0)
    expect(movements._sum.delta).toBe(-soldQty)
  })

  it('demo staff can sign in with the demo PIN', async () => {
    for (const u of ['wanjiru', 'otieno', 'achieng']) {
      const c = await Client.login(u, '1234')
      expect((await c.get('/api/session/me')).status).toBe(200)
    }
  })

  it('running it again changes nothing', async () => {
    const before = await prisma.sale.count()
    const r = await seedDemo({ log: quiet })
    expect(r.created).toBe(false)
    expect(await prisma.sale.count()).toBe(before)
    expect(await prisma.business.count({ where: { name: DEMO_BUSINESS } })).toBe(1)
  })

  it('reset rebuilds the demo without duplicates', async () => {
    const r = await seedDemo({ reset: true, log: quiet })
    expect(r.created).toBe(true)
    expect(await prisma.business.count({ where: { name: DEMO_BUSINESS } })).toBe(1)
    expect(await prisma.user.count({ where: { username: 'wanjiru' } })).toBe(1)
  })
})
