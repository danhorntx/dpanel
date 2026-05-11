import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  MagnifyingGlassIcon, ArrowBendUpLeftIcon, PaperPlaneRightIcon,
  ArchiveIcon, TrashIcon, StarIcon, ClockIcon, TrayIcon,
  EnvelopeIcon, ArrowBendDoubleUpLeftIcon, ArrowBendUpRightIcon,
  ArrowUpIcon, FolderIcon, UserIcon, TagIcon, FunnelIcon,
  PencilSimpleIcon,
} from '@phosphor-icons/react'
import { INBOX_SPLITS, useEmailStore, selectActiveState } from '@/store/emailStore'
import { useUiStore } from '@/store/uiStore'
import { useLabelsStore } from '@/store/labelsStore'
import { searchLocalEmails } from '@/lib/search'
import { parseQuery, getActiveOperator } from '@/lib/searchQuery'
import { getContacts, filterContacts, type RankedContact } from '@/lib/contacts'
import { createFollowUp } from '@/lib/localWorkflow'
import { displayName, formatEmailDate } from '@/lib/utils'
import type { Email } from '@/types/email'

// ─── Command registry ─────────────────────────────────────────────────────────

interface Command {
  id: string
  label: string
  sublabel?: string
  icon: React.ReactNode
  shortcut?: string
  category: 'action' | 'navigate' | 'compose'
  run: () => void
}

function useCommands(): Command[] {
  const store = useEmailStore()
  const { selectedId, emails } = useEmailStore(selectActiveState)
  const accounts = useEmailStore(s => s.accounts)
  const ui = useUiStore()
  const selectedEmail = emails.find(e => e.id === selectedId) ?? null
  const isDraft = !!selectedEmail && (selectedEmail.isDraft || selectedEmail.folder.toLowerCase().includes('draft'))
  const canMoveToInbox = !!selectedEmail && (
    selectedEmail.isArchived ||
    selectedEmail.isTrashed ||
    selectedEmail.isSpam ||
    (selectedEmail.snoozedUntil ?? 0) > 0 ||
    selectedEmail.folder.toLowerCase().includes('trash') ||
    selectedEmail.folder.toLowerCase().includes('spam')
  )

  const commands: Command[] = [
    { id: 'compose', label: 'Compose new email', icon: <EnvelopeIcon size={15} />, shortcut: 'C', category: 'compose', run: () => ui.openCompose() },
    ...(isDraft
      ? [{ id: 'edit-draft', label: 'Edit draft', icon: <PencilSimpleIcon size={15} />, shortcut: 'Enter', category: 'compose' as const, run: () => selectedId && ui.openCompose({ draftId: selectedId }) }]
      : [
          { id: 'reply',     label: 'Reply',       icon: <ArrowBendUpLeftIcon size={15} />,       shortcut: 'R', category: 'compose' as const, run: () => selectedId && ui.openCompose({ replyToId: selectedId }) },
          { id: 'reply-all', label: 'Reply all',   icon: <ArrowBendDoubleUpLeftIcon size={15} />, shortcut: 'A', category: 'compose' as const, run: () => selectedId && ui.openCompose({ replyToId: selectedId, replyAll: true }) },
          { id: 'forward',   label: 'Forward',     icon: <ArrowBendUpRightIcon size={15} />,      shortcut: 'F', category: 'compose' as const, run: () => selectedId && ui.openCompose({ forwardId: selectedId }) },
        ]),
    ...(!isDraft ? [{ id: 'archive', label: 'Archive', icon: <ArchiveIcon size={15} />, shortcut: 'E', category: 'action' as const, run: () => { store.archiveEmail(); ui.toast('Archived', { action: { label: 'Undo', fn: () => store.undoLast() } }) } }] : []),
    ...(canMoveToInbox ? [{ id: 'move-inbox', label: 'Move to Inbox', icon: <TrayIcon size={15} />, shortcut: '', category: 'action' as const, run: () => { store.restoreEmail(); ui.toast('Moved to inbox') } }] : []),
    { id: 'delete',    label: 'Delete',      icon: <TrashIcon size={15} />,                 shortcut: '#', category: 'action',  run: () => { store.deleteEmail(); ui.toast('Deleted', { action: { label: 'Undo', fn: () => store.undoLast() } }) } },
    { id: 'star',      label: 'Star / Unstar', icon: <StarIcon size={15} />,                shortcut: 'S', category: 'action',  run: () => store.starEmail() },
    { id: 'snooze',    label: 'Snooze',      icon: <ClockIcon size={15} />,                 shortcut: 'H', category: 'action',  run: () => ui.openSnoozeModal() },
    { id: 'mark-unread', label: 'Mark as unread', icon: <EnvelopeIcon size={15} />,         shortcut: 'Shift+U', category: 'action', run: () => store.markUnread() },
    { id: 'follow-up-tomorrow', label: 'Remind me tomorrow', icon: <ClockIcon size={15} />, shortcut: '', category: 'action', run: () => { if (selectedEmail) createFollowUp(selectedEmail, Date.now() + 24 * 60 * 60_000).then(() => ui.toast('Follow-up set for tomorrow')) } },
    { id: 'go-inbox',  label: 'Go to Inbox',   icon: <TrayIcon size={15} />,                shortcut: 'G I', category: 'navigate', run: () => store.setActiveFolder('INBOX') },
    { id: 'go-starred',label: 'Go to Starred', icon: <StarIcon size={15} />,                shortcut: 'G S', category: 'navigate', run: () => store.setActiveFolder('Starred') },
    { id: 'go-sent',   label: 'Go to Sent',    icon: <PaperPlaneRightIcon size={15} />,     shortcut: 'G T', category: 'navigate', run: () => store.setActiveFolder('Sent') },
    { id: 'go-drafts', label: 'Go to Drafts',  icon: <FolderIcon size={15} />,              shortcut: 'G D', category: 'navigate', run: () => store.setActiveFolder('Drafts') },
    { id: 'search',    label: 'Search inbox',  sublabel: 'Open full search', icon: <MagnifyingGlassIcon size={15} />, shortcut: '/', category: 'navigate', run: () => ui.openSearchView('') },
    { id: 'manage-labels', label: 'Manage labels & rules', icon: <TagIcon size={15} />,     shortcut: 'L', category: 'navigate', run: () => ui.openLabelManager() },
  ]

  return [
    ...commands,
    ...accounts.map(account => ({
      id: `switch-account-${account.id}`,
      label: `Switch to ${account.name || account.email}`,
      sublabel: account.email,
      icon: <UserIcon size={15} />,
      category: 'navigate' as const,
      run: () => store.setActiveAccount(account.id),
    })),
    ...INBOX_SPLITS.map(split => ({
      id: `split-${split.id}`,
      label: `Open ${split.label} split`,
      sublabel: 'Split Inbox',
      icon: <FunnelIcon size={15} />,
      shortcut: split.shortcut,
      category: 'navigate' as const,
      run: () => store.setActiveSplit(split.id),
    })),
  ]
}

const SYSTEM_FOLDERS = ['INBOX', 'Sent', 'Drafts', 'Starred', 'Snoozed', 'Trash', 'Spam', 'Archive']
const FILTER_OPTIONS = ['unread', 'read', 'starred', 'snoozed', 'archived', 'attachment']

// ─── Fuzzy filter ─────────────────────────────────────────────────────────────

function filterCommands(commands: Command[], query: string): Command[] {
  if (!query) return commands
  const q = query.toLowerCase()
  return commands
    .map(command => ({
      command,
      score: fuzzyScore(`${command.label} ${command.sublabel ?? ''} ${command.category} ${command.shortcut ?? ''}`, q),
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.command.label.localeCompare(b.command.label))
    .map(item => item.command)
}

function fuzzyScore(value: string, query: string): number {
  const text = value.toLowerCase()
  if (text.includes(query)) return 100 + query.length
  let score = 0
  let qi = 0
  for (let i = 0; i < text.length && qi < query.length; i++) {
    if (text[i] === query[qi]) {
      score += text[i - 1] === ' ' ? 8 : 4
      qi += 1
    }
  }
  return qi === query.length ? score : 0
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CommandPalette() {
  const open  = useUiStore(s => s.commandPaletteOpen)
  const close = useUiStore(s => s.closeCommandPalette)
  const openSearch = useUiStore(s => s.openSearchView)
  const account = useEmailStore(s => s.getActiveAccount())
  const labels  = useLabelsStore(s => s.labels)

  const [query,  setQuery]  = useState('')
  const [cursor, setCursor] = useState(0)
  const [emailResults, setEmailResults] = useState<Email[]>([])
  const [contacts, setContacts] = useState<RankedContact[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const commands = useCommands()

  // ─ Detect active operator (from: / in:)
  const cursorPos = inputRef.current?.selectionEnd ?? query.length
  const active    = getActiveOperator(query, cursorPos)

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)
      setEmailResults([])
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  // Lazy-load contacts when first triggered
  useEffect(() => {
    if (!open) return
    if ((active?.operator === 'from' || active?.operator === 'to') && contacts.length === 0) {
      getContacts(account?.id ?? null).then(setContacts)
    }
  }, [open, active, contacts.length, account?.id])

  // ─ Suggestions for active operator
  const folderOptions = [
    ...SYSTEM_FOLDERS.map(f => ({ kind: 'folder' as const, value: f, color: undefined as string | undefined })),
    ...labels.map(l => ({ kind: 'label' as const, value: l.name, color: l.color })),
  ]

  const operatorSuggestions =
    active?.operator === 'from' || active?.operator === 'to'
      ? filterContacts(contacts, active.partial).map(c => ({
          kind: 'contact' as const,
          display: c.name ? `${c.name} <${c.address}>` : c.address,
          insert: c.address,
          icon: <UserIcon size={13} />,
        }))
      : active?.operator === 'in'
      ? folderOptions
          .filter(o => o.value.toLowerCase().includes(active.partial.toLowerCase()))
          .slice(0, 10)
          .map(o => ({
            kind: 'folder' as const,
            display: o.value,
            insert: o.value.includes(' ') ? `"${o.value}"` : o.value,
            icon: o.kind === 'label'
              ? <span className="w-3 h-3 rounded-sm" style={{ background: o.color }} />
              : <FolderIcon size={13} />,
          }))
      : active?.operator === 'is' || active?.operator === 'has'
      ? FILTER_OPTIONS
          .filter(option => option.includes(active.partial.toLowerCase()))
          .slice(0, 10)
          .map(option => ({
            kind: 'folder' as const,
            display: option,
            insert: option,
            icon: <FunnelIcon size={13} />,
          }))
      : []

  // ─ Live email matching
  useEffect(() => {
    if (!query.trim() || active) { setEmailResults([]); return }
    let cancelled = false
    const folderResolver = (token: string) => {
      const tok = token.toLowerCase()
      const lbl = labels.find(l => l.name.toLowerCase() === tok)
      if (lbl) return (email: Email) => email.labels.includes(lbl.id)
      return (email: Email) => email.folder.toLowerCase() === tok
    }
    searchLocalEmails(query, {
      accountId: account?.id ?? null,
      limit: 5,
      folderResolver,
    }).then(results => {
      if (!cancelled) setEmailResults(results)
    })
    return () => { cancelled = true }
  }, [query, labels, active, account?.id])

  const filteredCommands = active ? [] : filterCommands(commands, query)

  // Show "Search all results" as the FIRST item whenever there's a free-text
  // query and we're not in operator-autocomplete mode. This way pressing Enter
  // on the default cursor jumps straight to the full search view.
  const showSearchAll = !active && query.trim().length > 0
  const allItems = [
    ...(showSearchAll ? [{ type: 'search-all' as const, value: query.trim() }] : []),
    ...operatorSuggestions.map((s, i) => ({ type: 'suggestion' as const, value: s, index: i })),
    ...emailResults.map(e => ({ type: 'email' as const, value: e })),
    ...filteredCommands.map(c => ({ type: 'command' as const, value: c })),
  ]

  // Insert an autocomplete suggestion at the active operator position
  const insertSuggestion = useCallback((insert: string) => {
    if (!active) return
    const before = query.slice(0, active.start)
    const after  = query.slice(active.end)
    const next   = `${before}${active.operator}:${insert} ${after}`.trimEnd() + ' '
    setQuery(next)
    setTimeout(() => {
      inputRef.current?.focus()
      const pos = next.length
      inputRef.current?.setSelectionRange(pos, pos)
    }, 0)
  }, [active, query])

  const select = useCallback((index: number) => {
    const item = allItems[index]
    if (!item) return
    if (item.type === 'command')         { close(); item.value.run() }
    else if (item.type === 'email')      { close(); useEmailStore.getState().selectEmail(item.value.id) }
    else if (item.type === 'suggestion') { insertSuggestion(item.value.insert) }
    else if (item.type === 'search-all') { openSearch(item.value) }
  }, [allItems, close, insertSuggestion, openSearch])

  // Keyboard navigation
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
        e.preventDefault()
        setCursor(c => Math.min(c + 1, allItems.length - 1))
      } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
        e.preventDefault()
        setCursor(c => Math.max(c - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        select(cursor)
      } else if (e.key === 'Escape') {
        close()
      } else if (e.key === 'Tab' && operatorSuggestions[cursor]) {
        e.preventDefault()
        insertSuggestion(operatorSuggestions[cursor].insert)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, allItems, cursor, select, close, query, openSearch, insertSuggestion, operatorSuggestions])

  useEffect(() => setCursor(0), [query])

  const categoryLabel: Record<string, string> = {
    compose: 'Compose',
    action:  'Actions',
    navigate:'Navigate',
  }

  // Visual chips for any operators already committed in the current query
  const parsed = parseQuery(query)
  const chips: { label: string; key: string }[] = []
  if (parsed.operators.from) chips.push({ label: `from: ${parsed.operators.from}`, key: 'from' })
  if (parsed.operators.to)   chips.push({ label: `to: ${parsed.operators.to}`, key: 'to' })
  if (parsed.operators.in)   chips.push({ label: `in: ${parsed.operators.in}`, key: 'in' })
  if (parsed.operators.has)  chips.push({ label: `has: ${parsed.operators.has}`, key: 'has' })
  if (parsed.operators.is)   chips.push({ label: `is: ${parsed.operators.is}`, key: 'is' })

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="command-overlay"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }} onClick={close}
        >
          <motion.div
            className="command-panel"
            initial={{ opacity: 0, scale: 0.97, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -4 }}
            transition={{ duration: 0.15, ease: [0.32, 0.72, 0, 1] }}
            onClick={e => e.stopPropagation()}
          >
            {/* Input */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border-subtle)]">
              <MagnifyingGlassIcon size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
              {chips.length > 0 && (
                <div className="flex items-center gap-1 flex-shrink-0">
                  {chips.map(c => (
                    <span
                      key={c.key}
                      className="text-[11px] font-medium px-1.5 py-0.5 rounded"
                      style={{ background: 'var(--accent-faint)', color: 'var(--accent)', border: '1px solid var(--border-accent)' }}
                    >
                      {c.label}
                    </span>
                  ))}
                </div>
              )}
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search emails or run a command… try is:unread"
                className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
                >
                  Clear
                </button>
              )}
              <kbd>Esc</kbd>
            </div>

            {/* Results */}
            <div className="max-h-[400px] overflow-y-auto py-1">
              {/* Top: Search all results */}
              {showSearchAll && (
                <button
                  onMouseEnter={() => setCursor(0)}
                  onClick={() => { openSearch(query.trim()) }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 text-sm transition-colors duration-75 border-b border-[var(--border-subtle)]"
                  style={{
                    background: cursor === 0 ? 'var(--bg-active)' : 'transparent',
                    color:      'var(--accent)',
                  }}
                >
                  <MagnifyingGlassIcon size={14} style={{ flexShrink: 0 }} />
                  <span className="flex-1 text-left font-medium">
                    Search all results for &ldquo;{query.trim()}&rdquo;
                  </span>
                  <kbd>↵</kbd>
                </button>
              )}

              {/* Operator suggestions */}
              {operatorSuggestions.length > 0 && (() => {
                const offset = showSearchAll ? 1 : 0
                return (
                  <div>
                    <div className="px-3 py-1.5">
                      <span className="text-label text-[var(--text-muted)]">
                        {active?.operator === 'from' || active?.operator === 'to' ? 'Contacts' : 'Mailboxes & Labels'}
                      </span>
                    </div>
                    {operatorSuggestions.map((s, i) => {
                      const idx = offset + i
                      return (
                        <button
                          key={`${s.kind}-${s.display}`}
                          onMouseEnter={() => setCursor(idx)}
                          onClick={() => select(idx)}
                          className="w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors duration-75"
                          style={{
                            background: cursor === idx ? 'var(--bg-active)' : 'transparent',
                            color: 'var(--text-primary)',
                          }}
                        >
                          <span style={{ color: 'var(--text-muted)', flexShrink: 0, display: 'inline-flex' }}>
                            {s.icon}
                          </span>
                          <span className="flex-1 text-left truncate">{s.display}</span>
                          {cursor === idx && <kbd>↹</kbd>}
                        </button>
                      )
                    })}
                  </div>
                )
              })()}

              {allItems.length === 0 && query && !active && (
                <div className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
                  No quick matches — press <kbd>↵</kbd> to see all results
                </div>
              )}

              {/* Email results */}
              {emailResults.length > 0 && (() => {
                const offset = (showSearchAll ? 1 : 0) + operatorSuggestions.length
                return (
                  <div>
                    <div className="px-3 py-1.5">
                      <span className="text-label text-[var(--text-muted)]">Top Emails</span>
                    </div>
                    {emailResults.map((email, i) => {
                      const idx = offset + i
                      return (
                        <button
                          key={email.id}
                          onMouseEnter={() => setCursor(idx)}
                          onClick={() => select(idx)}
                          className="w-full flex items-center gap-3 px-3 py-2.5 text-sm transition-colors duration-75"
                          style={{
                            background: cursor === idx ? 'var(--bg-active)' : 'transparent',
                            color: 'var(--text-primary)',
                          }}
                        >
                          <EnvelopeIcon size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                          <div className="flex-1 min-w-0 text-left">
                            <div className="flex items-center gap-2">
                              <span className="font-medium truncate">{displayName(email.from)}</span>
                              <span className="text-[var(--text-muted)] text-xs truncate">{email.subject}</span>
                            </div>
                            <div className="text-xs text-[var(--text-muted)] truncate">{email.snippet}</div>
                          </div>
                          <span className="text-xs text-[var(--text-muted)] flex-shrink-0">{formatEmailDate(email.date)}</span>
                        </button>
                      )
                    })}
                  </div>
                )
              })()}

              {/* Command results */}
              {filteredCommands.length > 0 && (() => {
                const offset = (showSearchAll ? 1 : 0) + operatorSuggestions.length + emailResults.length
                const grouped = filteredCommands.reduce<Record<string, Command[]>>((acc, cmd) => {
                  if (!acc[cmd.category]) acc[cmd.category] = []
                  acc[cmd.category].push(cmd)
                  return acc
                }, {})
                let runningIdx = offset
                return Object.entries(grouped).map(([cat, cmds]) => (
                  <div key={cat}>
                    <div className="px-3 py-1.5">
                      <span className="text-label text-[var(--text-muted)]">{categoryLabel[cat] ?? cat}</span>
                    </div>
                    {cmds.map(cmd => {
                      const idx = runningIdx++
                      return (
                        <button
                          key={cmd.id}
                          onMouseEnter={() => setCursor(idx)}
                          onClick={() => select(idx)}
                          className="w-full flex items-center gap-3 px-3 py-2.5 text-sm transition-colors duration-75"
                          style={{
                            background: cursor === idx ? 'var(--bg-active)' : 'transparent',
                            color: 'var(--text-primary)',
                          }}
                        >
                          <span style={{ color: cursor === idx ? 'var(--accent)' : 'var(--text-muted)', flexShrink: 0 }}>{cmd.icon}</span>
                          <span className="flex-1 text-left">{cmd.label}</span>
                          {cmd.shortcut && <kbd>{cmd.shortcut}</kbd>}
                          {cursor === idx && (
                            <span className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
                              <ArrowUpIcon size={10} style={{ transform: 'rotate(90deg)' }} />
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                ))
              })()}

              {!query && (
                <div className="px-3 py-1 text-xs text-[var(--text-muted)]">
                  Type to search emails or actions. Try <code>from:</code> or <code>in:</code>.
                </div>
              )}
            </div>

            {/* Footer hint */}
            <div className="flex items-center gap-3 px-4 py-2 border-t border-[var(--border-subtle)]" style={{ background: 'rgba(0,0,0,0.2)' }}>
              <span className="text-xs text-[var(--text-muted)] flex items-center gap-1"><kbd>↑↓</kbd> navigate</span>
              <span className="text-xs text-[var(--text-muted)] flex items-center gap-1"><kbd>↵</kbd> open / search</span>
              <span className="text-xs text-[var(--text-muted)] flex items-center gap-1"><kbd>↹</kbd> autocomplete</span>
              <span className="text-xs text-[var(--text-muted)] flex items-center gap-1"><kbd>Esc</kbd> close</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
