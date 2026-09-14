import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { QuickCapture } from './components/QuickCapture'
import './index.css'

const container = document.getElementById('root')
if (!container) throw new Error('Root container #root not found')

// The quick capture panel loads the same bundle with #quick: a prompt box,
// not the app. Everything else is the app inside a boundary: without it a
// single uncaught render error unmounts #root and the window goes silently
// blank, which is one of the worst failures to diagnose from the outside.
const tree = window.location.hash === '#quick' ? <QuickCapture /> : <App />

createRoot(container).render(<StrictMode><ErrorBoundary>{tree}</ErrorBoundary></StrictMode>)
