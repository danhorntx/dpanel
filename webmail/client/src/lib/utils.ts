import type { EmailAddress } from '@/types/email'

// ─── Date formatting ─────────────────────────────────────────────────────────

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

export function formatEmailDate(ts: number): string {
  const now = Date.now()
  const diff = ts - now
  const absDiff = Math.abs(diff)

  const minute = 60_000
  const hour = 3_600_000
  const day = 86_400_000

  if (absDiff < minute * 2) return 'just now'
  if (absDiff < hour) return rtf.format(Math.round(diff / minute), 'minutes')

  const date = new Date(ts)
  const today = new Date()

  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  }

  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'

  if (absDiff < day * 6) {
    return date.toLocaleDateString('en-US', { weekday: 'short' })
  }

  if (date.getFullYear() === today.getFullYear()) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
}

export function formatFullDate(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long',
    day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

// ─── Address helpers ─────────────────────────────────────────────────────────

export function displayName(addr: EmailAddress): string {
  return addr.name || addr.address.split('@')[0]
}

export function initials(addr: EmailAddress | string): string {
  const name = typeof addr === 'string' ? addr : (addr.name || addr.address)
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

export function formatAddressList(addrs: EmailAddress[], max = 3): string {
  const names = addrs.map(displayName)
  if (names.length <= max) return names.join(', ')
  return names.slice(0, max).join(', ') + ` +${names.length - max}`
}

// ─── String helpers ───────────────────────────────────────────────────────────

export function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '…' : str
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

// ─── Snooze helpers ───────────────────────────────────────────────────────────

export function snoozeOptions() {
  const now = new Date()
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  tomorrow.setHours(8, 0, 0, 0)

  const thisEvening = new Date(now)
  thisEvening.setHours(18, 0, 0, 0)
  if (thisEvening <= now) thisEvening.setDate(thisEvening.getDate() + 1)

  const nextWeek = new Date(now)
  nextWeek.setDate(now.getDate() + 7)
  nextWeek.setHours(8, 0, 0, 0)

  const nextMonth = new Date(now)
  nextMonth.setMonth(now.getMonth() + 1)
  nextMonth.setDate(1)
  nextMonth.setHours(8, 0, 0, 0)

  return [
    { label: 'This evening', sublabel: formatEmailDate(thisEvening.getTime()), value: thisEvening.getTime() },
    { label: 'Tomorrow morning', sublabel: formatEmailDate(tomorrow.getTime()), value: tomorrow.getTime() },
    { label: 'Next week', sublabel: formatEmailDate(nextWeek.getTime()), value: nextWeek.getTime() },
    { label: 'Next month', sublabel: formatEmailDate(nextMonth.getTime()), value: nextMonth.getTime() },
  ]
}

// ─── Keyboard ────────────────────────────────────────────────────────────────

export function isInputFocused(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName.toLowerCase()
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    (el as HTMLElement).isContentEditable
  )
}

/** Format modifier combo for display: cmd+k → ⌘K */
export function formatShortcut(keys: string): string {
  return keys
    .split('+')
    .map(k => {
      if (k === 'cmd' || k === 'meta') return '⌘'
      if (k === 'ctrl') return '⌃'
      if (k === 'alt' || k === 'opt') return '⌥'
      if (k === 'shift') return '⇧'
      if (k === 'enter') return '↵'
      if (k === 'esc') return '⎋'
      if (k === 'backspace') return '⌫'
      if (k === 'tab') return '⇥'
      if (k === 'space') return '␣'
      if (k === 'up') return '↑'
      if (k === 'down') return '↓'
      return k.toUpperCase()
    })
    .join('')
}

// ─── Color / avatar ──────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  '#7c5cbf', '#5b7eb8', '#4e9e7a', '#b87c4e',
  '#b85e6b', '#6e8cb8', '#9b7ab5', '#5e9e8c',
]

export function avatarColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash)
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}
