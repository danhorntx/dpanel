import { fetchEmails, type ImapAccount } from './imap.js'
import { fetchGmailEmails } from './gmail.js'

// ─── Folder name normalisation ────────────────────────────────────────────────
// Gmail uses [Gmail]/… prefixes; other providers use bare names.

export const GMAIL_FOLDER_MAP: Record<string, string> = {
  'Sent':     '[Gmail]/Sent Mail',
  'Drafts':   '[Gmail]/Drafts',
  'Trash':    '[Gmail]/Trash',
  'Spam':     '[Gmail]/Spam',
  'Starred':  '[Gmail]/Starred',
  'All Mail': '[Gmail]/All Mail',
}

const GMAIL_REVERSE_FOLDER_MAP = new Map(Object.entries(GMAIL_FOLDER_MAP).map(([logical, real]) => [real.toLowerCase(), logical]))

function isGmail(host: string) {
  return host.toLowerCase().includes('gmail') || host.toLowerCase().includes('googlemail')
}

export function resolveImapFolder(imapHost: string, logicalFolder: string): string {
  if (isGmail(imapHost)) return GMAIL_FOLDER_MAP[logicalFolder] ?? logicalFolder
  return logicalFolder
}

export function logicalFolderName(imapHost: string, folder: string): string {
  if (!isGmail(imapHost)) return folder
  return GMAIL_REVERSE_FOLDER_MAP.get(folder.toLowerCase()) ?? folder
}

// ─── Per-account operation queue (prevents concurrent openBox on same conn) ───

const accountQueues = new Map<string, Promise<unknown>>()

function enqueue<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const tail = accountQueues.get(accountId) ?? Promise.resolve()
  const next = tail.then(fn, fn)          // always continue even if prev failed
  accountQueues.set(accountId, next.catch(() => {}))
  return next as Promise<T>
}

// ─── In-memory account store ──────────────────────────────────────────────────
// For production, persist to a SQLite/encrypted file. For now, memory + env.

export interface StoredAccount extends ImapAccount {
  provider?: 'imap' | 'gmail'
  name: string
  email: string
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  isActive: boolean
  lastSync: number
  oauthRefreshToken?: string
  gmailAccessToken?: string
  gmailAccessTokenExpiresAt?: number
  gmailHistoryId?: string
}

const accountStore = new Map<string, StoredAccount>()

// ─── Cache: folder → emails ───────────────────────────────────────────────────
// Key: `${accountId}:${folder}`
const folderCache = new Map<string, {
  emails: Awaited<ReturnType<typeof fetchEmails>>
  fetchedAt: number
}>()

const CACHE_TTL = 30_000 // 30s
const BACKGROUND_FOLDERS = ['INBOX', 'Sent', 'Drafts', 'Trash', 'Spam'] as const

export function registerAccount(account: StoredAccount) {
  accountStore.set(account.id, account)
}

export function getAccount(id: string): StoredAccount | undefined {
  return accountStore.get(id)
}

export function listAccounts(): StoredAccount[] {
  return [...accountStore.values()]
}

export function removeAccount(id: string) {
  accountStore.delete(id)
}

export async function syncFolder(
  accountId: string,
  folder = 'INBOX',
  limit = 100,
  offset = 0,
  forceRefresh = false
): Promise<Awaited<ReturnType<typeof fetchEmails>>> {
  const account = accountStore.get(accountId)
  if (!account) throw new Error(`Account ${accountId} not found`)

  // Cache key MUST include limit + offset so a "load older" call doesn't
  // hit the cached first-page result and return nothing.
  const cacheKey = `${accountId}:${folder}:${limit}:${offset}`
  const cached = folderCache.get(cacheKey)
  const now = Date.now()

  if (!forceRefresh && cached && now - cached.fetchedAt < CACHE_TTL) {
    return cached.emails
  }

  if (account.provider === 'gmail') {
    return enqueue(accountId, async () => {
      const raw = await fetchGmailEmails(account, folder, limit, offset)
      const emails = raw.map(e => ({
        ...e,
        folder,
        id: `${accountId}:${folder}:${'gmailMessageId' in e ? e.gmailMessageId : e.uid}`,
      }))
      folderCache.set(cacheKey, { emails, fetchedAt: Date.now() })
      account.lastSync = Date.now()
      account.gmailHistoryId = raw[0]?.gmailHistoryId ?? account.gmailHistoryId
      return emails
    })
  }

  // Translate logical folder name → real IMAP mailbox name, serialise per account
  return enqueue(accountId, async () => {
    const imapFolder = resolveImapFolder(account.imapHost, folder)
    console.log(`[syncFolder] ${accountId} ${imapFolder} limit=${limit} offset=${offset}`)
    const raw = await fetchEmails(account, imapFolder, limit, offset)
    console.log(`[syncFolder] ${accountId} ${imapFolder} → ${raw.length} emails`)
    // Rewrite folder + id to use the logical name so client stays consistent
    const emails = raw.map(e => ({
      ...e,
      folder,
      id: `${accountId}:${folder}:${e.uid}`,
    }))
    folderCache.set(cacheKey, { emails, fetchedAt: Date.now() })
    account.lastSync = Date.now()
    return emails
  })
}

export function getCachedEmails(accountId: string, folder: string) {
  const prefix = `${accountId}:${folder}:`
  const rows = [...folderCache.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .sort(([, a], [, b]) => b.fetchedAt - a.fetchedAt)
    .flatMap(([, value]) => value.emails)
  const seen = new Set<string>()
  return rows.filter(e => {
    if (seen.has(e.id)) return false
    seen.add(e.id)
    return true
  })
}

export function invalidateCache(accountId: string, folder?: string) {
  if (folder) {
    const prefix = `${accountId}:${folder}:`
    for (const key of folderCache.keys()) {
      if (key.startsWith(prefix)) folderCache.delete(key)
    }
  } else {
    for (const key of folderCache.keys()) {
      if (key.startsWith(`${accountId}:`)) folderCache.delete(key)
    }
  }
}

// ─── Background polling ───────────────────────────────────────────────────────

let pollingInterval: NodeJS.Timeout | null = null
const backgroundInFlight = new Set<string>()

export function startBackgroundSync(intervalMs = 30_000) {
  if (pollingInterval) return
  pollingInterval = setInterval(async () => {
    for (const account of accountStore.values()) {
      if (!account.isActive) continue
      if (backgroundInFlight.has(account.id)) continue
      try {
        backgroundInFlight.add(account.id)
        for (const folder of BACKGROUND_FOLDERS) {
          await syncFolder(account.id, folder, 50, 0, true)
        }
      } catch (err) {
        console.error(`Background sync failed for ${account.id}:`, err)
      } finally {
        backgroundInFlight.delete(account.id)
      }
    }
  }, intervalMs)
}

export function stopBackgroundSync() {
  if (pollingInterval) {
    clearInterval(pollingInterval)
    pollingInterval = null
  }
}
