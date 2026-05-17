import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ArchiveIcon, TrashIcon, ClockIcon, StarIcon,
  EnvelopeIcon, EnvelopeOpenIcon, TrayIcon,
} from '@phosphor-icons/react'
import { useEmailStore } from '@/store/emailStore'
import { useUiStore } from '@/store/uiStore'
import { db } from '@/db/db'
import { tap } from '@/lib/haptic'
import { displayName } from '@/lib/utils'
import type { Email } from '@/types/email'

/**
 * EmailRowMenu — mobile long-press action sheet for an email row.
 *
 * Triggered by a touch hold on an EmailRow. Slides up from the bottom of
 * the screen with the most common message actions: Archive, Snooze, Mark
 * read/unread, Star/Unstar, Move-to-Inbox (if currently archived/trashed/
 * spam), Delete. Tap outside, hit Cancel, or pick an action to dismiss.
 *
 * Rendered globally by AppLayout (one instance, contextual to whichever
 * email id is in uiStore.longPressEmailId). Desktop never opens it because
 * the EmailRow long-press handler is touch-only.
 */
export function EmailRowMenu() {
  const emailId  = useUiStore(s => s.longPressEmailId)
  const close    = useUiStore(s => s.closeLongPress)
  const openSnooze = useUiStore(s => s.openSnoozeModal)
  const toastMsg = useUiStore(s => s.toast)
  const {
    archiveEmail, deleteEmail, restoreEmail, starEmail, markRead, undoLast,
  } = useEmailStore()

  // Snapshot the target email from Dexie when the menu opens. We don't
  // need a live subscription — the actions read the same store/db state.
  const target = useEmailSnapshot(emailId)
  const selectEmail = useEmailStore(s => s.selectEmail)

  // Esc closes the sheet (mostly useful for accessibility / desktop test).
  useEffect(() => {
    if (!emailId) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [emailId, close])

  // Lock body scroll while the sheet is open so the inbox doesn't move
  // underneath it on iOS rubber-band scrolling.
  useEffect(() => {
    if (!emailId) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [emailId])

  return (
    <AnimatePresence>
      {emailId && target && (
        <motion.div
          key="row-menu"
          className="fixed inset-0 z-[60] flex items-end justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          onClick={close}
        >
          {/* Backdrop scrim */}
          <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.5)' }} />

          {/* Sheet */}
          <motion.div
            className="relative w-full max-w-md rounded-t-2xl overflow-hidden"
            style={{
              background: 'var(--bg-elevated)',
              border:     '1px solid var(--border-subtle)',
              paddingBottom: 'env(safe-area-inset-bottom, 0)',
            }}
            initial={{ y: 32, opacity: 0.5 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 360, damping: 32 }}
            onClick={e => e.stopPropagation()}
          >
            {/* Drag handle (decorative) */}
            <div className="flex justify-center pt-2 pb-1">
              <div className="w-10 h-1 rounded-full" style={{ background: 'var(--border-strong)' }} />
            </div>

            {/* Email preview */}
            <div className="px-4 py-2 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="text-xs text-[var(--text-muted)] truncate">{displayName(target.from)}</div>
              <div className="text-sm text-[var(--text-primary)] font-medium truncate">
                {target.subject || '(no subject)'}
              </div>
            </div>

            <MenuActions
              target={target}
              onArchive={() => {
                archiveEmail(target.id)
                toastMsg('Archived', { action: { label: 'Undo', fn: () => undoLast() } })
              }}
              onSnooze={() => {
                // SnoozeModal targets selectedId / focused — but the user
                // may have long-pressed a row that isn't selected. Set the
                // selection to the target before opening so the modal
                // snoozes the right message.
                selectEmail(target.id)
                openSnooze()
              }}
              onToggleRead={() => markRead(target.id, !target.isRead)}
              onToggleStar={() => starEmail(target.id)}
              onRestore={() => {
                restoreEmail(target.id)
                toastMsg('Moved to inbox')
              }}
              onDelete={() => {
                deleteEmail(target.id)
                toastMsg('Deleted', { action: { label: 'Undo', fn: () => undoLast() } })
              }}
              onCancel={close}
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function MenuActions({
  target, onArchive, onSnooze, onToggleRead, onToggleStar, onRestore, onDelete, onCancel,
}: {
  target: Email
  onArchive: () => void
  onSnooze: () => void
  onToggleRead: () => void
  onToggleStar: () => void
  onRestore: () => void
  onDelete: () => void
  onCancel: () => void
}) {
  const canMoveToInbox =
    target.isArchived || target.isTrashed || target.isSpam ||
    (target.snoozedUntil ?? 0) > 0 ||
    target.folder.toLowerCase().includes('trash') ||
    target.folder.toLowerCase().includes('spam')

  const wrap = (fn: () => void) => () => { tap(); fn() }

  type Action = { key: string; label: string; icon: React.ReactNode; onClick: () => void; danger?: boolean }
  const items: Action[] = [
    { key: 'archive', label: 'Archive',                              icon: <ArchiveIcon size={18} />,                                                  onClick: wrap(onArchive) },
    { key: 'snooze',  label: 'Snooze…',                              icon: <ClockIcon size={18} />,                                                    onClick: wrap(onSnooze)  },
    { key: 'mark',    label: target.isRead ? 'Mark unread' : 'Mark read', icon: target.isRead ? <EnvelopeIcon size={18} /> : <EnvelopeOpenIcon size={18} />, onClick: wrap(onToggleRead) },
    { key: 'star',    label: target.isStarred ? 'Unstar' : 'Star',   icon: <StarIcon size={18} weight={target.isStarred ? 'fill' : 'regular'} />,    onClick: wrap(onToggleStar) },
    ...(canMoveToInbox ? [{ key: 'restore', label: 'Move to inbox',  icon: <TrayIcon size={18} />,                                                     onClick: wrap(onRestore) } as Action] : []),
    { key: 'delete',  label: 'Delete',                               icon: <TrashIcon size={18} />, danger: true,                                     onClick: wrap(onDelete) },
  ]

  return (
    <ul role="menu" className="py-1">
      {items.map(a => (
        <li key={a.key}>
          <button
            role="menuitem"
            onClick={a.onClick}
            className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--bg-hover)]"
            style={{ color: a.danger ? 'var(--text-error, #e05c6a)' : 'var(--text-primary)' }}
          >
            <span style={{ color: a.danger ? 'inherit' : 'var(--text-muted)' }}>{a.icon}</span>
            <span className="text-sm">{a.label}</span>
          </button>
        </li>
      ))}
      <li>
        <button
          onClick={onCancel}
          className="w-full px-4 py-3 text-sm text-[var(--text-muted)] hover:bg-[var(--bg-hover)] border-t"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          Cancel
        </button>
      </li>
    </ul>
  )
}

/** Pull the email from local Dexie. Returns null while loading or if id absent. */
function useEmailSnapshot(emailId: string | null): Email | null {
  const [email, setEmail] = useState<Email | null>(null)
  useEffect(() => {
    if (!emailId) { setEmail(null); return }
    let cancelled = false
    db.emails.get(emailId).then(e => { if (!cancelled) setEmail((e as Email | undefined) ?? null) })
    return () => { cancelled = true }
  }, [emailId])
  return email
}
