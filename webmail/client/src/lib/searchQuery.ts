/**
 * Search query parser — extracts structured operators (`from:`, `in:`) from a
 * free-text query and returns the structured form plus the residual free-text.
 *
 * Examples:
 *   parseQuery('from:alice@x.com invoice')
 *     → { operators: { from: 'alice@x.com' }, freeText: 'invoice' }
 *
 *   parseQuery('in:sent from:bob@x.com Q4 report')
 *     → { operators: { in: 'sent', from: 'bob@x.com' }, freeText: 'Q4 report' }
 *
 *   parseQuery('in:"Big Clients" budget')
 *     → { operators: { in: 'Big Clients' }, freeText: 'budget' }
 */

import type { Email } from '@/types/email'

export interface ParsedQuery {
  operators: {
    from?: string
    to?: string
    in?:   string
    has?: string
    is?: string
    before?: string
    after?: string
  }
  freeText: string
  raw:     string
}

const OPERATOR_RE = /\b(from|to|in|has|is|before|after):(?:"([^"]*)"|(\S+))/gi

export function parseQuery(raw: string): ParsedQuery {
  const operators: ParsedQuery['operators'] = {}
  let stripped = raw

  for (const match of raw.matchAll(OPERATOR_RE)) {
    const op    = match[1].toLowerCase() as keyof ParsedQuery['operators']
    const value = match[2] ?? match[3] ?? ''
    if (value) operators[op] = value
    stripped = stripped.replace(match[0], '')
  }

  return {
    operators,
    freeText: stripped.replace(/\s+/g, ' ').trim(),
    raw,
  }
}

/**
 * Detect whether the cursor is inside an unfinished operator value, so the
 * autocomplete dropdown knows to surface contact / folder suggestions.
 *
 * Returns either:
 *   - { operator: 'from', partial: 'jo', start: 12 } — user is typing after `from:jo`
 *   - { operator: 'in',   partial: '',   start: 9  } — user just typed `in:`
 *   - null — not inside any operator value
 */
export interface ActiveOperator {
	  operator: 'from' | 'to' | 'in' | 'has' | 'is' | 'before' | 'after'
  partial:  string
  start:    number    // index of the operator keyword in the raw string
  end:      number    // index past the partial value
}

export function getActiveOperator(raw: string, cursor: number): ActiveOperator | null {
  // Look backward from cursor for the most recent `from:` or `in:` that the
  // cursor sits inside.
  const slice = raw.slice(0, cursor)
  const m = slice.match(/(?:^|\s)(from|to|in|has|is|before|after):([^\s"]*)$/i)
  if (!m) return null

  const operator = m[1].toLowerCase() as ActiveOperator['operator']
  const partial  = m[2] ?? ''
  const start    = cursor - m[0].trimStart().length
  return { operator, partial, start, end: cursor }
}

/**
 * Run a ParsedQuery against a list of Email objects. Used both by the live
 * inline search popup and the full search results view.
 */
export function filterEmailsByQuery(
  emails: Email[],
  query:  ParsedQuery,
  folderResolver?: (folderToken: string) => (e: Email) => boolean,
): Email[] {
  const { operators, freeText } = query
  const ftLower = freeText.toLowerCase()

  return emails.filter(e => {
    if (operators.from) {
      const needle = operators.from.toLowerCase()
      const hay    = `${e.from.address} ${e.from.name}`.toLowerCase()
      if (!hay.includes(needle)) return false
    }

    if (operators.to) {
      const needle = operators.to.toLowerCase()
      const hay = [...e.to, ...e.cc, ...e.bcc]
        .map(a => `${a.address} ${a.name}`)
        .join(' ')
        .toLowerCase()
      if (!hay.includes(needle)) return false
    }

    if (operators.in) {
      const folderTest = folderResolver?.(operators.in)
      if (folderTest) {
        if (!folderTest(e)) return false
      } else {
        // fallback: match folder name OR a label string
        const tok = operators.in.toLowerCase()
        const matchesFolder = e.folder.toLowerCase() === tok
        const matchesLabel  = e.labels.some(l => l.toLowerCase() === tok)
        if (!matchesFolder && !matchesLabel) return false
      }
    }

    if (operators.has) {
      const tok = operators.has.toLowerCase()
      if (tok === 'attachment' || tok === 'attachments') {
        if (e.attachments.length === 0) return false
      } else if (tok === 'star' || tok === 'starred') {
        if (!e.isStarred) return false
      } else if (tok === 'unread') {
        if (e.isRead) return false
      }
    }

    if (operators.is) {
      const tok = operators.is.toLowerCase()
      if ((tok === 'unread' || tok === 'unseen') && e.isRead) return false
      if (tok === 'read' && !e.isRead) return false
      if ((tok === 'starred' || tok === 'flagged') && !e.isStarred) return false
      if (tok === 'snoozed' && !(e.snoozedUntil && e.snoozedUntil > 0)) return false
      if ((tok === 'archived' || tok === 'done') && !e.isArchived) return false
    }

    if (operators.before) {
      const ts = Date.parse(operators.before)
      if (!Number.isNaN(ts) && e.date >= endOfDay(ts)) return false
    }

    if (operators.after) {
      const ts = Date.parse(operators.after)
      if (!Number.isNaN(ts) && e.date < startOfDay(ts)) return false
    }

    if (ftLower) {
      const hay = `${e.subject} ${e.from.name} ${e.from.address} ${e.snippet} ${e.bodyText}`
        .toLowerCase()
      if (!hay.includes(ftLower)) return false
    }

    return true
  })
}

function startOfDay(ts: number) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function endOfDay(ts: number) {
  const d = new Date(ts)
  d.setHours(23, 59, 59, 999)
  return d.getTime()
}
