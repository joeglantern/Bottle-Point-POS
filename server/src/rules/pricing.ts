// What a client owes for one billing period. Pure functions, no database:
// the console, the billing run and the client's own billing page all price
// through here so they can never disagree.

import type { BillingInterval, Plan, Subscription } from '../db.js'

export type InvoiceLine = { description: string; quantity: number; unitCents: number; amountCents: number }

export type Priced = {
  lines: InvoiceLine[]
  subtotalCents: number
  taxCents: number
  totalCents: number
}

export type PlanTerms = Pick<
  Plan,
  'name' | 'model' | 'interval' | 'priceCents' | 'perBranchCents' | 'percentBps' | 'minimumCents'
>
export type DealTerms = Pick<Subscription, 'discountBps' | 'customPriceCents'>

// What pricing needs to know about the client for the period being billed.
export type PeriodUsage = {
  // active branches when the invoice is raised
  branches: number
  // paid sales net of refunds during the period (share of sales plans, billed in arrears)
  salesCents: number
}

const shillings = (cents: number) =>
  'KSh ' + (cents / 100).toLocaleString('en-KE', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })
const percent = (bps: number) => (bps / 100).toLocaleString('en-KE', { maximumFractionDigits: 2 }) + '%'
const per: Record<BillingInterval, string> = { MONTH: 'monthly', YEAR: 'yearly', ONCE: 'one time licence' }

export function priceFor(plan: PlanTerms, deal: DealTerms, usage: PeriodUsage, vatBps: number): Priced {
  const lines: InvoiceLine[] = []
  const one = (description: string, cents: number) => lines.push({ description, quantity: 1, unitCents: cents, amountCents: cents })

  if (deal.customPriceCents != null) {
    // a negotiated fixed amount replaces the plan's formula
    one(`${plan.name}, agreed price (${per[plan.interval]})`, deal.customPriceCents)
  } else if (plan.model === 'FLAT' || plan.model === 'ONE_TIME') {
    one(`${plan.name} (${per[plan.interval]})`, plan.priceCents)
  } else if (plan.model === 'PER_BRANCH') {
    if (plan.priceCents > 0) one(`${plan.name} base fee (${per[plan.interval]})`, plan.priceCents)
    const n = Math.max(0, Math.trunc(usage.branches))
    lines.push({
      description: `Branches at ${shillings(plan.perBranchCents)} each`,
      quantity: n,
      unitCents: plan.perBranchCents,
      amountCents: n * plan.perBranchCents
    })
  } else {
    // share of sales, with a floor
    const share = Math.round((Math.max(0, usage.salesCents) * plan.percentBps) / 10000)
    if (share >= plan.minimumCents) one(`${plan.name}: ${percent(plan.percentBps)} of ${shillings(usage.salesCents)} in sales`, share)
    else one(`${plan.name}: minimum fee (${percent(plan.percentBps)} of sales came to ${shillings(share)})`, plan.minimumCents)
  }

  const gross = lines.reduce((a, l) => a + l.amountCents, 0)
  if (deal.discountBps > 0 && gross > 0) {
    const off = Math.round((gross * deal.discountBps) / 10000)
    if (off > 0) lines.push({ description: `Discount ${percent(deal.discountBps)}`, quantity: 1, unitCents: -off, amountCents: -off })
  }

  const subtotalCents = lines.reduce((a, l) => a + l.amountCents, 0)
  const taxCents = Math.round((subtotalCents * vatBps) / 10000)
  return { lines, subtotalCents, taxCents, totalCents: subtotalCents + taxCents }
}

// A plan's price in words, for plan cards and the client's billing page.
export function describePrice(plan: PlanTerms): string {
  const every = plan.interval === 'YEAR' ? 'a year' : 'a month'
  if (plan.model === 'ONE_TIME') return `${shillings(plan.priceCents)} once`
  if (plan.model === 'FLAT') return `${shillings(plan.priceCents)} ${every}`
  if (plan.model === 'PER_BRANCH') {
    const each = `${shillings(plan.perBranchCents)} per branch ${every}`
    return plan.priceCents > 0 ? `${shillings(plan.priceCents)} ${every} plus ${each}` : each
  }
  const share = `${percent(plan.percentBps)} of sales`
  return plan.minimumCents > 0 ? `${share}, minimum ${shillings(plan.minimumCents)} ${every}` : share
}

// Recurring revenue this client is worth per month, before VAT. One time
// licences are not recurring. For share of sales plans pass the last 30 days
// of sales as usage.salesCents.
export function monthlyValueCents(plan: PlanTerms, deal: DealTerms, usage: PeriodUsage): number {
  if (plan.model === 'ONE_TIME' || plan.interval === 'ONCE') return 0
  const { subtotalCents } = priceFor(plan, deal, usage, 0)
  return plan.interval === 'YEAR' ? Math.round(subtotalCents / 12) : subtotalCents
}

// Share of sales is billed after the period, everything else before it.
export const billedInArrears = (plan: Pick<Plan, 'model'>) => plan.model === 'PERCENT_OF_SALES'

// End of the period that starts at `start`. Calendar months and years, with
// the day clamped (31 Jan + 1 month = 28 or 29 Feb). A one time licence never
// renews, so its period runs a hundred years.
export function periodEnd(start: Date, interval: BillingInterval): Date {
  const d = new Date(start.getTime())
  const day = d.getUTCDate()
  const addMonths = interval === 'MONTH' ? 1 : interval === 'YEAR' ? 12 : 1200
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + addMonths)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last))
  return d
}
