import { useEffect, useState } from 'react'
import { api } from './api.js'
import ReceiptModal, { fromApiReceipt } from './Receipt.jsx'
import { Loading, Modal } from './ui.jsx'

// Fetches a sale's receipt from the API and shows it.
export default function ReceiptLoader({ saleId, copy = false, onClose, onNewSale }) {
  const [receipt, setReceipt] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    let live = true
    api.get(`/sales/${saleId}/receipt`).then(r => live && setReceipt(fromApiReceipt(r.receipt, copy)), e => live && setError(e))
    return () => { live = false }
  }, [saleId, copy])
  if (error) return <Modal title="Receipt" onClose={onClose}><p className="err">{error.message}</p></Modal>
  if (!receipt) return <div className="scrim"><Loading label="Loading receipt" /></div>
  return <ReceiptModal receipt={receipt} onClose={onClose} onNewSale={onNewSale} />
}
