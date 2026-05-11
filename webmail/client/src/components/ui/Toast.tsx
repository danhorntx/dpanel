import { AnimatePresence, motion } from 'framer-motion'
import { useUiStore } from '@/store/uiStore'

export function ToastStack() {
  const toasts = useUiStore(s => s.toasts)
  const dismiss = useUiStore(s => s.dismissToast)

  return (
    <div
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 items-center pointer-events-none"
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
