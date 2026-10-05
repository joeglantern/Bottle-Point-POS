import { Hono } from 'hono'
import { prisma } from '../db.js'
import { query } from '../lib/validate.js'
import { branchFor, requireRole, type AppEnv } from '../middleware/auth.js'
import { dailyReport, dayQuery, dayRange, headline, todayNairobi } from '../rules/reports.js'

export const reportRoutes = new Hono<AppEnv>()

reportRoutes.get('/daily', requireRole('MANAGER'), async c => {
  const q = query(c, dayQuery)
  const branchId = branchFor(c, q.branchId)
  const report = await dailyReport(branchId, q.date ?? todayNairobi())
  return c.json({ report })
})

reportRoutes.get('/branches', requireRole('OWNER'), async c => {
  const actor = c.get('actor')
  const q = query(c, dayQuery)
  const date = q.date ?? todayNairobi()
  const { start, end } = dayRange(date)
  const branches = await prisma.branch.findMany({
    where: { businessId: actor.businessId, active: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' }
  })
  const rows = await Promise.all(
    branches.map(async b => ({ branchId: b.id, branchName: b.name, ...(await headline(prisma, b.id, start, end)) }))
  )

  // combined row: add every money and count field; the average is recomputed
  const add = (pick: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + pick(r), 0)
  const paidCount = add(r => r.paidSales.count)
  const paidValue = add(r => r.paidSales.valueCents)
  const total = {
    takings: {
      cashCents: add(r => r.takings.cashCents),
      mpesaCents: add(r => r.takings.mpesaCents),
      totalCents: add(r => r.takings.totalCents)
    },
    partPayments: { count: add(r => r.partPayments.count), cents: add(r => r.partPayments.cents) },
    paidSales: { count: paidCount, valueCents: paidValue, averageCents: paidCount ? Math.round(paidValue / paidCount) : 0 },
    refunds: {
      count: add(r => r.refunds.count),
      valueCents: add(r => r.refunds.valueCents),
      cashCents: add(r => r.refunds.cashCents),
      mpesaCents: add(r => r.refunds.mpesaCents)
    },
    netCents: add(r => r.netCents),
    cancellations: { count: add(r => r.cancellations.count), valueCents: add(r => r.cancellations.valueCents) },
    discounts: { count: add(r => r.discounts.count), valueCents: add(r => r.discounts.valueCents) },
    unpaid: { count: add(r => r.unpaid.count), valueCents: add(r => r.unpaid.valueCents) }
  }

  return c.json({ date, from: start, to: end, branches: rows, total })
})
