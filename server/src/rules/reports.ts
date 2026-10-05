// Day boundaries and the per branch daily figures. A "day" is always an
// Africa/Nairobi calendar day (UTC+3, no daylight saving).

import { z } from 'zod'
import { prisma, Prisma, type Db } from '../db.js'
import { shiftsOverlapping } from './shifts.js'

const NAIROBI_OFFSET_MS = 3 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export function todayNairobi(now = new Date()) {
  return new Date(now.getTime() + NAIROBI_OFFSET_MS).toISOString().slice(0, 10)
}

// [start, end) of a Nairobi day as UTC instants.
export function dayRange(date: string) {
  const start = new Date(`${date}T00:00:00+03:00`)
  return { start, end: new Date(start.getTime() + DAY_MS) }
}

export const dateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must look like 2026-10-05')
  .refine(s => {
    const d = new Date(`${s}T00:00:00Z`)
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
  }, 'Not a real date')

export const dayQuery = z.object({ date: dateField.optional(), branchId: z.string().max(64).optional() })

const n = (v: number | bigint | null | undefined) => Number(v ?? 0)
const avg = (value: number, count: number) => (count ? Math.round(value / count) : 0)
const HOUR = 60 * 60 * 1000

async function userNames(db: Db, ids: (string | null)[]) {
  const list = [...new Set(ids.filter((x): x is string => !!x))]
  if (!list.length) return new Map<string, string>()
  const users = await db.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } })
  return new Map(users.map(u => [u.id, u.name]))
}

// The figures shown both on the daily report and per branch on the owner's
// comparison. See docs/api/reports.md for the exact definitions.
export async function headline(db: Db, branchId: string, start: Date, end: Date) {
  const day = { gte: start, lt: end }
  const [takings, partPaid, paid, cancelled, refunds, discounts, unpaid] = await Promise.all([
    db.payment.groupBy({
      by: ['method'],
      where: { createdAt: day, sale: { branchId, status: { in: ['PAID', 'REFUNDED'] } } },
      _sum: { amountCents: true },
      _count: { _all: true }
    }),
    db.payment.aggregate({
      where: { createdAt: day, sale: { branchId, status: { in: ['SAVED', 'OPEN'] } } },
      _sum: { amountCents: true },
      _count: { _all: true }
    }),
    db.sale.aggregate({
      where: { branchId, status: { in: ['PAID', 'REFUNDED'] }, paidAt: day },
      _sum: { totalCents: true },
      _count: { _all: true }
    }),
    db.sale.aggregate({
      where: { branchId, status: 'CANCELLED', cancelledAt: day },
      _sum: { totalCents: true },
      _count: { _all: true }
    }),
    db.refund.groupBy({
      by: ['method'],
      where: { createdAt: day, sale: { branchId } },
      _sum: { amountCents: true },
      _count: { _all: true }
    }),
    db.approval.aggregate({
      where: { kind: 'DISCOUNT', status: 'APPROVED', decidedAt: day, sale: { branchId } },
      _sum: { amountCents: true },
      _count: { _all: true }
    }),
    db.sale.aggregate({
      where: { branchId, status: 'SAVED', createdAt: { lt: end } },
      _sum: { totalCents: true },
      _count: { _all: true }
    })
  ])

  const by = (rows: typeof takings | typeof refunds, m: 'CASH' | 'MPESA') => {
    const r = rows.find(x => x.method === m)
    return { count: n(r?._count._all), cents: n(r?._sum.amountCents) }
  }
  const cash = by(takings, 'CASH')
  const mpesa = by(takings, 'MPESA')
  const rCash = by(refunds, 'CASH')
  const rMpesa = by(refunds, 'MPESA')
  const takingsCents = cash.cents + mpesa.cents
  const refundsCents = rCash.cents + rMpesa.cents
  const paidCount = n(paid._count._all)
  const paidValue = n(paid._sum.totalCents)

  return {
    takings: { cashCents: cash.cents, mpesaCents: mpesa.cents, totalCents: takingsCents },
    partPayments: { count: n(partPaid._count._all), cents: n(partPaid._sum.amountCents) },
    paidSales: { count: paidCount, valueCents: paidValue, averageCents: avg(paidValue, paidCount) },
    refunds: {
      count: rCash.count + rMpesa.count,
      valueCents: refundsCents,
      cashCents: rCash.cents,
      mpesaCents: rMpesa.cents
    },
    netCents: takingsCents - refundsCents,
    cancellations: { count: n(cancelled._count._all), valueCents: n(cancelled._sum.totalCents) },
    discounts: { count: n(discounts._count._all), valueCents: n(discounts._sum.amountCents) },
    unpaid: { count: n(unpaid._count._all), valueCents: n(unpaid._sum.totalCents) }
  }
}

type TopRow = { productId: string; name: string; qty: bigint; valueCents: bigint }

export async function dailyReport(branchId: string, date: string, now = new Date()) {
  const { start, end } = dayRange(date)
  const db = prisma
  const s = start.toISOString()
  const e = end.toISOString()
  // DateTime columns are "timestamp without time zone" holding UTC, so the
  // bounds go in as UTC text and are cast.
  const topSql = (order: Prisma.Sql) => db.$queryRaw<TopRow[]>`
    SELECT l."productId" AS "productId", MAX(l."name") AS "name",
           SUM(l."qty")::bigint AS "qty", SUM(l."qty" * l."unitCents")::bigint AS "valueCents"
    FROM "SaleLine" l JOIN "Sale" s ON s.id = l."saleId"
    WHERE s."branchId" = ${branchId} AND s.status = 'PAID'
      AND s."paidAt" >= ${s}::timestamp AND s."paidAt" < ${e}::timestamp
    GROUP BY l."productId"
    ORDER BY ${order}
    LIMIT 10`

  const unpaidWhere = { branchId, status: 'SAVED' as const, createdAt: { lt: end } }
  const ago = (h: number) => new Date(now.getTime() - h * HOUR)

  const [head, cashiers, topValue, topQty, under1h, h1to4, over4h, unpaidPaid, oldest, unverified, stkUnlinked, stkList, shifts] =
    await Promise.all([
      headline(db, branchId, start, end),
      db.sale.groupBy({
        by: ['paidById'],
        where: { branchId, status: { in: ['PAID', 'REFUNDED'] }, paidAt: { gte: start, lt: end } },
        _sum: { totalCents: true },
        _count: { _all: true }
      }),
      topSql(Prisma.sql`"valueCents" DESC, "qty" DESC`),
      topSql(Prisma.sql`"qty" DESC, "valueCents" DESC`),
      db.sale.aggregate({ where: { ...unpaidWhere, createdAt: { lt: end, gt: ago(1) } }, _count: { _all: true }, _sum: { totalCents: true } }),
      db.sale.aggregate({ where: { ...unpaidWhere, createdAt: { lt: end, gt: ago(4), lte: ago(1) } }, _count: { _all: true }, _sum: { totalCents: true } }),
      db.sale.aggregate({ where: { ...unpaidWhere, createdAt: { lt: end, lte: ago(4) } }, _count: { _all: true }, _sum: { totalCents: true } }),
      db.payment.aggregate({ where: { sale: unpaidWhere }, _sum: { amountCents: true } }),
      db.sale.findMany({
        where: unpaidWhere,
        orderBy: { createdAt: 'asc' },
        take: 5,
        select: { id: true, number: true, label: true, totalCents: true, createdAt: true, createdById: true }
      }),
      db.payment.aggregate({
        where: { verification: 'MANUAL_UNVERIFIED', createdAt: { lt: end }, sale: { branchId } },
        _sum: { amountCents: true },
        _count: { _all: true }
      }),
      db.mpesaRequest.aggregate({
        where: { branchId, status: 'SUCCESS', payment: { is: null }, createdAt: { lt: end } },
        _sum: { amountCents: true },
        _count: { _all: true }
      }),
      db.mpesaRequest.findMany({
        where: { branchId, status: 'SUCCESS', payment: { is: null }, createdAt: { lt: end } },
        orderBy: { createdAt: 'asc' },
        take: 10,
        select: { id: true, saleId: true, phone: true, amountCents: true, receipt: true, createdAt: true }
      }),
      shiftsOverlapping(db, branchId, start, end)
    ])

  const names = await userNames(db, [...cashiers.map(r => r.paidById), ...oldest.map(o => o.createdById)])
  const bucket = (a: typeof under1h) => ({ count: n(a._count._all), valueCents: n(a._sum.totalCents) })
  const top = (rows: TopRow[]) =>
    rows.map(r => ({ productId: r.productId, name: r.name, qty: n(r.qty), valueCents: n(r.valueCents) }))

  return {
    branchId,
    date,
    from: start,
    to: end,
    ...head,
    unpaid: {
      ...head.unpaid,
      dueCents: head.unpaid.valueCents - n(unpaidPaid._sum.amountCents),
      buckets: { under1h: bucket(under1h), from1to4h: bucket(h1to4), over4h: bucket(over4h) },
      oldest: oldest.map(o => ({
        id: o.id,
        number: o.number,
        label: o.label,
        totalCents: o.totalCents,
        createdAt: o.createdAt,
        ageMinutes: Math.floor((now.getTime() - o.createdAt.getTime()) / 60000),
        openedById: o.createdById,
        openedByName: names.get(o.createdById) ?? null
      }))
    },
    cashiers: cashiers
      .map(r => ({
        userId: r.paidById,
        name: r.paidById ? (names.get(r.paidById) ?? null) : null,
        count: n(r._count._all),
        valueCents: n(r._sum.totalCents)
      }))
      .sort((a, b) => b.valueCents - a.valueCents),
    topProducts: { byValue: top(topValue), byQty: top(topQty) },
    mpesaUnverified: { count: n(unverified._count._all), valueCents: n(unverified._sum.amountCents) },
    stkUnlinked: { count: n(stkUnlinked._count._all), valueCents: n(stkUnlinked._sum.amountCents), requests: stkList },
    shifts
  }
}
