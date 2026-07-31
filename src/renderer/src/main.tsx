import React from 'react'
import ReactDOM from 'react-dom/client'
import './theme/forge-folio.css'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'

// Async failures never reach the error boundary, so they used to vanish silently —
// a rejected IPC call would just leave a pane stuck. Log them where they can be read.
window.addEventListener('unhandledrejection', (e) => {
  console.error('Unhandled promise rejection:', e.reason)
})
window.addEventListener('error', (e) => {
  console.error('Uncaught error:', e.error ?? e.message)
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
