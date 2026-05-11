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
 */
export const EmailRow = memo(function EmailRow({
  email, id, isFocused, isSelected, style, onClick, onStar,
}: EmailRowProps) {
  const labels = useLabelsStore(s => s.labels)
  const visibleLabel = email.labels
    .map(labelId => labels.find(label => label.id === labelId))
    .find(Boolean)

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
      <div className="flex items-center justify-center">
        <Avatar address={email.from} size="sm" />
      </div>

      {/* Content */}
      <div className="min-w-0 px-2">
        <div className="flex items-baseline gap-2 mb-0.5">
          {/*
            Keep fontWeight CONSTANT across read/unread to avoid layout shift —
            Geist is loaded as static weights here, so 600 vs 400 changes glyph
            advance widths and the truncation point flips on every read-state
            change. Unread is already signaled by the accent bar on the left
            (see .email-row.unread::before) and a brighter color.
          */}
          <span
            className="text-sm truncate"
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
        </div>
        <p
          className="text-[13px] truncate leading-none"
          style={{ color: 'var(--text-secondary)' }}
        >
          <span style={{
            color: email.isRead ? 'var(--text-secondary)' : 'var(--text-primary)',
            fontWeight: 500,           // constant — see comment above
          }}>
            {truncate(email.subject, 50)}
          </span>
          <span className="mx-1 text-[var(--text-disabled)]">—</span>
          <span className="text-[var(--text-muted)]">{truncate(email.snippet, 80)}</span>
        </p>
      </div>

      {/* Date + star */}
      <div className="flex flex-col items-end gap-1 flex-shrink-0 pl-2">
        <span
          className="text-[11px] leading-none tabular-nums"
          style={{ color: 'var(--text-muted)' }}
        >
          {formatEmailDate(email.date)}
        </span>
        <button
          onClick={onStar}
          aria-label={email.isStarred ? 'Unstar' : 'Star'}
          className="p-0.5 rounded transition-opacity duration-100 opacity-0 group-hover:opacity-100"
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
