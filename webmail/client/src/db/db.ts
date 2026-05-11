import Dexie, { type Table } from 'dexie'
import type { Email, EmailThread, Account, Draft, CustomLabel, Snippet, OutboxEmail, MailMutation, FollowUpReminder, Contact, SyncMeta } from '@/types/email'

// ─── Schema ───────────────────────────────────────────────────────────────────
// Local-first cache. The IMAP server is the source of truth; this DB is the
// read layer, kept eventually consistent by the sync service.

class SuperhumanDB extends Dexie {
  emails!: Table<Email>
  threads!: Table<EmailThread>
  accounts!: Table<Account>
  drafts!: Table<Draft>
  labels!: Table<CustomLabel>
  snippets!: Table<Snippet>
  outbox!: Table<OutboxEmail>
  mailMutations!: Table<MailMutation>
  followUps!: Table<FollowUpReminder>
  contacts!: Table<Contact>
  syncMeta!: Table<SyncMeta>

  constructor() {
    super('superhuman')

    this.version(1).stores({
      // Primary key + indexed fields only (Dexie syntax)
      emails: [
        'id',
        'accountId',
        'folder',
        'threadId',
        'date',
        'receivedAt',
        'isRead',
        'isStarred',
        'isArchived',
        'isTrashed',
        'isSpam',
        'isMuted',
        'isDraft',
        'snoozedUntil',
        '[accountId+folder]',
        '[accountId+folder+isArchived]',
        '[accountId+isStarred]',
        '[accountId+isDraft]',
        '[accountId+isTrashed]',
        '[accountId+isSpam]',
        '[threadId+date]',
      ].join(','),

      threads: [
        'id',
        'latestDate',
        'isRead',
        'isStarred',
        'isArchived',
        'isMuted',
        '[isArchived+latestDate]',
        '[isStarred+latestDate]',
      ].join(','),

      accounts: 'id',
      drafts: 'id, accountId, savedAt',
    })

    // v2 — custom labels with auto-sort rules
    this.version(2).stores({
      labels: 'id, accountId, name, updatedAt',
    })

    // v3 — snippets for compose text expansion
    this.version(3).stores({
      snippets: 'id, shortcut, name, updatedAt',
    })

    // v4 — durable outbox, follow-up reminders, and incremental contacts
    this.version(4).stores({
      outbox: 'id, accountId, sendAt, status, createdAt',
      followUps: 'id, emailId, accountId, dueAt, completedAt',
      contacts: '[accountId+address], accountId, address, last, count',
    })

    // v5 — preload/incremental sync metadata
    this.version(5).stores({
      syncMeta: 'key, accountId, folder, status, updatedAt',
    })

    // v6 — durable optimistic mail operations for offline/flaky connections,
    // plus extra compound read indexes for split inbox/search/counts.
    this.version(6).stores({
      emails: [
        'id',
        'accountId',
        'folder',
        'threadId',
        'date',
        'receivedAt',
        'isRead',
        'isStarred',
        'isArchived',
        'isTrashed',
        'isSpam',
        'isMuted',
        'isDraft',
        'snoozedUntil',
        '[accountId+folder]',
        '[accountId+folder+date]',
        '[accountId+folder+isRead]',
        '[accountId+folder+isArchived]',
        '[accountId+isRead]',
        '[accountId+isStarred]',
        '[accountId+isDraft]',
        '[accountId+isTrashed]',
        '[accountId+isSpam]',
        '[accountId+snoozedUntil]',
        '[threadId+date]',
      ].join(','),
      mailMutations: 'id, accountId, type, status, updatedAt',
    })

    // v7 — remove provider-native label ids that were previously cached in
    // Email.labels. Duperhuman labels are local CustomLabel ids; anything else
    // renders as an orphan chip the user cannot edit.
    this.version(7).stores({}).upgrade(async tx => {
      const labels = await tx.table('labels').toArray() as CustomLabel[]
      const validIds = new Set(labels.map(label => label.id))
      await tx.table('emails').toCollection().modify((email: Email) => {
        if (!Array.isArray(email.labels)) {
          email.labels = []
          return
        }
        email.labels = email.labels.filter(id => validIds.has(id))
      })
    })
  }
}

export const db = new SuperhumanDB()

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Upsert a batch of emails, merging flags from server */
export async function upsertEmails(emails: Email[]) {
  return db.emails.bulkPut(emails)
}

/** Get inbox threads (not archived, not trashed, not spam) sorted by date desc */
export async function getInboxThreadIds(limit = 100, offset = 0) {
  return db.threads
    .where('[isArchived+latestDate]')
    .between([0, Dexie.minKey], [0, Dexie.maxKey])
    .reverse()
    .offset(offset)
    .limit(limit)
    .primaryKeys()
}

export async function getInboxEmails(accountId: string, limit = 200) {
  return db.emails
    .where('[accountId+folder+isArchived]')
    .equals([accountId, 'INBOX', 0])
    .reverse()
    .sortBy('date')
    .then(rows => rows.slice(0, limit))
}

export async function getSnoozedEmails(accountId: string) {
  return db.emails
    .where('snoozedUntil')
    .above(0)
    .and(e => e.accountId === accountId && (e.snoozedUntil ?? 0) <= Date.now())
    .toArray()
}
