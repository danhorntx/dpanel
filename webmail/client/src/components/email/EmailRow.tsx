import { memo } from 'react'
import { StarIcon } from '@phosphor-icons/react'
import { Avatar } from '@/components/ui/Avatar'
import { useLabelsStore } from '@/store/labelsStore'
import { formatEmailDate, displayName, truncate } from '@/lib/utils'
import type { Email } from '@/types/email'

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
 * A single row in the email list. Memoized so it only re-renders when its own
 * email data, focus, or selection state changes — critical for the 200+ row case.
 *
 * Layout is shared between desktop and mobile — the same JSX renders both. CSS
 * (in styles/globals.css, .email-row + .email-row-* classes) flips the row from
 * the desktop one-line look (`SUBJECT — snippet preview`) to the mobile stacked
 * look (sender + date on one line, subject below, snippet below that) at
 * ≤720px. The date span is rendered in two places — the header row (mobile)
 * and the trailing column (desktop) — and CSS hides whichever isn't current.
 */
export const EmailRow = memo(function EmailRow({
  email, id, isFocused, isSelected, style, onClick, onStar,
}: EmailRowProps) {
  const labels = useLabelsStore(s => s.labels)
  const visibleLabel = email.labels
    .map(labelId => labels.find(label => label.id === labelId))
    .find(Boolean)

  const dateText = formatEmailDate(email.date)

  return (
    <div
      role="option"
      id={id}
      aria-selected={isSelected}
      tabIndex={isFocused ? 0 : -1}
      style={style}
      onClick={onClick}
      className={[
        'email-row group',
        !email.isRead ? 'unread' : '',
        isFocused ? 'focused' : '',
        isSelected ? 'selected' : '',
      ].filter(Boolean).join(' ')}
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
  )
}, (prev, next) =>
  prev.email === next.email &&
  prev.id === next.id &&
  prev.isFocused === next.isFocused &&
  prev.isSelected === next.isSelected &&
  prev.style.height === next.style.height
)
