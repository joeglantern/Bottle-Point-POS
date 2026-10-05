export const BRANCHES = [
  { id: 'wl', name: 'Westlands' },
  { id: 'kl', name: 'Kilimani' },
  { id: 'th', name: 'Thika Road' }
]

export const USERS = [
  { id: 'u1', name: 'Wanjiru K.', role: 'cashier', branch: 'wl' },
  { id: 'u2', name: 'Brian M.', role: 'cashier', branch: 'wl' },
  { id: 'u3', name: 'Otieno J.', role: 'manager', branch: 'wl' },
  { id: 'u4', name: 'Achieng O.', role: 'owner', branch: 'wl' }
]

export const CATEGORIES = ['All', 'Whisky', 'Vodka', 'Gin', 'Wine', 'Beer', 'Rum', 'Cognac']

export const PRODUCTS = [
  { id: 'p1', name: 'Johnnie Walker Black', size: '750ml', cat: 'Whisky', price: 4800, code: '5000267024004', tint: '#3a2412', stock: 24 },
  { id: 'p2', name: 'Jameson Irish', size: '750ml', cat: 'Whisky', price: 3200, code: '5011007003029', tint: '#2f3a1c', stock: 31 },
  { id: 'p3', name: 'Glenfiddich 12', size: '750ml', cat: 'Whisky', price: 7900, code: '5010327000176', tint: '#2a3a2c', stock: 6 },
  { id: 'p4', name: 'Smirnoff Red', size: '750ml', cat: 'Vodka', price: 1650, code: '5410316950026', tint: '#3a1418', stock: 40 },
  { id: 'p5', name: 'Chrome Vodka', size: '750ml', cat: 'Vodka', price: 950, code: '6161101560012', tint: '#2a2a32', stock: 52 },
  { id: 'p6', name: "Gilbey's Gin", size: '750ml', cat: 'Gin', price: 1450, code: '6161101560203', tint: '#20302a', stock: 18 },
  { id: 'p7', name: 'Tanqueray London Dry', size: '750ml', cat: 'Gin', price: 3600, code: '5000291020706', tint: '#18302a', stock: 4 },
  { id: 'p8', name: 'Four Cousins Red', size: '750ml', cat: 'Wine', price: 1100, code: '6001495062508', tint: '#3a1020', stock: 36 },
  { id: 'p9', name: 'Nederburg Cabernet', size: '750ml', cat: 'Wine', price: 1900, code: '6001452303001', tint: '#320c18', stock: 9 },
  { id: 'p10', name: 'Tusker Lager', size: '500ml', cat: 'Beer', price: 280, code: '6161100010017', tint: '#3a3010', stock: 120 },
  { id: 'p11', name: 'Guinness', size: '500ml', cat: 'Beer', price: 320, code: '6161100010147', tint: '#141414', stock: 0 },
  { id: 'p12', name: 'White Cap', size: '500ml', cat: 'Beer', price: 290, code: '6161100010031', tint: '#2a2a20', stock: 96 },
  { id: 'p13', name: 'Captain Morgan Spiced', size: '750ml', cat: 'Rum', price: 2300, code: '5000299223031', tint: '#3a2010', stock: 14 },
  { id: 'p14', name: 'Kenya Cane', size: '750ml', cat: 'Rum', price: 1050, code: '6161101560104', tint: '#2a2010', stock: 3 },
  { id: 'p15', name: 'Hennessy VS', size: '700ml', cat: 'Cognac', price: 6900, code: '3245990001218', tint: '#3a1c0c', stock: 7 }
]

const now = Date.now()
const min = 60 * 1000

function line(pid, qty) {
  const p = PRODUCTS.find(x => x.id === pid)
  return { pid, name: p.name, price: p.price, qty }
}

export const SEED_SALES = [
  { no: 1041, branch: 'wl', cashier: 'Wanjiru K.', at: now - 310 * min, status: 'paid', lines: [line('p1', 1), line('p10', 6)], payments: [{ method: 'cash', amount: 6480 }], paidBy: 'Wanjiru K.', paidAt: now - 309 * min },
  { no: 1042, branch: 'wl', cashier: 'Brian M.', at: now - 260 * min, status: 'paid', lines: [line('p15', 1)], payments: [{ method: 'mpesa', amount: 6900, ref: 'SJK4H7QW2P' }], paidBy: 'Brian M.', paidAt: now - 258 * min },
  { no: 1043, branch: 'wl', cashier: 'Wanjiru K.', at: now - 200 * min, status: 'paid', lines: [line('p6', 2), line('p11', 4)], payments: [{ method: 'cash', amount: 2000 }, { method: 'mpesa', amount: 2180, ref: 'SJK5B2LM9X' }], paidBy: 'Wanjiru K.', paidAt: now - 199 * min },
  { no: 1044, branch: 'wl', cashier: 'Brian M.', at: now - 140 * min, status: 'saved', label: 'Table 4', lines: [line('p10', 8), line('p2', 1)] },
  { no: 1045, branch: 'wl', cashier: 'Wanjiru K.', at: now - 95 * min, status: 'paid', lines: [line('p8', 2), line('p4', 1)], payments: [{ method: 'mpesa', amount: 3850, ref: 'SJK6C8NT4R' }], paidBy: 'Wanjiru K.', paidAt: now - 94 * min },
  { no: 1046, branch: 'wl', cashier: 'Brian M.', at: now - 40 * min, status: 'saved', label: 'Mr Kamau', lines: [line('p3', 1)] },
  { no: 1047, branch: 'wl', cashier: 'Brian M.', at: now - 25 * min, status: 'cancelled', lines: [line('p5', 1)], cancelledBy: 'Otieno J.' }
]

export const OTHER_BRANCHES = [
  { id: 'kl', name: 'Kilimani', cash: 38450, mpesa: 61200, count: 74, unpaid: 2, unpaidValue: 4300, variance: -150 },
  { id: 'th', name: 'Thika Road', cash: 22900, mpesa: 30480, count: 51, unpaid: 0, unpaidValue: 0, variance: 0 }
]

export const ksh = n => 'KSh ' + Math.round(n).toLocaleString('en-KE')

export const saleTotal = s => s.lines.reduce((a, l) => a + l.price * l.qty, 0)

export function ago(t) {
  const m = Math.round((Date.now() - t) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return m + ' min ago'
  const h = Math.floor(m / 60)
  return h + 'h ' + (m % 60) + 'm ago'
}

export const timeOf = t => new Date(t).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })

export const CUSTOMERS = [
  { id: 'c1', name: 'James Kamau', phone: '0712 *** 481', spent: 84200, visits: 31, tier: 'Gold', tab: 7900, last: 'Today' },
  { id: 'c2', name: 'Grace Wambui', phone: '0722 *** 106', spent: 41850, visits: 18, tier: 'Silver', tab: 0, last: 'Yesterday' },
  { id: 'c3', name: 'Table 4 regulars', phone: 'Walk in', spent: 22600, visits: 12, tier: 'Silver', tab: 5440, last: 'Today' },
  { id: 'c4', name: 'Peter Otieno', phone: '0733 *** 920', spent: 128400, visits: 46, tier: 'Gold', tab: 0, last: '3 days ago' },
  { id: 'c5', name: 'Faith Njeri', phone: '0701 *** 334', spent: 9600, visits: 5, tier: 'Bronze', tab: 0, last: 'Last week' },
  { id: 'c6', name: 'Kevin Mutua', phone: '0745 *** 772', spent: 15300, visits: 9, tier: 'Bronze', tab: 1650, last: 'Today' }
]
