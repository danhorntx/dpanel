/**
 * Auto-sort rule engine. Evaluates a CustomLabel's rules against an Email and
 * returns whether the email should be tagged with that label.
 */
import type { CustomLabel, Email, LabelRule } from '@/types/email'

function fieldValue(email: Email, field: LabelRule['field']): string | boolean {
  switch (field) {
    case 'from':          return `${email.from.name} ${email.from.address}`.toLowerCase()
    case 'to':            return email.to.map(a => `${a.name} ${a.address}`).join(' ').toLowerCase()
    case 'subject':       return (email.subject ?? '').toLowerCase()
    case 'body':          return (email.bodyText ?? '').toLowerCase()
    case 'hasAttachment': return email.attachments.length > 0
    case 'domain':        return (email.from.address.split('@')[1] ?? '').toLowerCase()
  }
}

function evalRule(email: Email, rule: LabelRule): boolean {
  const v = fieldValue(email, rule.field)

  if (rule.field === 'hasAttachment') {
    const want = rule.value === 'true'
    return v === want
  }

  const haystack = String(v).toLowerCase()
  const needle   = rule.value.toLowerCase().trim()
  if (!needle) return false

  switch (rule.operator) {
    case 'contains':   return haystack.includes(needle)
    case 'equals':     return haystack === needle
    case 'startsWith': return haystack.startsWith(needle)
    case 'endsWith':   return haystack.endsWith(needle)
    case 'is':         return haystack === needle
  }
}

export function emailMatchesLabel(email: Email, label: CustomLabel): boolean {
  if (label.rules.length === 0) return false
  if (label.conjunction === 'AND') {
    return label.rules.every(r => evalRule(email, r))
  }
  return label.rules.some(r => evalRule(email, r))
}

/** Returns the ids of every label whose rules match the email. */
export function matchingLabelIds(email: Email, labels: CustomLabel[]): string[] {
  return labels
    .filter(l =>
      (l.accountId === '*' || l.accountId === email.accountId) &&
      emailMatchesLabel(email, l),
    )
    .map(l => l.id)
}

/**
 * Apply rules to a batch of emails, returning a map of emailId → label ids
 * to attach. Used by the bulk re-run feature and on-sync hooks.
 */
export function applyRulesToBatch(
  emails: Email[],
  labels: CustomLabel[],
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const e of emails) {
    const ids = matchingLabelIds(e, labels)
    if (ids.length > 0) out.set(e.id, ids)
  }
  return out
}
