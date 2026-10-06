import React, { Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { SessionProvider } from './session.jsx'
import { ToastProvider } from './ui.jsx'
import './styles.css'

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
