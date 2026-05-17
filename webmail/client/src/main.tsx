import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/globals.css'

const root = document.getElementById('root')
if (!root) throw new Error('No #root element found')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)

// ─── Service worker registration ────────────────────────────────────────────
// Phase 4 PWA — installable web app. The SW lives at /sw.js (served by Vite
// from public/sw.js) and is registered at root scope so it intercepts every
// same-origin GET. Strategy is documented inside the worker file.
//
// Skip registration on dev (vite dev server) — the SW would cache /assets/
// paths that the HMR runtime expects to bypass.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  // Defer registration until after first paint so it never competes with
  // initial render. window.load fires after all initial subresources have
  // loaded, including async scripts.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
      // When the browser detects an updated SW, prompt it to take over.
      // We don't surface a "reload to update" UI here — the next full
      // navigation will get the new bundle.
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing
        if (!installing) return
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            // A new SW is waiting. Tell it to skip the wait so updates
            // become effective on next page reload without the usual
            // multi-tab-close requirement.
            installing.postMessage({ type: 'SKIP_WAITING' })
          }
        })
      })
    }).catch((err) => {
      console.warn('[sw] registration failed:', err)
    })
  })
}
