import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { TagIcon, PlusIcon, CheckIcon, XIcon } from '@phosphor-icons/react'
import { useUiStore } from '@/store/uiStore'
import { useEmailStore, selectActiveState, selectSelectedEmail } from '@/store/emailStore'
import { useLabelsStore, defaultLabelInput } from '@/store/labelsStore'
import type { CustomLabel } from '@/types/email'

/**
 * Quick label dialog — opened with `l`. Type to filter existing labels by
 * name (substring match). Enter applies the highlighted match. If the typed
 * query doesn't match any existing label, Enter creates a new label with
 * that name and applies it. Esc cancels.
 */
export function LabelDialog() {
  const open  = useUiStore(s => s.labelDialogOpen)
  const close = useUiStore(s => s.closeLabelDialog)
  const toast = useUiStore(s => s.toast)

  const account = useEmailStore(s => s.getActiveAccount())
  const targetEmail = useEmailStore(selectSelectedEmail)
  const focused     = useEmailStore(s => {
    const as = selectActiveState(s)
    return as.emails[as.focusedIndex] ?? null
  })
  const target = targetEmail ?? focused

  const labels       = useLabelsStore(s => s.labels)
  const loadLabels   = useLabelsStore(s => s.load)
  const createLabel  = useLabelsStore(s => s.create)
  const applyLabel   = useEmailStore(s => s.applyLabel)
  const removeLabel  = useEmailStore(s => s.removeLabel)

  const [query,  setQuery]  = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset on open
  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(0)
    loadLabels()
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [open, loadLabels])

  // Filter labels by typed query (substring on name, case-insensitive)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q
      ? labels.filter(l => l.name.toLowerCase().includes(q))
      : labels
    // Already-applied labels float to the top so they're easy to remove
    return [...list].sort((a, b) => {
      const aOn = target?.labels.includes(a.id) ? 1 : 0
      const bOn = target?.labels.includes(b.id) ? 1 : 0
      return bOn - aOn
    })
  }, [labels, query, target])

  // Whether typing would create a new label (no exact-name match)
  const exactMatch = useMemo(
    () => labels.find(l => l.name.toLowerCase() === query.trim().toLowerCase()),
    [labels, query],
  )
  const canCreate = !!query.trim() && !exactMatch
  const totalItems = filtered.length + (canCreate ? 1 : 0)

  // Reset cursor when query changes
  useEffect(() => setCursor(0), [query])

  const commit = async (idx: number) => {
    if (!target) { toast('No email selected'); close(); return }
    if (canCreate && idx === filtered.length) {
      // Create new label, then apply
      if (!account) { toast('No active account'); return }
      const sn = await createLabel({
        ...defaultLabelInput(account.id),
        name: query.trim(),
      })
      await applyLabel(sn.id, target.id)
      toast(`Created label "${sn.name}" and applied`)
      close()
      return
    }
    const label = filtered[idx]
    if (!label) return
    if (target.labels.includes(label.id)) {
      await removeLabel(label.id, target.id)
      toast(`Removed "${label.name}"`)
    } else {
      await applyLabel(label.id, target.id)
      toast(`Applied "${label.name}"`)
    }
    close()
  }

  // Keyboard nav
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCursor(c => Math.min(c + 1, Math.max(totalItems - 1, 0)))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor(c => Math.max(c - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        commit(cursor)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, cursor, totalItems]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh]"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
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
            {/* Header */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border-subtle)]">
              <TagIcon size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={target ? `Label "${truncate(target.subject, 32)}"…` : 'Type a label name…'}
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
              {!target && (
                <div className="px-4 py-6 text-center text-xs text-[var(--text-muted)]">
                  Select an email first
                </div>
              )}

              {target && filtered.length === 0 && !canCreate && (
                <div className="px-4 py-6 text-center text-xs text-[var(--text-muted)]">
                  No labels yet — type a name to create one
                </div>
              )}

              {target && filtered.map((l, i) => {
                const isCursor  = cursor === i
                const isApplied = target.labels.includes(l.id)
                return (
                  <button
                    key={l.id}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => commit(i)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left transition-colors duration-75"
                    style={{
                      background: isCursor ? 'var(--bg-active)' : 'transparent',
                      color:      'var(--text-primary)',
                    }}
                  >
                    <span className="w-3 h-3 rounded-sm flex-shrink-0" style={{ background: l.color }} />
                    <span className="flex-1 truncate">{l.name}</span>
                    {isApplied && (
                      <span
                        className="text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wider"
                        style={{
                          background: 'var(--accent-faint)',
                          color:      'var(--accent)',
                          border:     '1px solid var(--border-accent)',
                        }}
                      >
                        Applied
                      </span>
                    )}
                    {isCursor && (
                      <kbd>{isApplied ? '↵ remove' : '↵'}</kbd>
                    )}
                  </button>
                )
              })}

              {/* Create-new option appears at the bottom whenever the typed
                  query doesn't exactly match an existing label name. */}
              {target && canCreate && (() => {
                const idx = filtered.length
                const isCursor = cursor === idx
                return (
                  <button
                    onMouseEnter={() => setCursor(idx)}
                    onClick={() => commit(idx)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left transition-colors duration-75 border-t"
                    style={{
                      background:  isCursor ? 'var(--bg-active)' : 'transparent',
                      color:       'var(--accent)',
                      borderColor: 'var(--border-subtle)',
                    }}
                  >
                    <PlusIcon size={11} weight="bold" />
                    <span className="flex-1">
                      Create label <strong>&ldquo;{query.trim()}&rdquo;</strong> and apply
                    </span>
                    {isCursor && <kbd>↵</kbd>}
                  </button>
                )
              })()}
            </div>

            {/* Footer hint */}
            <div className="flex items-center gap-3 px-4 py-2 border-t border-[var(--border-subtle)]" style={{ background: 'rgba(0,0,0,0.2)' }}>
              <span className="text-xs text-[var(--text-muted)] flex items-center gap-1"><kbd>↑↓</kbd> navigate</span>
              <span className="text-xs text-[var(--text-muted)] flex items-center gap-1"><kbd>↵</kbd> apply / create</span>
              <span className="text-xs text-[var(--text-muted)] flex items-center gap-1"><kbd>Esc</kbd> close</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function truncate(s: string, max: number): string {
  if (!s) return ''
  return s.length > max ? s.slice(0, max) + '…' : s
}

export type { CustomLabel }
