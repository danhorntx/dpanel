import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useUiStore } from '@/store/uiStore'

/**
 * Returns how much the bottom of the layout viewport is being covered by the
 * on-screen keyboard (or by Safari's URL bar moving around). We compare the
 * visualViewport bottom edge to the layout viewport bottom and report the
 * delta. The toast stack uses this so its position lifts above the keyboard
 * while composing or replying — otherwise toasts get hidden behind the keys.
 *
 * Returns 0 when there's no virtual keyboard (desktop, or phone landscape
 * with hardware keyboard, etc.).
 */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    if (!vv) return
    const onResize = () => {
      const layoutH = window.innerHeight
      const visualBottom = vv.height + vv.offsetTop
      // Clamp small jitter (Safari URL bar transitions of ~50px) so the
      // toast doesn't dance every time the URL bar collapses.
      const next = Math.max(0, Math.round(layoutH - visualBottom))
      setInset(next < 60 ? 0 : next)
    }
    onResize()
    vv.addEventListener('resize', onResize)
    vv.addEventListener('scroll', onResize)
    return () => {
      vv.removeEventListener('resize', onResize)
      vv.removeEventListener('scroll', onResize)
    }
  }, [])
  return inset
}

export function ToastStack() {
  const toasts = useUiStore(s => s.toasts)
  const dismiss = useUiStore(s => s.dismissToast)
  const keyboardInset = useKeyboardInset()

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 items-center pointer-events-none"
      style={{
        // 24px base bottom margin + however much the keyboard is covering.
        bottom: 24 + keyboardInset,
        transition: 'bottom 180ms ease',
      }}
      aria-live="polite"
    >
      <AnimatePresence>
        {toasts.map(t => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 400, damping: 28 }}
            className="flex items-center gap-3 px-4 py-2.5 rounded-lg pointer-events-auto"
            style={{
              background: 'rgba(26,25,40,0.96)',
              border: '1px solid rgba(255,255,255,0.13)',
              backdropFilter: 'blur(12px)',
              boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
              minWidth: 200,
            }}
          >
            <span className="text-sm text-[var(--text-primary)] leading-none">{t.text}</span>
            {t.action && (
              <button
                onClick={() => { t.action!.fn(); dismiss(t.id) }}
                className="text-[var(--accent)] text-sm font-medium leading-none hover:opacity-80 transition-opacity ml-1"
              >
                {t.action.label}
              </button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
