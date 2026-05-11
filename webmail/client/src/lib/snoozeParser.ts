/**
 * Natural-language snooze parser. Wraps chrono-node and applies our defaults:
 *   - Date-only inputs default to 8:00am that day
 *   - Past results get bumped to the next valid occurrence
 *   - Returns both the parsed timestamp and a human-readable label
 */
import * as chrono from 'chrono-node'

export interface ParsedSnooze {
  ts:    number
  label: string
}

const DEFAULT_HOUR = 8

export function parseSnoozeInput(raw: string, ref: Date = new Date()): ParsedSnooze | null {
  const text = raw.trim()
  if (!text) return null

  const results = chrono.parse(text, ref, { forwardDate: true })
  if (results.length === 0) return null

  const r          = results[0]
  const components = r.start

  // Did the user explicitly state a time? If not (date-only), default to 8am.
  const hasTime =
    components.isCertain('hour') ||
    components.isCertain('minute')

  let date = components.date()

  if (!hasTime) {
    date = new Date(date)
    date.setHours(DEFAULT_HOUR, 0, 0, 0)
  }

  // Bump past values to the next sensible occurrence
  if (date.getTime() <= ref.getTime()) {
    if (hasTime) {
      // "8am" already passed today → tomorrow at 8am
      date.setDate(date.getDate() + 1)
    } else {
      // "today" with default 8am already passed → tomorrow at 8am
      date.setDate(date.getDate() + 1)
    }
  }

  return {
    ts:    date.getTime(),
    label: humanLabel(date, ref),
  }
}

function humanLabel(date: Date, ref: Date): string {
  const sameDay = date.toDateString() === ref.toDateString()
  const tomorrow = new Date(ref); tomorrow.setDate(tomorrow.getDate() + 1)
  const isTomorrow = date.toDateString() === tomorrow.toDateString()

  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  if (sameDay)    return `Today at ${time}`
  if (isTomorrow) return `Tomorrow at ${time}`

  const dayDiff = Math.floor((date.getTime() - ref.getTime()) / 86_400_000)
  if (dayDiff < 7) {
    return `${date.toLocaleDateString('en-US', { weekday: 'long' })} at ${time}`
  }
  return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${time}`
}
