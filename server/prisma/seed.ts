// Demo data for Bottle Point. Matches the demo screens in web/src/data.js.
//   npm run db:seed            creates whatever demo data is missing (safe to rerun)
//   npm run db:seed -- --reset deletes the demo businesses and creates them again
// Besides the demo shop it adds the default plans, a subscription with
// invoices for the demo shop, and six small client businesses in different
// billing states so the console has something to show. Plans and console
// users are never deleted.
// Every demo PIN is 1234. Never use this data for a real shop.

import {
  prisma,
  type BillingInterval,
  type PayMethod,
  type PaymentVerification,
  type PricingModel,
  type SubscriptionStatus,
  type Tx
} from '../src/db.js'
import { createStaff } from '../src/lib/users.js'
import { AUTO_SUSPEND_PREFIX, raiseSubscriptionInvoice } from '../src/rules/platform.js'
import { billedInArrears, periodEnd } from '../src/rules/pricing.js'
import { applyPayment } from '../src/rules/sale-core.js'

export const DEMO_BUSINESS = 'Bottle Point Demo'
export const DEMO_PIN = '1234'

type BranchKey = 'wl' | 'kl' | 'th'

const BRANCHES: { key: BranchKey; name: string; firstSaleNo: number }[] = [
  { key: 'wl', name: 'Westlands', firstSaleNo: 1041 },
  { key: 'kl', name: 'Kilimani', firstSaleNo: 2001 },
  { key: 'th', name: 'Thika Road', firstSaleNo: 3001 }
]

const STAFF: { username: string; name: string; role: 'CASHIER' | 'MANAGER' | 'OWNER'; branch: BranchKey | null }[] = [
  { username: 'wanjiru', name: 'Wanjiru K.', role: 'CASHIER', branch: 'wl' },
  { username: 'brian', name: 'Brian M.', role: 'CASHIER', branch: 'wl' },
  { username: 'otieno', name: 'Otieno J.', role: 'MANAGER', branch: 'wl' },
  { username: 'achieng', name: 'Achieng O.', role: 'OWNER', branch: null },
  { username: 'mercy', name: 'Mercy A.', role: 'CASHIER', branch: 'kl' },
  { username: 'daniel', name: 'Daniel N.', role: 'MANAGER', branch: 'kl' },
  { username: 'akinyi', name: 'Akinyi W.', role: 'CASHIER', branch: 'th' },
  { username: 'samuel', name: 'Samuel M.', role: 'MANAGER', branch: 'th' }
]

// Same names, sizes, categories, barcodes and prices as the demo screens.
// `stock` is what Westlands shows on the shelf once the day's sales are in.
const PRODUCTS = [
  { key: 'p1', name: 'Johnnie Walker Black', sizeMl: 750, category: 'Whisky', price: 4800, barcode: '5000267024004', stock: 24 },
  { key: 'p2', name: 'Jameson Irish', sizeMl: 750, category: 'Whisky', price: 3200, barcode: '5011007003029', stock: 31 },
  { key: 'p3', name: 'Glenfiddich 12', sizeMl: 750, category: 'Whisky', price: 7900, barcode: '5010327000176', stock: 6 },
  { key: 'p4', name: 'Smirnoff Red', sizeMl: 750, category: 'Vodka', price: 1650, barcode: '5410316950026', stock: 40 },
  { key: 'p5', name: 'Chrome Vodka', sizeMl: 750, category: 'Vodka', price: 950, barcode: '6161101560012', stock: 52 },
  { key: 'p6', name: "Gilbey's Gin", sizeMl: 750, category: 'Gin', price: 1450, barcode: '6161101560203', stock: 18 },
  { key: 'p7', name: 'Tanqueray London Dry', sizeMl: 750, category: 'Gin', price: 3600, barcode: '5000291020706', stock: 4 },
  { key: 'p8', name: 'Four Cousins Red', sizeMl: 750, category: 'Wine', price: 1100, barcode: '6001495062508', stock: 36 },
  { key: 'p9', name: 'Nederburg Cabernet', sizeMl: 750, category: 'Wine', price: 1900, barcode: '6001452303001', stock: 9 },
  { key: 'p10', name: 'Tusker Lager', sizeMl: 500, category: 'Beer', price: 280, barcode: '6161100010017', stock: 120 },
  { key: 'p11', name: 'Guinness', sizeMl: 500, category: 'Beer', price: 320, barcode: '6161100010147', stock: 0 },
  { key: 'p12', name: 'White Cap', sizeMl: 500, category: 'Beer', price: 290, barcode: '6161100010031', stock: 96 },
  { key: 'p13', name: 'Captain Morgan Spiced', sizeMl: 750, category: 'Rum', price: 2300, barcode: '5000299223031', stock: 14 },
  { key: 'p14', name: 'Kenya Cane', sizeMl: 750, category: 'Rum', price: 1050, barcode: '6161101560104', stock: 3 },
  { key: 'p15', name: 'Hennessy VS', sizeMl: 700, category: 'Cognac', price: 6900, barcode: '3245990001218', stock: 7 }
] as const
type ProductKey = (typeof PRODUCTS)[number]['key']

// Shelf stock for the other branches once the day is over.
const OTHER_STOCK: Record<'kl' | 'th', Partial<Record<ProductKey, number>>> = {
  kl: { p1: 18, p2: 22, p3: 8, p4: 30, p5: 44, p6: 20, p7: 9, p8: 28, p9: 12, p10: 140, p11: 36, p12: 80, p13: 11, p14: 15, p15: 5 },
  th: { p1: 12, p2: 16, p3: 3, p4: 26, p5: 60, p6: 14, p7: 6, p8: 20, p9: 7, p10: 180, p11: 48, p12: 110, p13: 9, p14: 22, p15: 4 }
}

const CUSTOMERS = [
  { key: 'c1', name: 'James Kamau', phone: '254712345481' },
  { key: 'c2', name: 'Grace Wambui', phone: '254722118106' },
  { key: 'c3', name: 'Table 4 regulars', phone: null },
  { key: 'c4', name: 'Peter Otieno', phone: '254733450920' },
  { key: 'c5', name: 'Faith Njeri', phone: '254701562334' },
  { key: 'c6', name: 'Kevin Mutua', phone: '254745210772' }
] as const
type CustomerKey = (typeof CUSTOMERS)[number]['key']

type PlannedPayment =
  | { method: 'CASH'; amount: number }
  // stk: confirmed by Safaricom. typed: cashier typed the code from the SMS.
  | { method: 'MPESA'; amount: number; ref: string; via: 'stk' | 'typed'; phone: string }

type PlannedSale = {
  branch: BranchKey
  cashier: string
  minsAgo: number
  lines: [ProductKey, number][]
  status: 'PAID' | 'SAVED' | 'CANCELLED'
  label?: string
  customer?: CustomerKey
  payments?: PlannedPayment[]
  cancelledBy?: string
}

// Westlands mirrors SEED_SALES in web/src/data.js (#1041 to #1047).
const SALES: PlannedSale[] = [
  { branch: 'wl', cashier: 'wanjiru', minsAgo: 310, status: 'PAID', lines: [['p1', 1], ['p10', 6]], payments: [{ method: 'CASH', amount: 6480 }] },
  { branch: 'wl', cashier: 'brian', minsAgo: 260, status: 'PAID', lines: [['p15', 1]], payments: [{ method: 'MPESA', amount: 6900, ref: 'SJK4H7QW2P', via: 'stk', phone: '254722118106' }] },
  { branch: 'wl', cashier: 'wanjiru', minsAgo: 200, status: 'PAID', lines: [['p6', 2], ['p11', 4]], payments: [{ method: 'CASH', amount: 2000 }, { method: 'MPESA', amount: 2180, ref: 'SJK5B2LM9X', via: 'typed', phone: '254711204587' }] },
  { branch: 'wl', cashier: 'brian', minsAgo: 140, status: 'SAVED', label: 'Table 4', customer: 'c3', lines: [['p10', 8], ['p2', 1]] },
  { branch: 'wl', cashier: 'wanjiru', minsAgo: 95, status: 'PAID', customer: 'c5', lines: [['p8', 2], ['p4', 1]], payments: [{ method: 'MPESA', amount: 3850, ref: 'SJK6C8NT4R', via: 'stk', phone: '254701562334' }] },
  { branch: 'wl', cashier: 'brian', minsAgo: 40, status: 'SAVED', label: 'Mr Kamau', customer: 'c1', lines: [['p3', 1]] },
  { branch: 'wl', cashier: 'brian', minsAgo: 25, status: 'CANCELLED', lines: [['p5', 1]], cancelledBy: 'otieno' },

  { branch: 'kl', cashier: 'mercy', minsAgo: 330, status: 'PAID', lines: [['p10', 4], ['p12', 2]], payments: [{ method: 'CASH', amount: 1700 }] },
  { branch: 'kl', cashier: 'mercy', minsAgo: 300, status: 'PAID', lines: [['p2', 1]], payments: [{ method: 'MPESA', amount: 3200, ref: 'SJL1A2B3C4', via: 'stk', phone: '254798301245' }] },
  { branch: 'kl', cashier: 'mercy', minsAgo: 270, status: 'PAID', lines: [['p4', 1], ['p10', 3]], payments: [{ method: 'CASH', amount: 2490 }] },
  { branch: 'kl', cashier: 'mercy', minsAgo: 220, status: 'PAID', lines: [['p8', 1], ['p9', 1]], payments: [{ method: 'MPESA', amount: 3000, ref: 'SJL2D5E6F7', via: 'typed', phone: '254708456123' }] },
  { branch: 'kl', cashier: 'mercy', minsAgo: 180, status: 'PAID', lines: [['p13', 1]], payments: [{ method: 'CASH', amount: 2300 }] },
  { branch: 'kl', cashier: 'mercy', minsAgo: 130, status: 'PAID', customer: 'c2', lines: [['p1', 1]], payments: [{ method: 'CASH', amount: 2000 }, { method: 'MPESA', amount: 2800, ref: 'SJL3G8H9J1', via: 'stk', phone: '254722118106' }] },
  { branch: 'kl', cashier: 'mercy', minsAgo: 90, status: 'PAID', lines: [['p12', 6]], payments: [{ method: 'CASH', amount: 1740 }] },
  { branch: 'kl', cashier: 'mercy', minsAgo: 60, status: 'PAID', lines: [['p7', 1]], payments: [{ method: 'MPESA', amount: 3600, ref: 'SJL4K2M3N5', via: 'stk', phone: '254757880214' }] },
  { branch: 'kl', cashier: 'mercy', minsAgo: 45, status: 'SAVED', label: 'Kevin Mutua', customer: 'c6', lines: [['p4', 1]] },
  { branch: 'kl', cashier: 'mercy', minsAgo: 20, status: 'SAVED', label: 'Counter 2', lines: [['p11', 5], ['p14', 1]] },

  { branch: 'th', cashier: 'akinyi', minsAgo: 300, status: 'PAID', lines: [['p10', 6]], payments: [{ method: 'CASH', amount: 1680 }] },
  { branch: 'th', cashier: 'akinyi', minsAgo: 250, status: 'PAID', lines: [['p5', 2]], payments: [{ method: 'CASH', amount: 1900 }] },
  { branch: 'th', cashier: 'akinyi', minsAgo: 210, status: 'PAID', lines: [['p6', 1], ['p12', 2]], payments: [{ method: 'MPESA', amount: 2030, ref: 'SJM1P4Q5R6', via: 'stk', phone: '254712009876' }] },
  { branch: 'th', cashier: 'akinyi', minsAgo: 160, status: 'PAID', lines: [['p14', 2]], payments: [{ method: 'CASH', amount: 2100 }] },
  { branch: 'th', cashier: 'akinyi', minsAgo: 120, status: 'PAID', lines: [['p8', 2]], payments: [{ method: 'MPESA', amount: 2200, ref: 'SJM2S7T8U9', via: 'typed', phone: '254790334512' }] },
  { branch: 'th', cashier: 'akinyi', minsAgo: 75, status: 'PAID', customer: 'c4', lines: [['p3', 1]], payments: [{ method: 'MPESA', amount: 7900, ref: 'SJM3V1W2X3', via: 'stk', phone: '254733450920' }] },
  { branch: 'th', cashier: 'akinyi', minsAgo: 30, status: 'PAID', lines: [['p10', 4], ['p11', 2]], payments: [{ method: 'CASH', amount: 1760 }] }
]

const KSH = 100
const MIN = 60_000

type Log = (msg: string) => void

export type SeedResult = { created: boolean; businessId: string }

// Deletes the demo business and everything that hangs off it. The audit log
// is append only and has no foreign keys, so its rows are left alone.
async function deleteDemo(tx: Tx, businessIds: string[]) {
  const branchIds = (await tx.branch.findMany({ where: { businessId: { in: businessIds } }, select: { id: true } })).map(b => b.id)
  const bySale = { sale: { branchId: { in: branchIds } } }
  await tx.refund.deleteMany({ where: bySale })
  await tx.approval.deleteMany({ where: bySale })
  await tx.payment.deleteMany({ where: bySale })
  await tx.mpesaRequest.deleteMany({ where: { branchId: { in: branchIds } } })
  await tx.sale.deleteMany({ where: { branchId: { in: branchIds } } })
  await tx.shift.deleteMany({ where: { branchId: { in: branchIds } } })
  await tx.stockMovement.deleteMany({ where: { branchId: { in: branchIds } } })
  await tx.stock.deleteMany({ where: { branchId: { in: branchIds } } })
  await tx.product.deleteMany({ where: { businessId: { in: businessIds } } })
  await tx.customer.deleteMany({ where: { businessId: { in: businessIds } } })
  await tx.user.deleteMany({ where: { businessId: { in: businessIds } } })
  await tx.branch.deleteMany({ where: { id: { in: branchIds } } })
  await tx.business.deleteMany({ where: { id: { in: businessIds } } })
}

// The demo shop itself: branches, staff, products and one day of sales.
async function seedDemoShop(opts: { reset?: boolean; log?: Log; now?: Date } = {}): Promise<SeedResult> {
  const log: Log = opts.log ?? (m => console.log(m))
  const now = opts.now ?? new Date()
  const ago = (mins: number) => new Date(now.getTime() - mins * MIN)

  if (opts.reset && process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to reset demo data while NODE_ENV is production.')
  }

  const existing = await prisma.business.findMany({ where: { name: DEMO_BUSINESS }, select: { id: true } })
  if (existing.length && !opts.reset) {
    log(`The demo business "${DEMO_BUSINESS}" already exists. Run with --reset to recreate it.`)
    return { created: false, businessId: existing[0]!.id }
  }
  if (existing.length) {
    await prisma.$transaction(tx => deleteDemo(tx, existing.map(b => b.id)), { timeout: 60_000 })
    log(`Deleted the old demo business "${DEMO_BUSINESS}".`)
  }

  // ---------- business, branches, staff ----------
  const business = await prisma.business.create({ data: { name: DEMO_BUSINESS } })
  const branch = {} as Record<BranchKey, string>
  for (const b of BRANCHES) {
    const row = await prisma.branch.create({ data: { businessId: business.id, name: b.name, nextSaleNo: b.firstSaleNo } })
    branch[b.key] = row.id
  }

  const user: Record<string, string> = {}
  for (const s of STAFF) {
    const u = await createStaff(prisma, {
      businessId: business.id,
      name: s.name,
      username: s.username,
      pin: DEMO_PIN,
      role: s.role,
      branchIds: s.branch ? [branch[s.branch]] : []
    })
    user[s.username] = u.id
  }
  const managerOf: Record<BranchKey, string> = { wl: user.otieno!, kl: user.daniel!, th: user.samuel! }

  // ---------- products and opening stock ----------
  const product = {} as Record<ProductKey, { id: string; name: string; priceCents: number }>
  for (const p of PRODUCTS) {
    const row = await prisma.product.create({
      data: { businessId: business.id, name: p.name, sizeMl: p.sizeMl, category: p.category, barcode: p.barcode, priceCents: p.price * KSH }
    })
    product[p.key] = { id: row.id, name: row.name, priceCents: row.priceCents }
  }

  // Opening stock is what is on the shelf at the end of the day plus what
  // the paid sales take off, so the numbers land exactly on the demo screens.
  const sold = new Map<string, number>()
  for (const s of SALES) {
    if (s.status !== 'PAID') continue
    for (const [k, qty] of s.lines) sold.set(`${s.branch}:${k}`, (sold.get(`${s.branch}:${k}`) ?? 0) + qty)
  }
  const openedAt = ago(12 * 60)
  for (const b of BRANCHES) {
    for (const p of PRODUCTS) {
      const shelf = b.key === 'wl' ? p.stock : (OTHER_STOCK[b.key][p.key] ?? 0)
      const opening = shelf + (sold.get(`${b.key}:${p.key}`) ?? 0)
      const reorderAt = p.category === 'Beer' ? 24 : 6
      await prisma.stock.create({ data: { branchId: branch[b.key], productId: product[p.key].id, qty: opening, reorderAt } })
      if (opening > 0) {
        await prisma.stockMovement.create({
          data: { branchId: branch[b.key], productId: product[p.key].id, delta: opening, reason: 'RECEIVE', userId: managerOf[b.key], note: 'Opening stock', createdAt: openedAt }
        })
      }
    }
  }

  // ---------- customers ----------
  const customer = {} as Record<CustomerKey, string>
  for (const cu of CUSTOMERS) {
    const row = await prisma.customer.create({ data: { businessId: business.id, name: cu.name, phone: cu.phone } })
    customer[cu.key] = row.id
  }

  // ---------- shifts: every cashier who sells today has one open ----------
  const shift: Record<string, string> = {}
  for (const s of SALES) {
    const key = `${s.branch}:${s.cashier}`
    if (shift[key]) continue
    const first = Math.max(...SALES.filter(x => x.branch === s.branch && x.cashier === s.cashier).map(x => x.minsAgo))
    const row = await prisma.shift.create({
      data: { branchId: branch[s.branch], userId: user[s.cashier]!, openingFloatCents: 5000 * KSH, openedAt: ago(first + 30) }
    })
    shift[key] = row.id
  }

  // ---------- the day's sales ----------
  let paid = 0
  for (const s of [...SALES].sort((a, b) => b.minsAgo - a.minsAgo)) {
    const at = ago(s.minsAgo)
    const branchId = branch[s.branch]
    const cashierId = user[s.cashier]!
    const shiftId = shift[`${s.branch}:${s.cashier}`]!
    await prisma.$transaction(async tx => {
      const { nextSaleNo } = await tx.branch.update({ where: { id: branchId }, data: { nextSaleNo: { increment: 1 } }, select: { nextSaleNo: true } })
      const lines = s.lines.map(([k, qty]) => ({ productId: product[k].id, name: product[k].name, unitCents: product[k].priceCents, qty }))
      const subtotal = lines.reduce((a, l) => a + l.unitCents * l.qty, 0)
      const sale = await tx.sale.create({
        data: {
          number: nextSaleNo - 1,
          branchId,
          createdById: cashierId,
          label: s.label ?? null,
          customerId: s.customer ? customer[s.customer] : null,
          status: 'SAVED',
          subtotalCents: subtotal,
          totalCents: subtotal,
          createdAt: at,
          lines: { create: lines }
        }
      })

      if (s.status === 'CANCELLED') {
        await tx.sale.update({ where: { id: sale.id }, data: { status: 'CANCELLED', cancelledAt: ago(s.minsAgo - 2), version: { increment: 1 } } })
        await tx.approval.create({
          data: {
            saleId: sale.id,
            kind: 'CANCEL',
            status: 'APPROVED',
            reason: 'Customer changed their mind',
            requestedById: cashierId,
            decidedById: user[s.cancelledBy ?? 'otieno']!,
            decidedAt: ago(s.minsAgo - 2),
            createdAt: ago(s.minsAgo - 1)
          }
        })
        return
      }
      if (s.status !== 'PAID') return

      const total = (s.payments ?? []).reduce((a, p) => a + p.amount * KSH, 0)
      if (total !== subtotal) throw new Error(`Seed sale at ${s.branch} ${s.minsAgo} min ago does not add up`)
      for (const p of s.payments ?? []) {
        const amountCents = p.amount * KSH
        let method: PayMethod = 'CASH'
        let verification: PaymentVerification = 'CASH'
        let mpesaRequestId: string | null = null
        if (p.method === 'MPESA') {
          method = 'MPESA'
          verification = p.via === 'stk' ? 'STK_CONFIRMED' : 'MANUAL_UNVERIFIED'
          if (p.via === 'stk') {
            const req = await tx.mpesaRequest.create({
              data: {
                saleId: sale.id,
                branchId,
                phone: p.phone,
                amountCents,
                merchantRequestId: `DEMO-M-${p.ref}`,
                checkoutRequestId: `ws_CO_DEMO_${p.ref}`,
                status: 'SUCCESS',
                resultCode: 0,
                resultDesc: 'The service request is processed successfully.',
                receipt: p.ref,
                requestedById: cashierId,
                shiftId,
                createdAt: at
              }
            })
            mpesaRequestId = req.id
          }
        }
        await applyPayment(tx, {
          saleId: sale.id,
          method,
          amountCents,
          // cash customers hand over round notes
          tenderedCents: p.method === 'CASH' ? Math.ceil(p.amount / 100) * 100 * KSH : null,
          mpesaRef: p.method === 'MPESA' ? p.ref : null,
          phone: p.method === 'MPESA' ? p.phone : null,
          verification,
          mpesaRequestId,
          receivedById: cashierId,
          shiftId
        })
      }
      // applyPayment stamps the current time. Move it to when it happened.
      const paidAt = ago(s.minsAgo - 1)
      await tx.sale.update({ where: { id: sale.id }, data: { paidAt } })
      await tx.payment.updateMany({ where: { saleId: sale.id }, data: { createdAt: paidAt } })
      await tx.stockMovement.updateMany({ where: { saleId: sale.id }, data: { createdAt: paidAt } })
      paid++
    })
  }

  log(`Created demo business "${DEMO_BUSINESS}": ${BRANCHES.length} branches, ${STAFF.length} staff, ${PRODUCTS.length} products, ${CUSTOMERS.length} customers, ${SALES.length} sales (${paid} paid).`)
  log('')
  log(`WARNING: every demo account uses the PIN ${DEMO_PIN}. These are demo PINs only.`)
  log('Never run this seed against a real shop, and change every PIN before real use.')
  log(`Sign in as: ${STAFF.map(s => `${s.username} (${s.role.toLowerCase()})`).join(', ')}`)
  return { created: true, businessId: business.id }
}

// ---------- the platform side: plans, subscriptions, invoices, more clients ----------

const DAY = 86_400_000

type PlanSeed = {
  code: string
  name: string
  description: string
  model: PricingModel
  interval: BillingInterval
  priceCents?: number
  perBranchCents?: number
  percentBps?: number
  minimumCents?: number
  trialDays: number
  maxBranches?: number
  maxStaff?: number
  maxProducts?: number
  public?: boolean
  sortOrder: number
}

export const DEFAULT_PLANS: PlanSeed[] = [
  { code: 'starter', name: 'Starter', description: 'One shop with one till.', model: 'FLAT', interval: 'MONTH', priceCents: 2500 * KSH, trialDays: 14, maxBranches: 1, maxStaff: 5, maxProducts: 300, sortOrder: 1 },
  { code: 'growth', name: 'Growth', description: 'Several branches, priced per branch.', model: 'PER_BRANCH', interval: 'MONTH', priceCents: 1500 * KSH, perBranchCents: 1500 * KSH, trialDays: 14, maxBranches: 5, maxStaff: 30, sortOrder: 2 },
  { code: 'payg', name: 'Pay as you sell', description: 'A share of sales with a small minimum.', model: 'PERCENT_OF_SALES', interval: 'MONTH', percentBps: 150, minimumCents: 1000 * KSH, trialDays: 14, sortOrder: 3 },
  { code: 'annual', name: 'Growth yearly', description: 'Growth, paid once a year.', model: 'FLAT', interval: 'YEAR', priceCents: 39000 * KSH, trialDays: 14, maxBranches: 5, maxStaff: 30, sortOrder: 4 },
  { code: 'licence', name: 'Lifetime licence', description: 'One payment, no renewals.', model: 'ONE_TIME', interval: 'ONCE', priceCents: 85000 * KSH, trialDays: 0, public: false, sortOrder: 5 }
]

// Created once, by code. A plan that already exists is left exactly as it is,
// so prices changed in the console survive a rerun. Plans are never deleted.
async function seedPlans(log: Log) {
  let made = 0
  for (const p of DEFAULT_PLANS) {
    if (await prisma.plan.findUnique({ where: { code: p.code } })) continue
    await prisma.plan.upsert({ where: { code: p.code }, create: p, update: {} })
    made++
  }
  if (made) log(`Created ${made} default plans: ${DEFAULT_PLANS.map(p => p.code).join(', ')}.`)
}

type BillingSeed = {
  plan: string
  state: SubscriptionStatus
  // whole periods before the last one, and days since the last one started
  monthsBack: number
  daysIn: number
  // how many of the newest invoices are left unpaid
  unpaid: number
  // suspended and cancelled clients stopped being billed this many days ago
  endedDaysAgo?: number
  trialEndsInDays?: number
}

// Two paid months behind it and the current month still open.
const DEMO_BILLING: BillingSeed = { plan: 'growth', state: 'ACTIVE', monthsBack: 2, daysIn: 2, unpaid: 1 }

function monthsBefore(d: Date, n: number): Date {
  const x = new Date(d.getTime())
  const day = x.getUTCDate()
  x.setUTCDate(1)
  x.setUTCMonth(x.getUTCMonth() - n)
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate()
  x.setUTCDate(Math.min(day, last))
  return x
}

// Gives a business a subscription with a believable billing history: one
// invoice per period, raised by the same function the billing run uses, so
// every amount comes from priceFor. Returns when the client started.
async function seedBilling(businessId: string, spec: BillingSeed, now: Date, recordedById: string): Promise<Date> {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: spec.plan } })

  if (spec.state === 'TRIALING') {
    const trialEndsAt = new Date(now.getTime() + (spec.trialEndsInDays ?? 3) * DAY)
    const startedAt = new Date(trialEndsAt.getTime() - plan.trialDays * DAY)
    await prisma.subscription.create({
      data: { businessId, planId: plan.id, status: 'TRIALING', trialEndsAt, currentPeriodStart: startedAt, currentPeriodEnd: trialEndsAt, createdAt: startedAt }
    })
    return startedAt
  }

  const stopAt = new Date(now.getTime() - (spec.endedDaysAgo ?? 0) * DAY)
  // Every period start is counted back from the last one, so the number of
  // invoices never depends on the day of the month the seed happens to run.
  const lastStart = new Date(now.getTime() - spec.daysIn * DAY)
  const step = plan.interval === 'YEAR' ? 12 : 1
  const starts = Array.from({ length: spec.monthsBack + 1 }, (_, i) => monthsBefore(lastStart, (spec.monthsBack - i) * step))
  const periods = starts.map((start, i) => ({ start, end: starts[i + 1] ?? periodEnd(start, plan.interval) }))
  const startedAt = starts[0]!
  const current = periods[periods.length - 1]!
  const sub = await prisma.subscription.create({
    data: { businessId, planId: plan.id, status: 'ACTIVE', currentPeriodStart: current.start, currentPeriodEnd: current.end, createdAt: startedAt },
    include: { plan: true }
  })

  // In advance plans bill each period as it starts. Share of sales bills a
  // period once it has ended, so the current one has no invoice yet.
  const arrears = billedInArrears(plan)
  const bills = (arrears ? periods.slice(0, -1) : periods).map(p => ({ ...p, at: arrears ? p.end : p.start }))
  const open: string[] = []
  for (const [i, b] of bills.entries()) {
    const leaveOpen = i >= bills.length - spec.unpaid
    await prisma.$transaction(
      async tx => {
        const invoice = await raiseSubscriptionInvoice(tx, sub, b.start, b.end, b.at)
        if (invoice.status !== 'OPEN') return
        if (leaveOpen) {
          open.push(invoice.number)
          return
        }
        const receivedAt = new Date(Math.min(now.getTime(), b.at.getTime() + 2 * DAY))
        const bank = i % 3 === 2
        await tx.invoicePayment.create({
          data: {
            invoiceId: invoice.id,
            amountCents: invoice.totalCents,
            method: bank ? 'BANK' : 'MPESA',
            reference: bank ? `EFT ${invoice.number}` : `SK${invoice.number.slice(-6)}QP`,
            receivedAt,
            recordedById,
            createdAt: receivedAt
          }
        })
        await tx.invoice.update({ where: { id: invoice.id }, data: { paidCents: invoice.totalCents, status: 'PAID', paidAt: receivedAt } })
      },
      { timeout: 30_000 }
    )
  }

  const where = { id: sub.id }
  if (spec.state === 'PAST_DUE') await prisma.subscription.update({ where, data: { status: 'PAST_DUE' } })
  if (spec.state === 'CANCELLED') await prisma.subscription.update({ where, data: { status: 'CANCELLED', cancelledAt: stopAt } })
  if (spec.state === 'SUSPENDED') {
    const suspendedReason = open[0] ? `${AUTO_SUSPEND_PREFIX}${open[0]}` : 'Suspended by support'
    await prisma.subscription.update({ where, data: { status: 'SUSPENDED', suspendedAt: stopAt, suspendedReason } })
  }
  return startedAt
}

type DemoClient = {
  name: string
  branch: string
  owner: string
  username: string
  phone: string
  email: string
  // bigger baskets, so a share of sales plan bills more than its minimum
  big?: boolean
  salesDaysAgo: number[]
  billing: BillingSeed
}

// Six small shops, one in each state the console has to show. They are
// recognised by these exact names and owner usernames, nothing else is ever
// treated as demo data.
export const DEMO_CLIENTS: DemoClient[] = [
  {
    name: 'Mama Njeri Wines', branch: 'Ngong Road', owner: 'Njeri Mwangi', username: 'mamanjeri', phone: '254711204518', email: 'njeri@mamanjeriwines.example',
    salesDaysAgo: [1, 2, 4, 7],
    billing: { plan: 'starter', state: 'TRIALING', trialEndsInDays: 3, monthsBack: 0, daysIn: 0, unpaid: 0 }
  },
  {
    name: 'Kilele Liquor Store', branch: 'Eldoret Town', owner: 'Kiprono Bett', username: 'kiprono', phone: '254722670134', email: 'accounts@kilele.example',
    salesDaysAgo: [1, 3, 9, 20, 48, 80],
    billing: { plan: 'starter', state: 'ACTIVE', monthsBack: 5, daysIn: 10, unpaid: 0 }
  },
  {
    name: 'Baraka Wines and Spirits', branch: 'Nakuru CBD', owner: 'Baraka Odhiambo', username: 'baraka', phone: '254733918260', email: 'baraka@barakawines.example',
    big: true,
    salesDaysAgo: [1, 2, 3, 5, 6, 8, 10, 13, 15, 18, 21, 24, 27, 29, 36, 44, 52, 63, 75, 90, 104, 118],
    billing: { plan: 'payg', state: 'ACTIVE', monthsBack: 4, daysIn: 12, unpaid: 0 }
  },
  {
    name: 'Pwani Sundowner Pub', branch: 'Nyali', owner: 'Mwanaisha Salim', username: 'mwanaisha', phone: '254701335902', email: 'manager@pwanisundowner.example',
    salesDaysAgo: [1, 4, 11, 25, 50],
    billing: { plan: 'growth', state: 'PAST_DUE', monthsBack: 3, daysIn: 20, unpaid: 1 }
  },
  {
    name: 'Tumaini Bottle Shop', branch: 'Kisumu Milimani', owner: 'Tumaini Achieng', username: 'tumaini', phone: '254745880417', email: 'tumaini@tumainibottles.example',
    salesDaysAgo: [9, 12, 20, 41],
    billing: { plan: 'starter', state: 'SUSPENDED', monthsBack: 3, daysIn: 36, unpaid: 1, endedDaysAgo: 8 }
  },
  {
    name: 'Karibu Cellar', branch: 'Thika Town', owner: 'Joseph Karanja', username: 'karibu', phone: '254790412776', email: 'joseph@karibucellar.example',
    salesDaysAgo: [62, 70, 85, 110],
    billing: { plan: 'starter', state: 'CANCELLED', monthsBack: 3, daysIn: 75, unpaid: 0, endedDaysAgo: 60 }
  }
]

const CLIENT_PRODUCTS = [
  { name: 'Tusker Lager', sizeMl: 500, category: 'Beer', price: 280 },
  { name: "Gilbey's Gin", sizeMl: 750, category: 'Gin', price: 1450 },
  { name: 'Four Cousins Red', sizeMl: 750, category: 'Wine', price: 1100 },
  { name: 'Johnnie Walker Black', sizeMl: 750, category: 'Whisky', price: 4800 }
]

async function seedDemoClient(c: DemoClient, now: Date, recordedById: string) {
  const business = await prisma.business.create({ data: { name: c.name, email: c.email, phone: c.phone } })
  const branch = await prisma.branch.create({ data: { businessId: business.id, name: c.branch } })
  const owner = await createStaff(prisma, { businessId: business.id, name: c.owner, username: c.username, pin: DEMO_PIN, role: 'OWNER', branchIds: [] })

  const openedAt = new Date(now.getTime() - (Math.max(...c.salesDaysAgo) + 1) * DAY)
  const products: { id: string; name: string; priceCents: number }[] = []
  for (const p of CLIENT_PRODUCTS) {
    const row = await prisma.product.create({
      data: { businessId: business.id, name: p.name, sizeMl: p.sizeMl, category: p.category, priceCents: p.price * KSH }
    })
    await prisma.stock.create({ data: { branchId: branch.id, productId: row.id, qty: 400, reorderAt: 12 } })
    await prisma.stockMovement.create({
      data: { branchId: branch.id, productId: row.id, delta: 400, reason: 'RECEIVE', userId: owner.id, note: 'Opening stock', createdAt: openedAt }
    })
    products.push(row)
  }

  // Cash sales rung up by the owner, oldest first so sale numbers run in order.
  for (const [i, daysAgo] of [...c.salesDaysAgo].sort((a, b) => b - a).entries()) {
    const at = new Date(now.getTime() - daysAgo * DAY + (i % 5) * 37 * MIN)
    const basket: [number, number][] = c.big ? [[3, 2], [0, 6 + (i % 3) * 2]] : [[0, 6 + (i % 3) * 2], [1 + (i % 2), 1]]
    await prisma.$transaction(async tx => {
      const { nextSaleNo } = await tx.branch.update({ where: { id: branch.id }, data: { nextSaleNo: { increment: 1 } }, select: { nextSaleNo: true } })
      const lines = basket.map(([k, qty]) => ({ productId: products[k]!.id, name: products[k]!.name, unitCents: products[k]!.priceCents, qty }))
      const subtotal = lines.reduce((a, l) => a + l.unitCents * l.qty, 0)
      const sale = await tx.sale.create({
        data: { number: nextSaleNo - 1, branchId: branch.id, createdById: owner.id, status: 'SAVED', subtotalCents: subtotal, totalCents: subtotal, createdAt: at, lines: { create: lines } }
      })
      await applyPayment(tx, {
        saleId: sale.id,
        method: 'CASH',
        amountCents: subtotal,
        tenderedCents: subtotal,
        mpesaRef: null,
        phone: null,
        verification: 'CASH',
        mpesaRequestId: null,
        receivedById: owner.id,
        shiftId: null
      })
      await tx.sale.update({ where: { id: sale.id }, data: { paidAt: at } })
      await tx.payment.updateMany({ where: { saleId: sale.id }, data: { createdAt: at } })
      await tx.stockMovement.updateMany({ where: { saleId: sale.id }, data: { createdAt: at } })
    })
  }

  // Sales first: a share of sales invoice is priced from them.
  const startedAt = await seedBilling(business.id, c.billing, now, recordedById)
  await prisma.business.update({ where: { id: business.id }, data: { createdAt: startedAt } })
}

// The demo shop, then the platform data around it. Each step checks for its
// own rows, so a rerun fills in whatever is missing and changes nothing else.
export async function seedDemo(opts: { reset?: boolean; log?: Log; now?: Date } = {}): Promise<SeedResult> {
  const log: Log = opts.log ?? (m => console.log(m))
  const now = opts.now ?? new Date()

  if (opts.reset && process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to reset demo data while NODE_ENV is production.')
  }

  if (opts.reset) {
    // Only a business with a demo name AND its demo owner counts as ours.
    const mine = await prisma.business.findMany({
      where: { OR: DEMO_CLIENTS.map(c => ({ name: c.name, users: { some: { username: c.username } } })) },
      select: { id: true }
    })
    if (mine.length) {
      await prisma.$transaction(tx => deleteDemo(tx, mine.map(b => b.id)), { timeout: 60_000 })
      log(`Deleted ${mine.length} demo client businesses.`)
    }
  }

  const result = await seedDemoShop(opts)
  await seedPlans(log)

  // Payments need someone who recorded them. Console users are never created here.
  const recorder = await prisma.user.findFirst({ where: { platformRole: { not: null } }, orderBy: { createdAt: 'asc' }, select: { id: true } })
  const recordedById = recorder?.id ?? 'seed'

  if (!(await prisma.subscription.findUnique({ where: { businessId: result.businessId } }))) {
    await seedBilling(result.businessId, DEMO_BILLING, now, recordedById)
    log(`Put "${DEMO_BUSINESS}" on the ${DEMO_BILLING.plan} plan with two paid invoices and one open.`)
  }

  const made: string[] = []
  for (const c of DEMO_CLIENTS) {
    if (await prisma.business.findFirst({ where: { name: c.name }, select: { id: true } })) continue
    if (await prisma.user.findFirst({ where: { username: c.username }, select: { id: true } })) {
      log(`Skipped demo client "${c.name}": the username ${c.username} is already taken.`)
      continue
    }
    await seedDemoClient(c, now, recordedById)
    made.push(`${c.name} (${c.username}, ${c.billing.state.toLowerCase().replace('_', ' ')})`)
  }
  if (made.length) log(`Created ${made.length} demo clients, owner PIN ${DEMO_PIN}: ${made.join(', ')}.`)

  return result
}

const invokedDirectly = /[\\/]prisma[\\/]seed\.(ts|js)$/.test(process.argv[1] ?? '')
if (invokedDirectly) {
  const reset = process.argv.includes('--reset')
  seedDemo({ reset })
    .then(async () => {
      await prisma.$disconnect()
    })
    .catch(async err => {
      console.error(err instanceof Error ? err.message : err)
      await prisma.$disconnect()
      process.exit(1)
    })
}
