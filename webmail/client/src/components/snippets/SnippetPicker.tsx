import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { LightningIcon } from '@phosphor-icons/react'
import { useSnippetsStore, filterSnippets } from '@/store/snippetsStore'
import type { Snippet } from '@/types/email'

export interface SnippetPickerProps {
  open:      boolean
  /** Where to anchor the popup. Page coordinates of the caret. */
  anchor:    { x: number; y: number } | null
  /** Text typed AFTER the trigger character (`;`). */
  query:     string
  onSelect:  (snippet: Snippet) => void
  onCancel:  () => void
  /** Reports back the active snippet so parent can extend the live query
      window — not strictly required but useful for empty-state branching. */
  onActiveChange?: (active: Snippet | null) => void
}

/**
 * The `;`-triggered snippet picker. Shows a small floating list anchored to
 * the caret. Filters as the user types after the `;`. Enter / Tab inserts
 * the highlighted snippet. Escape cancels.
 *
 * Keyboard handling here is intentionally captured at the window level so
 * it works regardless of whether the contentEditable body has focus. The
 * parent component (ComposeWindow) is responsible for forwarding the
 * typed-after-trigger query and opening / closing this picker.
 */
export function SnippetPicker({ open, anchor, query, onSelect, onCancel, onActiveChange }: SnippetPickerProps) {
  const snippets = useSnippetsStore(s => s.snippets)
  const load     = useSnippetsStore(s => s.load)
  const [cursor, setCursor] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => { if (open) load() }, [open, load])

  const filtered = useMemo(() => filterSnippets(snippets, query, 8), [snippets, query])

  // Reset / clamp cursor as the filtered list shrinks
  useEffect(() => {
    setCursor(c => (filtered.length === 0 ? 0 : Math.min(c, filtered.length - 1)))
  }, [filtered.length])

  // Notify parent when the active snippet changes
  useEffect(() => {
    onActiveChange?.(filtered[cursor] ?? null)
  }, [filtered, cursor, onActiveChange])

  // Keyboard nav: capture before the contentEditable handler so arrow keys
  // and enter don't fall through.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCursor(c => Math.min(c + 1, Math.max(filtered.length - 1, 0)))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor(c => Math.max(c - 1, 0))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        const pick = filtered[cursor]
        if (pick) {
          e.preventDefault()
          e.stopPropagation()
          onSelect(pick)
        } else {
          onCancel()
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, filtered, cursor, onSelect, onCancel])

  // Position: prefer below caret, but flip up if it would clip the viewport
  const style = useMemo<React.CSSProperties>(() => {
    if (!anchor) return { display: 'none' }
    const PANEL_W   = 320
    const PANEL_H   = 280
    const margin    = 8
    const viewportW = window.innerWidth
    const viewportH = window.innerHeight
    const flipUp    = anchor.y + PANEL_H + margin > viewportH
    const left      = Math.max(margin, Math.min(anchor.x, viewportW - PANEL_W - margin))
    const top       = flipUp ? anchor.y - PANEL_H - margin : anchor.y + 18
    return { left, top, width: PANEL_W }
  }, [anchor])

  return (
    <AnimatePresence>
      {open && anchor && (
        <motion.div
          ref={ref}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 2 }}
          transition={{ duration: 0.1, ease: [0.32, 0.72, 0, 1] }}
          className="fixed z-[60] rounded-lg overflow-hidden"
          style={{
            ...style,
            background: 'var(--bg-overlay)',
            border:     '1px solid var(--border-strong)',
            boxShadow:  '0 12px 40px rgba(0,0,0,0.5)',
          }}
          onMouseDown={e => e.preventDefault()}    // keep contentEditable focus
        >
          <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-subtle)]">
            <LightningIcon size={11} weight="fill" style={{ color: 'var(--accent)' }} />
            <span className="text-[11px] uppercase tracking-wider text-[var(--text-muted)] font-semibold">
              Snippet
            </span>
            {query && (
              <span
                className="ml-auto text-[11px] font-mono px-1.5 py-0.5 rounded"
                style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}
              >
                ;{query}
              </span>
            )}
          </div>

          <div className="max-h-[260px] overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-6 text-center">
                <p className="text-xs text-[var(--text-secondary)]">
                  {query ? `No snippets match ";${query}"` : 'No snippets yet'}
                </p>
                <p className="text-[11px] text-[var(--text-muted)] mt-1">
                  Manage snippets in <kbd>Settings</kbd> → Snippets
                </p>
              </div>
            ) : (
              filtered.map((s, i) => (
                <button
                  key={s.id}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => onSelect(s)}
                  className="w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors duration-75 text-left"
                  style={{
                    background: cursor === i ? 'var(--bg-active)' : 'transparent',
                    color:      'var(--text-primary)',
                  }}
                >
                  <span
                    className="text-[10px] font-mono font-semibold flex-shrink-0 px-1.5 py-0.5 rounded"
                    style={{
                      background: 'var(--accent-faint)',
                      color:      'var(--accent)',
                      border:     '1px solid var(--border-accent)',
                    }}
                  >
                    ;{s.shortcut}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{s.name}</div>
                    <div className="text-[11px] text-[var(--text-muted)] truncate">
                      {plainPreview(s.body)}
                    </div>
                  </div>
                  {cursor === i && <kbd>↵</kbd>}
                </button>
              ))
            )}
          </div>

          <div
            className="flex items-center gap-3 px-3 py-1.5 border-t border-[var(--border-subtle)]"
            style={{ background: 'rgba(0,0,0,0.2)' }}
          >
            <span className="text-[10px] text-[var(--text-muted)] flex items-center gap-1"><kbd>↑↓</kbd> nav</span>
            <span className="text-[10px] text-[var(--text-muted)] flex items-center gap-1"><kbd>↵</kbd> insert</span>
            <span className="text-[10px] text-[var(--text-muted)] flex items-center gap-1"><kbd>Esc</kbd> cancel</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function plainPreview(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
}
