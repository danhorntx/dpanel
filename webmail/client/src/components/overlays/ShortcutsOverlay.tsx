import { motion, AnimatePresence } from 'framer-motion'
import { XIcon } from '@phosphor-icons/react'
import { useUiStore } from '@/store/uiStore'

const SHORTCUTS = [
  {
    section: 'Navigation',
    items: [
      { keys: ['J'], description: 'Next email' },
      { keys: ['K'], description: 'Previous email' },
      { keys: ['⇧', 'J'], description: 'Jump down email list' },
      { keys: ['⇧', 'K'], description: 'Jump up email list' },
      { keys: ['Space'], description: 'Scroll email preview down' },
      { keys: ['⇧', 'Space'], description: 'Scroll email preview up' },
      { keys: ['Enter'], description: 'Open focused email' },
      { keys: ['U'], description: 'Back to inbox / deselect' },
      { keys: ['G', 'I'], description: 'Go to Inbox' },
      { keys: ['G', 'S'], description: 'Go to Starred' },
      { keys: ['G', 'T'], description: 'Go to Sent' },
      { keys: ['G', 'D'], description: 'Go to Drafts' },
    ],
  },
  {
    section: 'Actions',
    items: [
      { keys: ['E'], description: 'Archive' },
      { keys: ['#'], description: 'Delete' },
      { keys: ['S'], description: 'Star / Unstar' },
      { keys: ['!'], description: 'Mark as spam' },
      { keys: ['M'], description: 'Mute thread' },
      { keys: ['H'], description: 'Snooze' },
      { keys: ['⇧', 'U'], description: 'Mark as unread' },
      { keys: ['⌘', 'Z'], description: 'Undo last action' },
    ],
  },
  {
    section: 'Compose',
    items: [
      { keys: ['C'], description: 'Compose new email' },
      { keys: ['R'], description: 'Reply' },
      { keys: ['A'], description: 'Reply all' },
      { keys: ['F'], description: 'Forward' },
      { keys: ['⌘', '↵'], description: 'Send (in compose)' },
    ],
  },
  {
    section: 'Search & Help',
    items: [
      { keys: ['⌘', 'K'], description: 'Command palette' },
      { keys: ['/'], description: 'Search' },
      { keys: ['?'], description: 'Keyboard shortcuts' },
    ],
  },
]

export function ShortcutsOverlay() {
  const open = useUiStore(s => s.shortcutsOverlayOpen)
  const close = useUiStore(s => s.closeShortcuts)

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)' }}
          onClick={close}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 4 }}
            transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
            className="w-full max-w-2xl max-h-[80vh] overflow-y-auto rounded-xl"
            style={{
              background: 'var(--bg-overlay)',
              border: '1px solid var(--border-strong)',
              boxShadow: '0 24px 80px rgba(0,0,0,0.7)',
            }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-subtle)]">
              <div>
                <h2 className="text-base font-semibold text-[var(--text-primary)]" style={{ letterSpacing: '-0.02em' }}>
                  Keyboard Shortcuts
                </h2>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">Press <kbd>?</kbd> anytime to see this</p>
              </div>
              <button
                onClick={close}
                className="p-1.5 rounded-lg hover:bg-[var(--bg-hover)] transition-colors"
                style={{ color: 'var(--text-muted)' }}
              >
                <XIcon size={14} weight="bold" />
              </button>
            </div>

            {/* Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-0 p-2">
              {SHORTCUTS.map(section => (
                <div key={section.section} className="p-4">
                  <h3 className="text-label text-[var(--accent)] mb-3">{section.section}</h3>
                  <div className="space-y-1">
                    {section.items.map(item => (
                      <div key={item.description} className="flex items-center justify-between py-1.5">
                        <span className="text-sm text-[var(--text-secondary)]">{item.description}</span>
                        <div className="flex items-center gap-1">
                          {item.keys.map((k, i) => (
                            <kbd key={i}>{k}</kbd>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Footer */}
            <div className="px-6 py-3 border-t border-[var(--border-subtle)]">
              <p className="text-xs text-[var(--text-muted)]">
                Shortcuts don't fire when composing or typing in search
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
