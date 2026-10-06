import { describe, expect, it } from 'vitest'
import { billedInArrears, describePrice, monthlyValueCents, periodEnd, priceFor, type PlanTerms } from '../src/rules/pricing.js'

const base: PlanTerms = { name: 'Plan', model: 'FLAT', interval: 'MONTH', priceCents: 0, perBranchCents: 0, percentBps: 0, minimumCents: 0 }
const noDeal = { discountBps: 0, customPriceCents: null }
const usage = { branches: 3, salesCents: 0 }
const sum = (p: { lines: { amountCents: number }[] }) => p.lines.reduce((a, l) => a + l.amountCents, 0)

describe('priceFor', () => {
  it('flat plan with 16% VAT', () => {
    const p = priceFor({ ...base, name: 'Starter', priceCents: 250000 }, noDeal, usage, 1600)
    expect(p).toMatchObject({ subtotalCents: 250000, taxCents: 40000, totalCents: 290000 })
    expect(p.lines).toHaveLength(1)
  })

  it('per branch plan charges the base fee plus each branch', () => {
    const plan = { ...base, model: 'PER_BRANCH' as const, priceCents: 150000, perBranchCents: 100000 }
    const p = priceFor(plan, noDeal, { branches: 3, salesCents: 0 }, 1600)
    expect(p.subtotalCents).toBe(150000 + 3 * 100000)
    expect(p.lines[1]).toMatchObject({ quantity: 3, unitCents: 100000, amountCents: 300000 })
    expect(p.totalCents).toBe(p.subtotalCents + p.taxCents)
  })

  it('per branch plan without a base fee has only the branch line', () => {
    const p = priceFor({ ...base, model: 'PER_BRANCH', perBranchCents: 120000 }, noDeal, { branches: 2, salesCents: 0 }, 0)
    expect(p.lines).toHaveLength(1)
    expect(p.subtotalCents).toBe(240000)
  })

  it('share of sales rounds to the cent', () => {
    const plan = { ...base, model: 'PERCENT_OF_SALES' as const, percentBps: 150, minimumCents: 100000 }
    const p = priceFor(plan, noDeal, { branches: 1, salesCents: 123456789 }, 1600)
    expect(p.subtotalCents).toBe(Math.round(123456789 * 0.015))
    expect(p.taxCents).toBe(Math.round(p.subtotalCents * 0.16))
  })

  it('share of sales never goes under the minimum', () => {
    const plan = { ...base, model: 'PERCENT_OF_SALES' as const, percentBps: 150, minimumCents: 100000 }
    expect(priceFor(plan, noDeal, { branches: 1, salesCents: 1000000 }, 0).subtotalCents).toBe(100000)
    expect(priceFor(plan, noDeal, { branches: 1, salesCents: 0 }, 0).subtotalCents).toBe(100000)
    // exactly at the floor uses the share line
    const at = priceFor(plan, noDeal, { branches: 1, salesCents: 6666667 }, 0)
    expect(at.subtotalCents).toBe(100000)
  })

  it('discount is its own negative line and VAT is on the discounted amount', () => {
    const p = priceFor({ ...base, priceCents: 250000 }, { discountBps: 2000, customPriceCents: null }, usage, 1600)
    expect(p.lines.at(-1)).toMatchObject({ amountCents: -50000 })
    expect(p.subtotalCents).toBe(200000)
    expect(p.taxCents).toBe(32000)
    expect(sum(p)).toBe(p.subtotalCents)
  })

  it('an agreed price replaces the formula for any model', () => {
    const plan = { ...base, model: 'PER_BRANCH' as const, priceCents: 150000, perBranchCents: 100000 }
    const p = priceFor(plan, { discountBps: 0, customPriceCents: 300000 }, { branches: 9, salesCents: 0 }, 0)
    expect(p.lines).toHaveLength(1)
    expect(p.subtotalCents).toBe(300000)
  })

  it('a full discount gives a zero invoice, never a negative one', () => {
    const p = priceFor({ ...base, priceCents: 250000 }, { discountBps: 10000, customPriceCents: null }, usage, 1600)
    expect(p).toMatchObject({ subtotalCents: 0, taxCents: 0, totalCents: 0 })
  })

  it('lines always add up to the subtotal', () => {
    for (const branches of [0, 1, 7]) {
      for (const discountBps of [0, 333, 5000]) {
        const p = priceFor({ ...base, model: 'PER_BRANCH', priceCents: 99999, perBranchCents: 33333 }, { discountBps, customPriceCents: null }, { branches, salesCents: 0 }, 1600)
        expect(sum(p)).toBe(p.subtotalCents)
        expect(p.totalCents).toBe(p.subtotalCents + p.taxCents)
        expect(p.subtotalCents).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

describe('describePrice', () => {
  it('reads like a person wrote it', () => {
    expect(describePrice({ ...base, priceCents: 250000 })).toBe('KSh 2,500 a month')
    expect(describePrice({ ...base, interval: 'YEAR', priceCents: 2500000 })).toBe('KSh 25,000 a year')
    expect(describePrice({ ...base, model: 'PER_BRANCH', priceCents: 150000, perBranchCents: 100000 })).toBe('KSh 1,500 a month plus KSh 1,000 per branch a month')
    expect(describePrice({ ...base, model: 'PERCENT_OF_SALES', percentBps: 150, minimumCents: 100000 })).toBe('1.5% of sales, minimum KSh 1,000 a month')
    expect(describePrice({ ...base, model: 'ONE_TIME', interval: 'ONCE', priceCents: 4500000 })).toBe('KSh 45,000 once')
  })
})

describe('monthlyValueCents', () => {
  it('yearly plans count a twelfth, one time licences count nothing', () => {
    expect(monthlyValueCents({ ...base, priceCents: 250000 }, noDeal, usage)).toBe(250000)
    expect(monthlyValueCents({ ...base, interval: 'YEAR', priceCents: 2400000 }, noDeal, usage)).toBe(200000)
    expect(monthlyValueCents({ ...base, model: 'ONE_TIME', interval: 'ONCE', priceCents: 4500000 }, noDeal, usage)).toBe(0)
    expect(monthlyValueCents({ ...base, priceCents: 250000 }, { discountBps: 1000, customPriceCents: null }, usage)).toBe(225000)
  })
})

describe('periods', () => {
  it('adds calendar months and clamps the day', () => {
    expect(periodEnd(new Date('2026-01-31T09:00:00Z'), 'MONTH').toISOString()).toBe('2026-02-28T09:00:00.000Z')
    expect(periodEnd(new Date('2024-01-31T09:00:00Z'), 'MONTH').toISOString()).toBe('2024-02-29T09:00:00.000Z')
    expect(periodEnd(new Date('2026-10-06T00:00:00Z'), 'MONTH').toISOString()).toBe('2026-11-06T00:00:00.000Z')
    expect(periodEnd(new Date('2026-12-15T00:00:00Z'), 'MONTH').toISOString()).toBe('2027-01-15T00:00:00.000Z')
    expect(periodEnd(new Date('2024-02-29T00:00:00Z'), 'YEAR').toISOString()).toBe('2025-02-28T00:00:00.000Z')
    expect(periodEnd(new Date('2026-10-06T00:00:00Z'), 'ONCE').getUTCFullYear()).toBe(2126)
  })

  it('only share of sales is billed after the period', () => {
    expect(billedInArrears({ model: 'PERCENT_OF_SALES' })).toBe(true)
    expect(billedInArrears({ model: 'FLAT' })).toBe(false)
  })
})
