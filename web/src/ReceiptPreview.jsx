import ReceiptModal from './Receipt.jsx'

// Open /?preview=receipt (or receipt-refund, receipt-58) to review the
// receipt design on its own, without signing in.
const base = {
  business: { name: 'Bottle Point Demo', address: 'Woodvale Grove, Westlands, Nairobi', phone: '0712 000 000' },
  branch: { name: 'Westlands' },
  number: 1043,
  status: 'PAID',
  paidAt: Date.now() - 20 * 60000,
  servedBy: 'Wanjiru K.',
  label: 'Table 4',
  lines: [
    { name: 'Johnnie Walker Black 750ml', qty: 1, unitCents: 480000 },
    { name: 'Gilbeys Gin 750ml', qty: 2, unitCents: 145000 },
    { name: 'Tusker Lager 500ml', qty: 6, unitCents: 28000 }
  ],
  subtotalCents: 938000,
  discountCents: 18000,
  totalCents: 920000,
  payments: [
    { method: 'MPESA', amountCents: 600000, mpesaRef: 'SJK4H7QW2P', phone: '254712345678', verification: 'STK_CONFIRMED' },
    { method: 'CASH', amountCents: 320000, tenderedCents: 350000 }
  ]
}

export default function ReceiptPreview({ kind }) {
  const r = kind === 'receipt-refund' ? { ...base, status: 'REFUNDED', refundedAt: Date.now(), copy: false } : base
  if (kind === 'receipt-58') {
    try { localStorage.setItem('bp-paper', '58') } catch {}
  }
  return <ReceiptModal receipt={r} onClose={() => {}} onNewSale={() => {}} />
}
