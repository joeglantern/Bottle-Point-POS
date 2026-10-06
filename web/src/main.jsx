import React, { Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import ReceiptPreview from './ReceiptPreview.jsx'
import { SessionProvider } from './session.jsx'
import { ToastProvider } from './ui.jsx'
import './styles.css'

// The company console lives at /console and is loaded only when visited, so
// tills never download it.
const ConsoleApp = lazy(() => import('./console/ConsoleApp.jsx'))

const preview = new URLSearchParams(location.search).get('preview')
const isConsole = location.pathname === '/console' || location.pathname.startsWith('/console/')

function Root() {
  if (preview && preview.startsWith('receipt')) return <ReceiptPreview kind={preview} />
  if (isConsole) {
    return (
      <Suspense fallback={null}>
        <ConsoleApp />
      </Suspense>
    )
  }
  return (
    <ToastProvider>
      <SessionProvider>
        <App />
      </SessionProvider>
    </ToastProvider>
  )
}

createRoot(document.getElementById('root')).render(<Root />)
