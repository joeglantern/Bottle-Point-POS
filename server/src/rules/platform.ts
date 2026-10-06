// Shared pieces of the console and the billing engine: invoice numbering,
// raising invoices, estimates and small helpers. Every route file under
// routes/console and rules/billing.ts builds on these so they cannot disagree.
import { randomInt } from 'node:crypto'
import { z } from 'zod'
import type { Db, Invoice, Plan, Subscription } from '../db.js'
import { env } from '../env.js'
import { platformAudit } from '../lib/audit.js'
import { notFound } from '../lib/errors.js'
import { billedInArrears, monthlyValueCents, periodEnd, priceFor, type PeriodUsage, type Priced } from './pricing.js'
import { salesCentsBetween } from './usage.js'

export const DAY_MS = 86_400_000
// Invoices fall due this many days after they are issued.
export const DUE_DAYS = 7
// Reason written by the billing run when it suspends for non payment. Paying
// the invoice lifts only suspensions whose reason starts with this.
export const AUTO_SUSPEND_PREFIX = 'Unpaid invoice '

export type SubWithPlan = Subscription & { plan: Plan }

// Africa/Nairobi is UTC+3 all year.
const NAIROBI_MS = 3 * 3_600_000
const inNairobi = (d: Date) => new Date(d.getTime() + NAIROBI_MS)

// The instant a Nairobi calendar month starts, `addMonths` away from the month containing `d`.
export function nairobiMonthStart(d: Date, addMonths = 0): Date {
  const n = inNairobi(d)
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + addMonths, 1) - NAIROBI_MS)
}

// "2026-10" for the Nairobi month containing `d`.
export const nairobiMonthKey = (d: Date) => inNairobi(d).toISOString().slice(0, 7)

// List endpoints share these paging rules: spread into a z.object.
export const paging = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
}

// A fresh 6 digit PIN for a shop owner. Shown once, stored only as a hash.
export const randomPin = () => String(randomInt(0, 1_000_000)).padStart(6, '0')

// A strong temporary console password (no look alike characters).
export function temporaryPassword(length = 20): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  for (;;) {
    let out = ''
    for (let i = 0; i < length; i++) out += alphabet[randomInt(0, alphabet.length)]
    if (new Set(out).size >= 8) return out
  }
}

export async function requireBusiness(db: Db, businessId: string) {
  const business = await db.business.findUnique({ where: { id: businessId } })
  if (!business) throw notFound('Client')
  return business
}

// Lock the subscription row of a client for the rest of the transaction and
// return it fresh. Null when the business has no subscription record.
export async function lockSubscription(tx: Db, businessId: string): Promise<SubWithPlan | null> {
  await tx.$queryRaw`SELECT "id" FROM "Subscription" WHERE "businessId" = ${businessId} FOR UPDATE`
  return tx.subscription.findUnique({ where: { businessId }, include: { plan: true } })
}

// INV-<year>-<6 digits>. The counter row is bumped inside the transaction of
// the caller: concurrent callers queue on the row, and a rolled back invoice
// gives its number back, so numbers never repeat or leave gaps.
export async function nextInvoiceNumber(tx: Db, at: Date): Promise<string> {
  const year = inNairobi(at).getUTCFullYear()
  const rows = await tx.$queryRaw<{ last: number }[]>`
    INSERT INTO "InvoiceCounter" ("year", "last") VALUES (${year}, 1)
    ON CONFLICT ("year") DO UPDATE SET "last" = "InvoiceCounter"."last" + 1
    RETURNING "last"`
  return `INV-${year}-${String(rows[0]!.last).padStart(6, '0')}`
}

// The only place invoices are created. A zero total invoice is born PAID so
// there is a record without anything to chase. Call inside a transaction.
export async function createInvoice(
  tx: Db,
  input: {
    businessId: string
    subscriptionId?: string | null
    periodStart: Date
    periodEnd: Date
    priced: Priced
    issuedAt?: Date
    dueAt?: Date
    notes?: string | null
  }
): Promise<Invoice> {
  const issuedAt = input.issuedAt ?? new Date()
  const zero = input.priced.totalCents === 0
  return tx.invoice.create({
    data: {
      number: await nextInvoiceNumber(tx, issuedAt),
      businessId: input.businessId,
      subscriptionId: input.subscriptionId ?? null,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      lines: input.priced.lines as never,
      subtotalCents: input.priced.subtotalCents,
      taxCents: input.priced.taxCents,
      totalCents: input.priced.totalCents,
      status: zero ? 'PAID' : 'OPEN',
      paidAt: zero ? issuedAt : null,
      issuedAt,
      dueAt: input.dueAt ?? new Date(issuedAt.getTime() + DUE_DAYS * DAY_MS),
      notes: input.notes ?? null
    }
  })
}

// What pricing needs for one period: active branches now, and for share of
// sales plans the sales made between `from` and `to`.
export async function periodUsage(db: Db, sub: SubWithPlan, from: Date, to: Date): Promise<PeriodUsage> {
  const branches = await db.branch.count({ where: { businessId: sub.businessId, active: true } })
  const salesCents = billedInArrears(sub.plan) ? await salesCentsBetween(db, sub.businessId, from, to) : 0
  return { branches, salesCents }
}

// Raise the subscription invoice for one period (the period being paid for
// on in advance plans, the period that just ended on share of sales plans).
// Throws the unique (subscriptionId, periodStart) error if it already exists.
export async function raiseSubscriptionInvoice(tx: Db, sub: SubWithPlan, start: Date, end: Date, now: Date): Promise<Invoice> {
  const usage = await periodUsage(tx, sub, start, end)
  const priced = priceFor(sub.plan, sub, usage, env.PLATFORM_VAT_BPS)
  const invoice = await createInvoice(tx, {
    businessId: sub.businessId,
    subscriptionId: sub.id,
    periodStart: start,
    periodEnd: end,
    priced,
    issuedAt: now
  })
  await platformAudit(
    tx,
    null,
    'billing.invoice_created',
    'Invoice',
    invoice.id,
    { number: invoice.number, totalCents: invoice.totalCents, plan: sub.plan.code, periodStart: start, periodEnd: end },
    sub.businessId
  )
  return invoice
}

export async function hasOverdueInvoice(db: Db, businessId: string, now = new Date()): Promise<boolean> {
  return (await db.invoice.count({ where: { businessId, status: 'OPEN', dueAt: { lt: now } } })) > 0
}

// Recurring monthly value of a subscription. Only paying states count.
export function monthlyValue(sub: SubWithPlan, branches: number, sales30dCents: number): number {
  if (sub.status !== 'ACTIVE' && sub.status !== 'PAST_DUE') return 0
  return monthlyValueCents(sub.plan, sub, { branches, salesCents: sales30dCents })
}

export type Estimate = Priced & { periodStart: Date; periodEnd: Date; issueAt: Date }

// The next invoice the billing run will raise for this subscription, or null
// when there is none coming (ended, suspended, cancelling, or a paid licence).
// Share of sales estimates use the sales made so far in the period.
export async function estimateNextInvoice(db: Db, sub: SubWithPlan, now = new Date()): Promise<Estimate | null> {
  if (sub.status === 'CANCELLED' || sub.status === 'SUSPENDED' || sub.cancelAtPeriodEnd) return null
  const trial = sub.status === 'TRIALING'
  const arrears = billedInArrears(sub.plan)
  if (sub.plan.interval === 'ONCE' && !trial) return null
  const anchor = trial ? sub.trialEndsAt ?? sub.currentPeriodEnd : sub.currentPeriodEnd
  const start = arrears && !trial ? sub.currentPeriodStart : anchor
  const end = arrears && !trial ? sub.currentPeriodEnd : periodEnd(anchor, sub.plan.interval)
  const usage = await periodUsage(db, sub, start, now < end ? now : end)
  const priced = priceFor(sub.plan, sub, usage, env.PLATFORM_VAT_BPS)
  return { ...priced, periodStart: start, periodEnd: end, issueAt: arrears ? end : anchor }
}
