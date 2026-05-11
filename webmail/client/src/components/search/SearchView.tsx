import { useEffect, useMemo, useState, useCallback } from 'react'
import {
  MagnifyingGlassIcon, ArrowLeftIcon, XIcon,
} from '@phosphor-icons/react'
import { useUiStore } from '@/store/uiStore'
import { useEmailStore, selectActiveState } from '@/store/emailStore'
import { useLabelsStore } from '@/store/labelsStore'
import { Avatar } from '@/components/ui/Avatar'
import { EmailThread } from '@/components/email/EmailThread'
import { parseQuery } from '@/lib/searchQuery'
import { searchLocalEmails } from '@/lib/search'
import { displayName, formatEmailDate, isInputFocused, truncate } from '@/lib/utils'
import type { Email } from '@/types/email'

const PAGE_SIZE = 50

/**
 * Full-screen search results view. Triggered when the user presses Enter in
 * the command palette. Split-pane layout (results list + preview), matches
 * the main mail view so all email interactions work consistently.
 */
export function SearchView() {
  const query     = useUiStore(s => s.searchQuery)
  const setQuery  = useUiStore(s => s.openSearchView)
  const back      = useUiStore(s => s.openMailView)
  const account   = useEmailStore(s => s.getActiveAccount())
  const { selectedId } = useEmailStore(selectActiveState)
  const selectEmail   = useEmailStore(s => s.selectEmail)
  const markRead      = useEmailStore(s => s.markRead)
  const labels        = useLabelsStore(s => s.labels)

  const [allMatches, setAllMatches] = useState<Email[]>([])
  const [loading,    setLoading]    = useState(true)
  const [page,       setPage]       = useState(1)
  const [draft,      setDraft]      = useState(query)

  const parsed = useMemo(() => parseQuery(query), [query])

  const folderResolver = useCallback((token: string) => {
    const tokLower = token.toLowerCase()
    const label = labels.find(l => l.name.toLowerCase() === tokLower)
    if (label) return (e: Email) => e.labels.includes(label.id)
    return (e: Email) => e.folder.toLowerCase() === tokLower
  }, [labels])

  // Re-run the search whenever query/account/labels change. We pull from
  // Dexie (the local cache) rather than the in-memory view because the view
  // is filtered by folder — search must span the whole account.
  useEffect(() => {
    let cancelled = false
    if (!query.trim()) {
      setAllMatches([])
      setPage(1)
      setLoading(false)
      return
    }
    setLoading(true)
    setPage(1)
    ;(async () => {
      const filtered = await searchLocalEmails(query, {
        accountId: account?.id ?? null,
        limit: 500,
        folderResolver,
      })
      if (!cancelled) {
        setAllMatches(filtered)
        setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [parsed, account?.id, folderResolver])

  useEffect(() => setDraft(query), [query])

  // The selectedId in store is the global selection. For the preview pane
  // here we want the selected match (or the first match) so the preview is
  // always populated.
  const previewEmail =
    allMatches.find(e => e.id === selectedId) ??
    allMatches[0] ??
    null

  // Auto-select the first result when search results change so preview shows
  useEffect(() => {
    if (!loading && allMatches.length > 0) {
      const stillValid = allMatches.find(e => e.id === selectedId)
      if (!stillValid) selectEmail(allMatches[0].id)
    } else if (!loading && allMatches.length === 0) {
      selectEmail(null)
    }
  }, [loading, allMatches, selectedId, selectEmail])

  const visible = allMatches.slice(0, page * PAGE_SIZE)
  const hasMore = visible.length < allMatches.length

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (draft.trim()) setQuery(draft.trim())
  }

	  const onPick = (id: string, isRead: boolean) => {
    selectEmail(id)
    if (!isRead) markRead(id, true)
	  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isInputFocused()) return
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        const current = Math.max(0, allMatches.findIndex(email => email.id === selectedId))
        const next = allMatches[Math.min(current + 1, allMatches.length - 1)]
        if (next) onPick(next.id, next.isRead)
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        const current = Math.max(0, allMatches.findIndex(email => email.id === selectedId))
        const next = allMatches[Math.max(current - 1, 0)]
        if (next) onPick(next.id, next.isRead)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [allMatches, selectedId, selectEmail, markRead])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header bar */}
      <div className="px-6 py-4 border-b" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-elevated)' }}>
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={back}
            className="p-1.5 rounded-md transition-colors hover:bg-[var(--bg-hover)]"
            style={{ color: 'var(--text-muted)' }}
            title="Back to inbox (Esc)"
          >
            <ArrowLeftIcon size={14} />
          </button>
          <span className="text-label text-[var(--text-muted)]">Search Results</span>
          <span className="text-xs text-[var(--text-muted)]">
            {loading ? '…' : `${allMatches.length.toLocaleString()} match${allMatches.length === 1 ? '' : 'es'}`}
          </span>
        </div>

        <form onSubmit={submit} className="flex items-center gap-2">
          <MagnifyingGlassIcon size={14} style={{ color: 'var(--text-muted)' }} />
          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            autoFocus
            className="flex-1 bg-transparent text-sm outline-none text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            placeholder="Refine search…"
          />
        </form>

        {/* Active filters as chips */}
        {(parsed.operators.from || parsed.operators.in || parsed.freeText) && (
          <div className="flex flex-wrap items-center gap-1.5 mt-3">
	            {parsed.operators.from && (
	              <FilterChip label={`from: ${parsed.operators.from}`} onRemove={() => setQuery(rebuildQueryWithout(parsed, 'from'))} />
	            )}
	            {parsed.operators.to && (
	              <FilterChip label={`to: ${parsed.operators.to}`} onRemove={() => setQuery(rebuildQueryWithout(parsed, 'to'))} />
	            )}
	            {parsed.operators.in && (
	              <FilterChip label={`in: ${parsed.operators.in}`} onRemove={() => setQuery(rebuildQueryWithout(parsed, 'in'))} />
	            )}
		            {parsed.operators.has && (
		              <FilterChip label={`has: ${parsed.operators.has}`} onRemove={() => setQuery(rebuildQueryWithout(parsed, 'has'))} />
		            )}
            {parsed.operators.is && (
              <FilterChip label={`is: ${parsed.operators.is}`} onRemove={() => setQuery(rebuildQueryWithout(parsed, 'is'))} />
            )}
            {parsed.freeText && (
              <FilterChip label={`"${parsed.freeText}"`} onRemove={() => setQuery(rebuildQueryWithout(parsed, 'freeText'))} />
            )}
          </div>
        )}
      </div>

      {/* Split pane: results list + preview */}
      <div className="flex flex-1 overflow-hidden">
        {/* Results list */}
        <div
          className="email-list-pane overflow-y-auto"
          style={{ borderRight: '1px solid var(--border-subtle)' }}
        >
          {loading ? (
            <div className="px-6 py-12 text-center text-sm text-[var(--text-muted)]">Searching…</div>
          ) : !query.trim() ? (
            <div className="px-6 py-20 text-center">
              <p className="text-sm text-[var(--text-secondary)] mb-1">Search your mail</p>
              <p className="text-xs text-[var(--text-muted)]">Try from:, in:, has:attachment, or is:unread.</p>
            </div>
          ) : allMatches.length === 0 ? (
            <div className="px-6 py-20 text-center">
              <p className="text-sm text-[var(--text-secondary)] mb-1">No emails match this search</p>
              <p className="text-xs text-[var(--text-muted)]">Try removing filters or rephrasing your query.</p>
            </div>
          ) : (
            <ul role="list">
              {visible.map(email => (
                <li
                  key={email.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onPick(email.id, email.isRead)}
                  className="flex items-start gap-3 px-4 py-3 border-b cursor-pointer transition-colors"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background:  selectedId === email.id ? 'var(--bg-selected)' : 'transparent',
                  }}
                >
                  <Avatar address={email.from} size="sm" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-0.5">
                      <span
                        className="text-sm truncate"
                        style={{
                          fontWeight: 600,
                          color: email.isRead ? 'var(--text-secondary)' : 'var(--text-primary)',
                        }}
                      >
                        {displayName(email.from)}
                      </span>
                      <span className="text-xs text-[var(--text-muted)] flex-shrink-0">{formatEmailDate(email.date)}</span>
                    </div>
                    <div className="text-[13px] truncate" style={{ color: 'var(--text-secondary)' }}>
                      <span style={{ fontWeight: 500, color: email.isRead ? 'var(--text-secondary)' : 'var(--text-primary)' }}>
                        {truncate(email.subject || '(no subject)', 60)}
                      </span>
                      <span className="mx-1 text-[var(--text-disabled)]">—</span>
                      <span className="text-[var(--text-muted)]">{truncate(email.snippet, 90)}</span>
                    </div>
                    {email.labels.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1 mt-1">
                        {email.labels.slice(0, 4).map(l => {
                          const lbl = labels.find(x => x.id === l)
                          if (!lbl) return null
                          return (
                            <span
                              key={l}
                              className="text-[10px] px-1.5 py-0.5 rounded-full"
                              style={{
                                background: `${lbl.color}22`,
                                color:      lbl.color,
                                border:     `1px solid ${lbl.color}55`,
                              }}
                            >
                              {lbl.name}
                            </span>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </li>
              ))}

              {hasMore && (
                <li className="flex justify-center py-6">
                  <button
                    onClick={() => setPage(p => p + 1)}
                    className="px-4 py-2 rounded-md text-sm transition-colors"
                    style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}
                  >
                    Load {Math.min(PAGE_SIZE, allMatches.length - visible.length)} more
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>

        {/* Preview pane — reuses the main EmailThread component so all
            actions (reply, archive, etc.) work identically. We pass the
            email directly because the store's selected-email selector is
            scoped to the active folder's in-memory list. */}
        <div className="email-thread-pane">
          {previewEmail ? (
            <EmailThread email={previewEmail} />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-[var(--text-muted)]">
              {loading ? 'Loading…' : 'Select a result to preview'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium"
      style={{
        background: 'var(--accent-faint)',
        color:      'var(--accent)',
        border:     '1px solid var(--border-accent)',
      }}
    >
      {label}
      <button onClick={onRemove} className="opacity-60 hover:opacity-100 transition-opacity" title="Remove filter">
        <XIcon size={9} weight="bold" />
      </button>
    </span>
  )
}

function rebuildQueryWithout(parsed: ReturnType<typeof parseQuery>, drop: 'from' | 'to' | 'in' | 'has' | 'is' | 'freeText'): string {
  const parts: string[] = []
  if (drop !== 'from' && parsed.operators.from) {
    const v = parsed.operators.from
    parts.push(`from:${v.includes(' ') ? `"${v}"` : v}`)
  }
  if (drop !== 'to' && parsed.operators.to) {
    const v = parsed.operators.to
    parts.push(`to:${v.includes(' ') ? `"${v}"` : v}`)
  }
  if (drop !== 'in' && parsed.operators.in) {
    const v = parsed.operators.in
    parts.push(`in:${v.includes(' ') ? `"${v}"` : v}`)
  }
	  if (drop !== 'has' && parsed.operators.has) parts.push(`has:${parsed.operators.has}`)
  if (drop !== 'is' && parsed.operators.is) parts.push(`is:${parsed.operators.is}`)
  if (drop !== 'freeText' && parsed.freeText) parts.push(parsed.freeText)
  return parts.join(' ')
}
