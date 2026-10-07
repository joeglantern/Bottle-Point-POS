import React, { Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { SessionProvider } from './session.jsx'
import { ToastProvider } from './ui.jsx'
import './styles.css'
import { registerSW } from 'virtual:pwa-register'

// The till's files are kept on the device (offline use). A new version waits
// until the cashier chooses to reload, so a sale is never interrupted.
if (!import.meta.env.DEV && 'serviceWorker' in navigator) {
  const update = registerSW({
    onNeedRefresh() { window.dispatchEvent(new Event('bp:update-ready')) }
  })
  window.bpApplyUpdate = () => update(true)
}

// Receipt design preview with sample data (/?preview=receipt). Development
// only: it is not part of the production build.
const preview = import.meta.env.DEV ? new URLSearchParams(location.search).get('preview') : null
const ReceiptPreview = import.meta.env.DEV ? lazy(() => import('./ReceiptPreview.jsx')) : null

createRoot(document.getElementById('root')).render(
  preview && preview.startsWith('receipt') ? (
    <Suspense fallback={null}><ReceiptPreview kind={preview} /></Suspense>
  ) : (
    <ToastProvider>
      <SessionProvider>
        <App />
      </SessionProvider>
    </ToastProvider>
  )
)
