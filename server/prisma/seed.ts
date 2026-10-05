// Demo data for Bottle Point. Matches the demo screens in web/src/data.js.
//   npm run db:seed            creates the demo business once (safe to rerun)
//   npm run db:seed -- --reset deletes the demo business and creates it again
// Every demo PIN is 1234. Never use this data for a real shop.

import { prisma, type PayMethod, type PaymentVerification, type Tx } from '../src/db.js'
import { createStaff } from '../src/lib/users.js'
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

export async function seedDemo(opts: { reset?: boolean; log?: Log; now?: Date } = {}): Promise<SeedResult> {
  const log: Log = opts.log ?? (m => console.log(m))
  const now = opts.now ?? new Date()
  const ago = (mins: number) => new Date(now.getTime() - mins * MIN)

  if (opts.reset && process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to reset demo data while NODE_ENV is production.')
  }

  const existing = await prisma.business.findMany({ where: { name: DEMO_BUSINESS }, select: { id: true } })
  if (existing.length && !opts.reset) {
    log(`The demo business "${DEMO_BUSINESS}" already exists. Nothing to do. Run with --reset to recreate it.`)
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
