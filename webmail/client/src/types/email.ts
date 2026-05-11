// ─── Core Email Types ────────────────────────────────────────────────────────

export type MailboxFolder =
  | 'INBOX'
  | 'Sent'
  | 'Drafts'
  | 'Trash'
  | 'Spam'
  | 'Starred'
  | string

export interface EmailAddress {
  name: string
  address: string
}

export interface EmailAttachment {
  filename: string
  contentType: string
  size: number
  contentId?: string
  url?: string
}

export interface Email {
  id: string              // local uid (accountId:folder:uid)
  accountId: string
  uid: number
  folder: MailboxFolder
  messageId: string       // RFC 2822 Message-ID header
  threadId: string        // derived from References / In-Reply-To chain
  subject: string
  from: EmailAddress
  to: EmailAddress[]
  cc: EmailAddress[]
  bcc: EmailAddress[]
  replyTo?: EmailAddress
  date: number            // unix ms
  receivedAt: number      // unix ms
  snippet: string         // first 200 chars of plain text
  bodyHtml: string
  bodyText: string
  attachments: EmailAttachment[]
  labels: string[]
  flags: EmailFlags
  snoozedUntil?: number   // unix ms — when to resurface
  scheduledSendAt?: number // unix ms — for drafts with scheduled send
  isRead: boolean
  isStarred: boolean
  isArchived: boolean
  isTrashed: boolean
  isSpam: boolean
  isMuted: boolean        // muted threads stay archived
  isDraft: boolean
  syncedAt: number        // last sync unix ms
}

export interface EmailFlags {
  seen: boolean
  answered: boolean
  flagged: boolean
  deleted: boolean
  draft: boolean
}

export interface EmailThread {
  id: string
  subject: string
  participants: EmailAddress[]
  emailIds: string[]      // ordered chronologically
  latestDate: number
  isRead: boolean
  isStarred: boolean
  isArchived: boolean
  isMuted: boolean
  snippet: string
  labels: string[]
  count: number
}

// ─── Account ─────────────────────────────────────────────────────────────────

export interface Account {
  id: string
  name: string
  email: string
  provider?: 'imap' | 'gmail'
  imapHost: string
  imapPort: number
  imapTls: boolean
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  username: string
  gmailHistoryId?: string
  // password never stored client-side; only in server .env / config
  isActive: boolean
  syncState: AccountSyncState
}

export interface AccountSyncState {
  lastFullSync: number
  lastDeltaSync: number
  status: 'idle' | 'syncing' | 'error'
  error?: string
  progress?: number     // 0-100 for initial sync
}

// ─── Draft ────────────────────────────────────────────────────────────────────

export interface Draft {
  id: string
  accountId: string
  replyToId?: string    // email being replied to
  forwardOfId?: string  // email being forwarded
  draftSourceId?: string // remote draft message being edited, when present
  to: EmailAddress[]
  cc: EmailAddress[]
  bcc: EmailAddress[]
  subject: string
  bodyHtml: string
  attachments: EmailAttachment[]
  savedAt: number
  scheduledSendAt?: number
}

export interface OutboxEmail {
  id: string
  accountId: string
  to: EmailAddress[]
  cc: EmailAddress[]
  bcc: EmailAddress[]
  subject: string
  bodyHtml: string
  bodyText: string
  replyToId?: string
  forwardOfId?: string
  draftSourceId?: string
  sendAt: number
  createdAt: number
  status: 'queued' | 'sending' | 'failed'
  attempts: number
  lastError?: string
}

export type MailMutationType =
  | 'archive'
  | 'trash'
  | 'restore'
  | 'markRead'
  | 'star'
  | 'spam'
  | 'snooze'
  | 'mute'
  | 'label'

export interface MailMutation {
  id: string
  accountId: string
  type: MailMutationType
  ids: string[]
  payload?: {
    read?: boolean
    starred?: boolean
    until?: number
    threadId?: string
    labels?: string[]
  }
  createdAt: number
  updatedAt: number
  attempts: number
  status: 'queued' | 'sending' | 'failed'
  lastError?: string
}

export interface FollowUpReminder {
  id: string
  emailId: string
  accountId: string
  dueAt: number
  note?: string
  createdAt: number
  completedAt?: number
}

export interface Contact {
  address: string
  accountId: string
  name: string
  count: number
  last: number
}

export interface SyncMeta {
  key: string
  accountId: string
  folder?: string
  status: 'idle' | 'preloading' | 'ready' | 'error'
  totalFetched: number
  cursor?: number
  updatedAt: number
  error?: string
}

// ─── Search ───────────────────────────────────────────────────────────────────

export interface SearchResult {
  emailId: string
  score: number
  matchedFields: string[]
}

// ─── Custom Labels & Auto-sort Rules ──────────────────────────────────────────

export type RuleField =
  | 'from'
  | 'to'
  | 'subject'
  | 'body'
  | 'hasAttachment'
  | 'domain'

export type RuleOperator = 'contains' | 'equals' | 'startsWith' | 'endsWith' | 'is'

export interface LabelRule {
  id:        string
  field:     RuleField
  operator:  RuleOperator
  value:     string         // for 'is' on hasAttachment, value is 'true' | 'false'
}

export type RuleConjunction = 'AND' | 'OR'

export interface CustomLabel {
  id:           string      // generated locally
  accountId:    string      // null/'*' for cross-account, otherwise account-scoped
  name:         string
  color:        string      // hex
  position?:    number      // sidebar sort order; older rows default to updatedAt
  rules:        LabelRule[]
  conjunction:  RuleConjunction
  createdAt:    number
  updatedAt:    number
}

// ─── Snippets (text expansion in compose) ────────────────────────────────────

export interface Snippet {
  id:        string
  shortcut:  string         // typed after `;` to filter (e.g. "sig", "thanks")
  name:      string         // human-readable label
  body:      string         // HTML body to insert; supports basic tags
  createdAt: number
  updatedAt: number
}

// ─── UI State ─────────────────────────────────────────────────────────────────

export type ViewMode = 'split' | 'list'
export type AppView  = 'mail' | 'search' | 'label-manager'
export type ActiveFolder = MailboxFolder | 'snoozed' | { kind: 'label'; id: string }

export interface ToastMessage {
  id: string
  text: string
  action?: {
    label: string
    fn: () => void
  }
  duration?: number     // ms, default 4000
}

// ─── API Payloads ─────────────────────────────────────────────────────────────

export interface SendEmailPayload {
  accountId: string
  to: EmailAddress[]
  cc?: EmailAddress[]
  bcc?: EmailAddress[]
  subject: string
  bodyHtml: string
  bodyText: string
  replyToId?: string
  forwardOfId?: string
  draftSourceId?: string
  scheduledAt?: number
}

export interface SyncStatusPayload {
  accountId: string
  folder: string
  total: number
  fetched: number
  status: 'running' | 'done' | 'error'
}
