import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { QuickCapture } from './components/QuickCapture'
import './index.css'

const container = document.getElementById('root')
if (!container) throw new Error('Root container #root not found')

// The quick capture panel loads the same bundle with #quick: a prompt box,
// not the app.
createRoot(container).render(
  <StrictMode>{window.location.hash === '#quick' ? <QuickCapture /> : <App />}</StrictMode>
)
