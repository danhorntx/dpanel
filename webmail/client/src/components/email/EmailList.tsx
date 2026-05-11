import { useEffect, useRef, useState } from 'react'
import { ArrowClockwiseIcon, CaretDownIcon } from '@phosphor-icons/react'
import { useEmailStore, selectActiveState } from '@/store/emailStore'
import { useUiStore } from '@/store/uiStore'
import { useVirtualList } from '@/hooks/useVirtualList'
import { EmailRow } from './EmailRow'
import type { ActiveFolder } from '@/types/email'

const ROW_HEIGHT = 56

// "Dwell" before we auto-mark-as-read. Stops rapid j/k scrolling from burning
// through unread state.
const READ_DWELL_MS = 600

function SkeletonRows() {
  return (
    <div>
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="email-row" style={{ opacity: 1 - i * 0.07 }}>
          <div className="skeleton w-7 h-7 rounded-full" />
          <div className="px-2 flex-1 min-w-0 space-y-2">
            <div className="skeleton h-3 w-24 rounded" />
            <div className="skeleton h-3 w-full rounded" />
          </div>
          <div className="skeleton h-3 w-12 rounded" />
        </div>
      ))}
    </div>
  )
}

function EmptyState({ folder }: { folder: unknown }) {
  const isLabel = isLabelFolder(folder)
  const label = isLabel ? 'this label' : (folder === 'INBOX' ? 'INBOX' : String(folder))
  return (
    <div className="flex flex-col items-center justify-center h-full py-20 gap-4">
      <div
        className="w-16 h-16 rounded-2xl flex items-center justify-center"
        style={{ background: 'var(--accent-faint)', border: '1px solid var(--border-accent)' }}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
          <path d="M17.5 1L7.5 13h5l-1 10 10-12h-5l1-10z"
            fill="var(--accent)" stroke="var(--accent)" strokeWidth="0.5" strokeLinejoin="round" />
        </svg>
      </div>
      <div className="text-center">
        <p className="text-sm font-medium text-[var(--text-primary)] mb-1">
          {folder === 'INBOX' ? 'Inbox zero' : `No emails in ${label}`}
        </p>
        <p className="text-xs text-[var(--text-muted)]">
          {folder === 'INBOX' ? 'You\'re all caught up.' : 'Nothing here yet.'}
        </p>
      </div>
    </div>
  )
}

function isLabelFolder(folder: unknown): folder is Extract<ActiveFolder, { kind: 'label' }> {
  return typeof folder === 'object' && folder !== null && 'kind' in folder && folder.kind === 'label'
}

export function EmailList() {
  const { emails, focusedIndex, selectedId, isLoading, isSyncing, activeFolder } = useEmailStore(selectActiveState)
  const selectEmail = useEmailStore(s => s.selectEmail)
  const starEmail = useEmailStore(s => s.starEmail)
  const markRead = useEmailStore(s => s.markRead)
  const focusIndex = useEmailStore(s => s.focusIndex)
  const loadMore  = useEmailStore(s => s.loadMore)
  const [moreEmpty, setMoreEmpty] = useState(false)

  const handleLoadMore = async () => {
    const got = await loadMore()
    if (got === 0) setMoreEmpty(true)
  }
  // Reset the "no more" flag when folder changes
  useEffect(() => { setMoreEmpty(false) }, [activeFolder])

  const { scrollRef, virtualItems, totalSize, scrollToIndex } = useVirtualList({
    count: emails.length,
    itemHeight: ROW_HEIGHT,
    overscan: 8,
  })

  // Keep focused row visible
  useEffect(() => {
    scrollToIndex(focusedIndex)
  }, [focusedIndex, scrollToIndex])

  // Dwell-based mark-as-read: whenever selection changes, schedule a single
  // markRead after READ_DWELL_MS. If the user keeps moving (j/k or clicks
  // around), the prior timer is cancelled so they only mark stuff they
  // actually paused on.
  const dwellTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (dwellTimer.current) {
      clearTimeout(dwellTimer.current)
      dwellTimer.current = null
    }
	    if (!selectedId) return
	    const target = emails.find(e => e.id === selectedId)
	    if (!target || target.isRead) return
    dwellTimer.current = setTimeout(() => {
      markRead(selectedId, true)
    }, READ_DWELL_MS)
    return () => {
      if (dwellTimer.current) { clearTimeout(dwellTimer.current); dwellTimer.current = null }
    }
	  }, [selectedId, emails.find(e => e.id === selectedId)?.isRead, markRead])

  // First-paint skeleton — only when truly empty AND something is happening
  if ((isLoading || isSyncing) && emails.length === 0) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <SyncBanner active />
        <div className="flex-1 overflow-hidden">
          <SkeletonRows />
        </div>
      </div>
    )
  }

  if (!isLoading && !isSyncing && emails.length === 0) {
    return <EmptyState folder={activeFolder} />
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <SyncBanner active={isSyncing} />
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden"
	        role="listbox"
	        aria-label="Email list"
          aria-activedescendant={selectedId ? `email-row-${selectedId}` : undefined}
	      >
        {/* Virtualised spacer */}
        <div style={{ height: totalSize, position: 'relative' }}>
          {virtualItems.map(({ index, start }) => {
            const email = emails[index]
            if (!email) return null
            return (
              <div
                key={email.id}
                style={{ position: 'absolute', top: start, left: 0, right: 0 }}
              >
                <EmailRow
	                  email={email}
                    id={`email-row-${email.id}`}
                  isFocused={index === focusedIndex}
                  isSelected={email.id === selectedId}
                  style={{ height: ROW_HEIGHT }}
                  onClick={() => {
                    focusIndex(index)
                    selectEmail(email.id)
                  }}
                  onStar={e => {
                    e.stopPropagation()
                    starEmail(email.id)
                  }}
                />
              </div>
            )
          })}
        </div>

        {/* "Load older" footer — fetches the next page from IMAP. Hidden
            once we've established there's nothing more on the server. */}
        {!moreEmpty && emails.length > 0 && (
          <div className="flex justify-center py-4">
            <button
              onClick={handleLoadMore}
              disabled={isSyncing}
              className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs transition-colors disabled:opacity-50"
              style={{
                background: 'var(--bg-hover)',
                border:     '1px solid var(--border-subtle)',
                color:      'var(--text-secondary)',
              }}
            >
              <CaretDownIcon size={11} weight="bold" />
              {isSyncing ? 'Loading…' : 'Load older'}
            </button>
          </div>
        )}

        {/* Footer count */}
        <div className="flex justify-center pb-3 text-[11px] text-[var(--text-muted)]">
          {emails.length.toLocaleString()} email{emails.length === 1 ? '' : 's'}
          {moreEmpty && ' · all loaded'}
        </div>
      </div>
    </div>
  )
}

function SyncBanner({ active }: { active: boolean }) {
  if (!active) return null
  return (
    <div
      className="flex items-center gap-2 px-4 py-1.5 text-[11px] flex-shrink-0"
      style={{
        background: 'var(--accent-faint)',
        color:      'var(--accent)',
        borderBottom: '1px solid var(--border-accent)',
      }}
    >
      <ArrowClockwiseIcon size={10} className="animate-spin" />
      Syncing from server…
    </div>
  )
}
