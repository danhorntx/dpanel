/**
 * Contact extraction & ranking. Pulls a deduplicated, frequency-ranked list
 * of email senders/recipients from the local Dexie cache to power the
 * `from:` autocomplete suggestions.
 */
import { db } from '@/db/db'
import type { Email, EmailAddress } from '@/types/email'

export interface RankedContact extends EmailAddress {
  count: number      // # of times this address has appeared
  last:  number      // most recent appearance (unix ms)
}

let cache:    RankedContact[] | null = null
let cacheTs:  number = 0
const CACHE_TTL = 30_000

export async function getContacts(accountId: string | null = null): Promise<RankedContact[]> {
  if (cache && Date.now() - cacheTs < CACHE_TTL) return cache

  const saved = accountId
    ? await db.contacts.where('accountId').equals(accountId).toArray()
    : await db.contacts.toArray()

  if (saved.length > 0) {
    cache = saved
      .map(c => ({ name: c.name, address: c.address, count: c.count, last: c.last }))
      .sort((a, b) => b.count - a.count || b.last - a.last)
    cacheTs = Date.now()
    return cache
  }

  const rows = accountId
    ? await db.emails.where('accountId').equals(accountId).toArray()
    : await db.emails.toArray()

  const map = new Map<string, RankedContact>()
  const ingest = (a: EmailAddress | undefined, ts: number) => {
    if (!a?.address) return
    const key = a.address.toLowerCase()
    const cur = map.get(key)
    if (cur) {
      cur.count += 1
      if (ts > cur.last) cur.last = ts
      if (!cur.name && a.name) cur.name = a.name
    } else {
      map.set(key, { name: a.name || '', address: a.address, count: 1, last: ts })
    }
  }

  for (const e of rows) {
    ingest(e.from, e.date)
    e.to.forEach(a => ingest(a, e.date))
    e.cc.forEach(a => ingest(a, e.date))
  }

  cache = [...map.values()].sort(
    (a, b) => b.count - a.count || b.last - a.last,
  )
  cacheTs = Date.now()
  await upsertContactsFromEmails(rows).catch(() => {})
  return cache
}

export function invalidateContactCache() {
  cache = null
}

export function filterContacts(contacts: RankedContact[], q: string, limit = 8): RankedContact[] {
  if (!q) return contacts.slice(0, limit)
  const needle = q.toLowerCase()
  return contacts
    .filter(c =>
      c.address.toLowerCase().includes(needle) ||
      c.name.toLowerCase().includes(needle),
    )
    .slice(0, limit)
}

export async function upsertContactsFromEmails(emails: Email[]) {
  if (emails.length === 0) return
  const map = new Map<string, { accountId: string; address: string; name: string; count: number; last: number }>()
  const ingest = (accountId: string, a: EmailAddress | undefined, ts: number) => {
    if (!a?.address) return
    const address = a.address.toLowerCase()
    const key = `${accountId}:${address}`
    const cur = map.get(key)
    if (cur) {
      cur.count += 1
      cur.last = Math.max(cur.last, ts)
      if (!cur.name && a.name) cur.name = a.name
    } else {
      map.set(key, { accountId, address, name: a.name || '', count: 1, last: ts })
    }
  }

  for (const e of emails) {
    ingest(e.accountId, e.from, e.date)
    e.to.forEach(a => ingest(e.accountId, a, e.date))
    e.cc.forEach(a => ingest(e.accountId, a, e.date))
    e.bcc.forEach(a => ingest(e.accountId, a, e.date))
  }

  await db.transaction('rw', db.contacts, async () => {
    for (const next of map.values()) {
      const existing = await db.contacts.get([next.accountId, next.address])
      await db.contacts.put({
        ...next,
        name: existing?.name || next.name,
        count: (existing?.count ?? 0) + next.count,
        last: Math.max(existing?.last ?? 0, next.last),
      })
    }
  })
  invalidateContactCache()
}
