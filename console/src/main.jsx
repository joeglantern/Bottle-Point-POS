import React from 'react'
import { createRoot } from 'react-dom/client'
import ConsoleApp from './ConsoleApp.jsx'
import './tokens.css'
import './console.css'

createRoot(document.getElementById('root')).render(<ConsoleApp />)
