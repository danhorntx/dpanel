import { useEffect, useMemo, useState } from 'react'
import { ArchiveIcon } from '@phosphor-icons/react'
import { db } from '@/db/db'
import { INBOX_SPLITS, splitMatchesEmail, useEmailStore, selectActiveState, type InboxSplitId } from '@/store/emailStore'
import { useUiStore } from '@/store/uiStore'
import type { Email } from '@/types/email'

export function InboxSplitBar() {
  const { activeFolder, activeSplit, emails } = useEmailStore(selectActiveState)
  const accountId = useEmailStore(s => s.activeAccountId)
  const setActiveSplit = useEmailStore(s => s.setActiveSplit)
  const archiveEmail = useEmailStore(s => s.archiveEmail)
  const toast = useUiStore(s => s.toast)
  const [counts, setCounts] = useState<Record<InboxSplitId, number>>({
    all: 0,
    important: 0,
    other: 0,
    calendar: 0,
    news: 0,
  })

  useEffect(() => {
    if (!accountId || activeFolder !== 'INBOX') return
    let cancelled = false
    const run = async () => {
      const inbox = await db.emails
        .where('accountId').equals(accountId)
        .filter(email => email.folder === 'INBOX' && !email.isArchived && !email.isTrashed && !email.isSpam)
        .toArray()
      if (cancelled) return
      setCounts({
        all: inbox.length,
        important: inbox.filter(email => splitMatchesEmail(email, 'important')).length,
        other: inbox.filter(email => splitMatchesEmail(email, 'other')).length,
        calendar: inbox.filter(email => splitMatchesEmail(email, 'calendar')).length,
        news: inbox.filter(email => splitMatchesEmail(email, 'news')).length,
      })
    }
    run()
    const timer = window.setInterval(run, 15_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [accountId, activeFolder, emails.length])

  const canClearSplit = activeFolder === 'INBOX' && activeSplit !== 'all' && emails.length > 0
  const visibleIds = useMemo(() => emails.map(email => email.id), [emails])

  if (activeFolder !== 'INBOX') return null

  const clearSplit = async () => {
    const ids = visibleIds.slice(0, 50)
    for (const id of ids) await archiveEmail(id)
    toast(`Archived ${ids.length} from ${INBOX_SPLITS.find(split => split.id === activeSplit)?.label ?? 'split'}`)
  }

  return (
    <div className="inbox-split-bar">
      <div className="flex items-center gap-1 min-w-0">
        {INBOX_SPLITS.map(split => {
          const active = split.id === activeSplit
          return (
            <button
              key={split.id}
              type="button"
              onClick={() => setActiveSplit(split.id)}
              className="split-tab"
              data-active={active ? 'true' : 'false'}
              aria-pressed={active}
            >
              <span>{split.label}</span>
              <span className="split-count">{counts[split.id].toLocaleString()}</span>
              <kbd>{split.shortcut}</kbd>
            </button>
          )
        })}
      </div>
      <button
        type="button"
        onClick={clearSplit}
        disabled={!canClearSplit}
        className="split-clear-button"
        title="Archive visible messages in this split"
      >
        <ArchiveIcon size={13} />
        <span>Clear split</span>
      </button>
    </div>
  )
}
