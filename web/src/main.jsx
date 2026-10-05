import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import ReceiptPreview from './ReceiptPreview.jsx'
import './styles.css'

const preview = new URLSearchParams(location.search).get('preview')

createRoot(document.getElementById('root')).render(
  preview && preview.startsWith('receipt') ? <ReceiptPreview kind={preview} /> : <App />
)
