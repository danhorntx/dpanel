import { memo, useRef, useState } from 'react'
import { StarIcon, ArchiveIcon, ClockIcon } from '@phosphor-icons/react'
import { Avatar } from '@/components/ui/Avatar'
import { useLabelsStore } from '@/store/labelsStore'
import { useUiStore } from '@/store/uiStore'
import { useEmailStore } from '@/store/emailStore'
import { formatEmailDate, displayName, truncate } from '@/lib/utils'
import { tap as hapticTap } from '@/lib/haptic'
import type { Email } from '@/types/email'

const LONG_PRESS_MS                = 500
const LONG_PRESS_MOVE_TOLERANCE_PX = 8
// Once the pointer moves at least this far in either axis (with X dominating)
// we lock to a horizontal swipe and the long-press timer is cancelled. Under
// this threshold the pointer is still "uncommitted" — could turn into scroll.
const SWIPE_AXIS_LOCK_PX           = 10
// Distance the user must drag for the swipe to commit on release. Below this,
// the row snaps back. Picked at ~half the average mobile row height so a
// confident drag is unambiguous.
const SWIPE_COMMIT_PX              = 80

interface EmailRowProps {
  email: Email
  id?: string
  isFocused: boolean
  isSelected: boolean
  style: React.CSSProperties
  onClick: () => void
  onStar: (e: React.MouseEvent) => void
}

/**
 * A single row in the email list. Memoized so it only re-renders when its
 * own email data, focus, or selection state changes — critical for the
 * 200+ row case.
 *
 * Layout (desktop one-line; mobile stacked) lives in styles/globals.css.
 *
 * Mobile gestures:
 *   - Tap          → onClick (open thread)
 *   - Long-press   → openLongPress(emailId) in uiStore (action sheet)
 *   - Swipe right  → archive
 *   - Swipe left   → snooze (opens snooze modal targeting this email)
 *
 * Desktop pointers (mouse / pen) skip the gesture logic entirely.
 */
export const EmailRow = memo(function EmailRow({
  email, id, isFocused, isSelected, style, onClick, onStar,
}: EmailRowProps) {
  const labels = useLabelsStore(s => s.labels)
  const openLongPress    = useUiStore(s => s.openLongPress)
  const openSnoozeModal  = useUiStore(s => s.openSnoozeModal)
  const toastMsg         = useUiStore(s => s.toast)
  const archiveEmail     = useEmailStore(s => s.archiveEmail)
  const selectEmail      = useEmailStore(s => s.selectEmail)
  const undoLast         = useEmailStore(s => s.undoLast)
  const visibleLabel = email.labels
    .map(labelId => labels.find(label => label.id === labelId))
    .find(Boolean)

  const dateText = formatEmailDate(email.date)

  // ── Long-press handling (touch only) ────────────────────────────────────
  const longPressTimer    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressStart    = useRef<{ x: number; y: number } | null>(null)
  const longPressFiredRef = useRef(false)

  // ── Swipe handling (touch only) ─────────────────────────────────────────
  // swipeDx drives the visual translation; it's component state because we
  // want a re-render per pointermove. swipeAxis locks to 'h' once the user
  // has clearly chosen horizontal — under that they could still be starting
  // a vertical scroll.
  const [swipeDx, setSwipeDx] = useState(0)
  const swipeAxis     = useRef<null | 'h' | 'v'>(null)
  const swipeCommitted = useRef(false)

  const cancelLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
    longPressStart.current = null
  }

  const resetSwipe = () => {
    swipeAxis.current = null
    setSwipeDx(0)
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'touch') return
    longPressFiredRef.current = false
    swipeCommitted.current    = false
    swipeAxis.current         = null
    setSwipeDx(0)
    longPressStart.current = { x: e.clientX, y: e.clientY }
    longPressTimer.current = setTimeout(() => {
      longPressFiredRef.current = true
      longPressTimer.current    = null
      hapticTap()
      openLongPress(email.id)
    }, LONG_PRESS_MS)
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!longPressStart.current) return
    const dx = e.clientX - longPressStart.current.x
    const dy = e.clientY - longPressStart.current.y

    // Cancel long-press once movement exceeds tolerance — user is dragging.
    if (Math.abs(dx) > LONG_PRESS_MOVE_TOLERANCE_PX || Math.abs(dy) > LONG_PRESS_MOVE_TOLERANCE_PX) {
      cancelLongPress()
    }

    // Decide axis on first significant motion. Once locked vertical, leave
    // the row alone so the list can scroll. Once locked horizontal, every
    // subsequent move updates the swipe translation.
    if (swipeAxis.current === null) {
      if (Math.abs(dx) > SWIPE_AXIS_LOCK_PX && Math.abs(dx) > Math.abs(dy) * 1.2) {
        swipeAxis.current = 'h'
      } else if (Math.abs(dy) > SWIPE_AXIS_LOCK_PX) {
        swipeAxis.current = 'v'
        return
      } else {
        return
      }
    }
    if (swipeAxis.current === 'v') return
    setSwipeDx(dx)
  }

  const handlePointerUp = () => {
    cancelLongPress()
    if (swipeAxis.current === 'h' && !swipeCommitted.current) {
      const dx = swipeDx
      if (Math.abs(dx) >= SWIPE_COMMIT_PX) {
        swipeCommitted.current = true
        hapticTap()
        // Animate off-screen in the direction of swipe, then fire the
        // action. The visible "slide off" feedback is what makes the
        // gesture feel committed before the row disappears.
        const finalX = dx > 0 ? window.innerWidth : -window.innerWidth
        setSwipeDx(finalX)
        if (dx > 0) {
          // Right swipe → archive
          window.setTimeout(() => {
            archiveEmail(email.id)
            toastMsg('Archived', { action: { label: 'Undo', fn: () => undoLast() } })
          }, 180)
        } else {
          // Left swipe → snooze (open modal for this email)
          window.setTimeout(() => {
            selectEmail(email.id)
            openSnoozeModal()
            // The snooze modal will fire snoozeEmail when the user picks
            // a time. Snap the visual back to 0 — the row will disappear
            // from the inbox view once snoozeEmail completes.
            setSwipeDx(0)
            swipeAxis.current = null
            swipeCommitted.current = false
          }, 180)
        }
        return
      }
    }
    resetSwipe()
  }
  const handlePointerCancel = () => {
    cancelLongPress()
    resetSwipe()
  }

  const handleClick = () => {
    // Suppress the synthetic click after a long-press / completed swipe.
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false
      return
    }
    if (swipeAxis.current === 'h') {
      // Stray click during/after swipe — never open the thread.
      return
    }
    onClick()
  }

  // Visual reveals behind the row. We render BOTH backdrops and rely on the
  // sign of swipeDx + CSS to display only the relevant one. Snapping the
  // wrapper to overflow-hidden clips the row when it slides off-screen.
  const swipeBg =
    swipeDx > 0 ? 'archive' :
    swipeDx < 0 ? 'snooze'  : null

  return (
    <div
      className={`email-row-swipe-host${swipeCommitted.current ? ' committed' : ''}`}
      style={{ ...style, position: 'relative', overflow: 'hidden' }}
    >
      {/* Backdrop reveals — shown only when the user is swiping. The icon
          opacity scales with the drag distance so it fades in as the user
          commits. CSS class .show toggles visibility so this DOM stays put
          when there's no swipe (avoids re-mounting per pointermove). */}
      <div className={`email-row-swipe-bg email-row-swipe-archive${swipeBg === 'archive' ? ' show' : ''}`}>
        <ArchiveIcon size={18} />
        <span className="text-xs ml-2 font-medium">Archive</span>
      </div>
      <div className={`email-row-swipe-bg email-row-swipe-snooze${swipeBg === 'snooze' ? ' show' : ''}`}>
        <span className="text-xs mr-2 font-medium">Snooze</span>
        <ClockIcon size={18} />
      </div>

      <div
        role="option"
        id={id}
        aria-selected={isSelected}
        tabIndex={isFocused ? 0 : -1}
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        className={[
          'email-row group',
          !email.isRead ? 'unread' : '',
          isFocused ? 'focused' : '',
          isSelected ? 'selected' : '',
        ].filter(Boolean).join(' ')}
        style={{
          // The row spans the host. Height comes from CSS .email-row /
          // --row-height. We only transform horizontally for swipe.
          height: '100%',
          transform: swipeDx !== 0 ? `translateX(${swipeDx}px)` : undefined,
          transition: swipeDx === 0 ? 'transform 180ms ease' : swipeCommitted.current ? 'transform 180ms ease' : 'none',
          // Tell the browser we own horizontal gestures here; vertical
          // still pans normally so list scroll works.
          touchAction: 'pan-y',
        }}
      >
        {/* Avatar */}
        <div className="email-row-avatar flex items-center justify-center">
          <Avatar address={email.from} size="sm" />
        </div>

        {/* Content column */}
        <div className="email-row-content min-w-0 px-2">
          {/* Header row: sender + optional label + mobile-only date */}
          <div className="email-row-header flex items-baseline gap-2 mb-0.5">
            {/*
              Keep fontWeight CONSTANT across read/unread to avoid layout shift —
              Geist is loaded as static weights here, so 600 vs 400 changes glyph
              advance widths and the truncation point flips on every read-state
              change. Unread is already signaled by the accent bar on the left
              (see .email-row.unread::before) and a brighter color.
            */}
            <span
              className="email-row-sender text-sm truncate flex-1 min-w-0"
              style={{
                fontWeight: 600,
                color: email.isRead ? 'var(--text-secondary)' : 'var(--text-primary)',
              }}
            >
              {displayName(email.from)}
            </span>
            {visibleLabel && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0"
                style={{
                  background: `${visibleLabel.color}22`,
                  color: visibleLabel.color,
                  border: `1px solid ${visibleLabel.color}55`,
                }}
              >
                {visibleLabel.name}
              </span>
            )}
            {/* Mobile date — hidden on desktop via CSS. */}
            <span
              className="email-row-date-mobile text-[11px] tabular-nums flex-shrink-0"
              style={{ color: 'var(--text-muted)' }}
            >
              {dateText}
            </span>
          </div>

          {/* Body: SUBJECT — snippet (single line on desktop; stacks on mobile) */}
          <p className="email-row-body text-[13px] leading-tight min-w-0">
            <span
              className="email-row-subject truncate"
              style={{
                color: email.isRead ? 'var(--text-secondary)' : 'var(--text-primary)',
                fontWeight: 500,
              }}
            >
              {truncate(email.subject, 60)}
            </span>
            <span className="email-row-dash mx-1 text-[var(--text-disabled)]">—</span>
            <span className="email-row-snippet text-[var(--text-muted)] truncate">
              {truncate(email.snippet, 80)}
            </span>
          </p>
        </div>

        {/* Trailing column — desktop date + star.
            On mobile the date moves up into the header row and this column
            collapses to just the star button. */}
        <div className="email-row-trailing flex flex-col items-end gap-1 flex-shrink-0 pl-2">
          <span
            className="email-row-date-desktop text-[11px] leading-none tabular-nums"
            style={{ color: 'var(--text-muted)' }}
          >
            {dateText}
          </span>
          <button
            onClick={onStar}
            aria-label={email.isStarred ? 'Unstar' : 'Star'}
            className="email-row-star p-0.5 rounded transition-opacity duration-100 opacity-0 group-hover:opacity-100"
            style={{ color: email.isStarred ? 'var(--accent)' : 'var(--text-disabled)' }}
          >
            <StarIcon
              size={12}
              weight={email.isStarred ? 'fill' : 'regular'}
            />
          </button>
        </div>
      </div>
    </div>
  )
}, (prev, next) =>
  prev.email === next.email &&
  prev.id === next.id &&
  prev.isFocused === next.isFocused &&
  prev.isSelected === next.isSelected &&
  prev.style.height === next.style.height
)
