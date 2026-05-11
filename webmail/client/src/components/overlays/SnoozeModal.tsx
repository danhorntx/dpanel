import { useState, useEffect, useRef, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ClockIcon, XIcon, CheckIcon } from '@phosphor-icons/react'
import { useUiStore } from '@/store/uiStore'
import { useEmailStore, selectActiveState } from '@/store/emailStore'
import { snoozeOptions, formatEmailDate } from '@/lib/utils'
import { parseSnoozeInput } from '@/lib/snoozeParser'

interface OptionItem {
  label:    string
  sublabel: string
  value:    number
}

export function SnoozeModal() {
  const open  = useUiStore(s => s.snoozeModalOpen)
  const close = useUiStore(s => s.closeSnoozeModal)
  const toast = useUiStore(s => s.toast)
  const { selectedId, focusedIndex, emails } = useEmailStore(selectActiveState)
  const snoozeEmail = useEmailStore(s => s.snoozeEmail)

  const [query, setQuery]   = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const targetId = selectedId ?? emails[focusedIndex]?.id

  // Reset on open
  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(0)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])

  // ─ Compute filtered/derived options ──────────────────────────────────────
  const presets: OptionItem[] = useMemo(() => snoozeOptions(), [])

  const parsed = useMemo(
    () => (query.trim() ? parseSnoozeInput(query) : null),
    [query],
  )

  // Filter presets by query text (substring match)
  const filteredPresets = useMemo(() => {
    if (!query.trim()) return presets
    const q = query.toLowerCase()
    return presets.filter(p => p.label.toLowerCase().includes(q))
  }, [query, presets])

  // Build the unified list — natural-language preview first if it parsed,
  // then filtered presets. Cursor index navigates across both groups.
  const items: (OptionItem & { source: 'nlp' | 'preset' })[] = useMemo(() => {
    const out: (OptionItem & { source: 'nlp' | 'preset' })[] = []
    if (parsed) {
      out.push({
        label:    parsed.label,
        sublabel: query,
        value:    parsed.ts,
        source:   'nlp',
      })
    }
    for (const p of filteredPresets) {
      out.push({ ...p, source: 'preset' })
    }
    return out
  }, [parsed, filteredPresets, query])

  // Reset cursor when query changes
  useEffect(() => setCursor(0), [query])

  const handleSnooze = (until: number) => {
    if (!targetId) return
    snoozeEmail(targetId, until)
    toast(`Snoozed until ${formatEmailDate(until)}`)
    close()
  }

  // Keyboard nav inside the modal
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCursor(c => Math.min(c + 1, items.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor(c => Math.max(c - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const item = items[cursor]
        if (item) handleSnooze(item.value)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, items, cursor]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
          onClick={close}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.16, ease: [0.32, 0.72, 0, 1] }}
            className="w-[440px] max-w-[calc(100vw-32px)] rounded-xl overflow-hidden"
            style={{
              background: 'var(--bg-overlay)',
              border:     '1px solid var(--border-strong)',
              boxShadow:  '0 16px 60px rgba(0,0,0,0.6)',
            }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header / NL input */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border-subtle)]">
              <ClockIcon size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Try: tomorrow morning, 2 hours, 8am Monday…"
                className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
              />
              <button
                onClick={close}
                className="p-1 rounded hover:bg-[var(--bg-hover)] transition-colors"
                title="Close (Esc)"
              >
                <XIcon size={11} weight="bold" style={{ color: 'var(--text-muted)' }} />
              </button>
            </div>

            {/* Items */}
            <div className="py-1 max-h-[360px] overflow-y-auto">
              {items.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-sm text-[var(--text-secondary)]">
                    Couldn&apos;t parse &ldquo;{query}&rdquo;
                  </p>
                  <p className="text-xs text-[var(--text-muted)] mt-1">
                    Try: <code>tomorrow morning</code>, <code>next Monday</code>, <code>in 3 hours</code>
                  </p>
                </div>
              ) : (
                items.map((item, i) => {
                  const isCursor = cursor === i
                  return (
                    <button
                      key={`${item.source}-${item.label}-${i}`}
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => handleSnooze(item.value)}
                      className="w-full flex items-center justify-between px-4 py-2.5 text-sm transition-colors duration-75"
                      style={{
                        background: isCursor ? 'var(--bg-active)' : 'transparent',
                        color:      'var(--text-primary)',
                      }}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {item.source === 'nlp' && (
                          <span
                            className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider flex-shrink-0"
                            style={{
                              background: 'var(--accent-faint)',
                              color:      'var(--accent)',
                              border:     '1px solid var(--border-accent)',
                            }}
                          >
                            Parsed
                          </span>
                        )}
                        <span className="truncate">{item.label}</span>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className="text-xs text-[var(--text-muted)]">{item.sublabel}</span>
                        {isCursor && <CheckIcon size={11} style={{ color: 'var(--accent)' }} />}
                      </div>
                    </button>
                  )
                })
              )}
            </div>

            {/* Footer hint */}
            <div className="flex items-center gap-3 px-4 py-2 border-t border-[var(--border-subtle)]" style={{ background: 'rgba(0,0,0,0.2)' }}>
              <span className="text-xs text-[var(--text-muted)] flex items-center gap-1"><kbd>↑↓</kbd> navigate</span>
              <span className="text-xs text-[var(--text-muted)] flex items-center gap-1"><kbd>↵</kbd> snooze</span>
              <span className="text-xs text-[var(--text-muted)] flex items-center gap-1"><kbd>Esc</kbd> close</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
