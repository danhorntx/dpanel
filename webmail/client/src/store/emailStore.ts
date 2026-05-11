import { create } from 'zustand'
import { db } from '@/db/db'
import { accounts as accountsApi, emails as emailsApi, type MailFolderInfo } from '@/lib/api'
import { buildIndex, addToIndex } from '@/lib/search'
import { useLabelsStore } from '@/store/labelsStore'
import { useUiStore } from '@/store/uiStore'
import { invalidateContactCache, upsertContactsFromEmails } from '@/lib/contacts'
import { resurfaceDueSnoozes } from '@/lib/localWorkflow'
import { cancelMailMutations, queueMailMutation } from '@/lib/mailMutations'
import type { Email, ActiveFolder, Account } from '@/types/email'

// ─── Per-account view state ───────────────────────────────────────────────────

export interface AccountViewState {
  emails:        Email[]
  selectedId:    string | null
  focusedIndex:  number
  activeFolder:  ActiveFolder
  activeSplit:   InboxSplitId
  isLoading:     boolean      // serving local cache → first paint
  isSyncing:     boolean      // background fetch from IMAP in progress
  hasSyncedOnce: Record<string, boolean>   // folderKey → ever fetched from server
  pendingArchive: Map<string, Email>
  pendingDelete:  Map<string, Email>
}

export type InboxSplitId = 'all' | 'important' | 'other' | 'calendar' | 'news'

export interface InboxSplit {
  id: InboxSplitId
  label: string
  shortcut: string
}

export const INBOX_SPLITS: InboxSplit[] = [
  { id: 'all',       label: 'All',       shortcut: '1' },
  { id: 'important', label: 'Important', shortcut: '2' },
  { id: 'other',     label: 'Other',     shortcut: '3' },
  { id: 'calendar',  label: 'Calendar',  shortcut: '4' },
  { id: 'news',      label: 'News',      shortcut: '5' },
]

function defaultAccountState(): AccountViewState {
  return {
    emails:        [],
	    selectedId:    null,
	    focusedIndex:  0,
	    activeFolder:  'INBOX',
    activeSplit:   'all',
	    isLoading:     false,
    isSyncing:     false,
    hasSyncedOnce: {},
    pendingArchive: new Map(),
    pendingDelete:  new Map(),
  }
}

// Pull a deep batch on first sync of a folder, smaller delta after.
const FIRST_SYNC_LIMIT = 500
const DELTA_SYNC_LIMIT = 100
const PRELOAD_PAGE_SIZE = 250
const SYSTEM_PRELOAD_FOLDERS = ['INBOX', 'Sent', 'Drafts', 'Trash', 'Spam', 'Starred'] as const

function folderKey(f: ActiveFolder): string {
  if (typeof f === 'object') return `label:${f.id}`
  return String(f)
}

// ─── Store shape ──────────────────────────────────────────────────────────────

interface EmailStore {
  accounts:        Account[]
  activeAccountId: string | null
  accountStates:   Record<string, AccountViewState>
	  syncProgress:    number | null
	  syncStatus:      string | null

  // Account management
  setAccounts:      (accounts: Account[]) => void
  addAccount:       (account: Account)    => void
  removeAccount:    (id: string)          => Promise<void>
  setActiveAccount: (id: string)          => void

  // Convenience: active account object
  getActiveAccount: () => Account | null

  // Per-account view actions (operate on active account unless id provided)
	  setActiveFolder:  (folder: ActiveFolder) => void
  setActiveSplit:   (split: InboxSplitId) => void
  focusNextSplit:   () => void
  focusPrevSplit:   () => void
	  loadEmails:       ()  => Promise<void>
  selectEmail:      (id: string | null) => void
  focusIndex:       (index: number)     => void
  focusNext:        ()  => void
  focusPrev:        ()  => void
  openFocused:      ()  => void

  loadMore:    () => Promise<number>   // returns # of new emails fetched

  // Apply / remove a label on a single email (by label id, not name)
  applyLabel:  (labelId: string, emailId?: string) => Promise<void>
  removeLabel: (labelId: string, emailId?: string) => Promise<void>

  archiveEmail: (id?: string) => Promise<void>
  deleteEmail:  (id?: string) => Promise<void>
  restoreEmail: (id?: string) => Promise<void>
  starEmail:    (id?: string) => Promise<void>
  markRead:     (id: string, read: boolean) => Promise<void>
  markUnread:   (id?: string) => Promise<void>
  markSpam:     (id?: string) => Promise<void>
  muteThread:   (id?: string) => Promise<void>
  snoozeEmail:  (id: string, until: number) => Promise<void>
  undoLast:     () => Promise<void>
	  triggerSync:  () => Promise<void>
	  preloadAllMail: (accountId?: string, mode?: 'auto' | 'full' | 'delta') => Promise<void>
	  processLocalWorkflow: () => Promise<void>
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Read the active account's view state (never null). */
function getAS(s: Pick<EmailStore, 'activeAccountId' | 'accountStates'>): AccountViewState {
  return s.accountStates[s.activeAccountId ?? ''] ?? defaultAccountState()
}

/** Produce an updated accountStates record patching only the active account. */
function patchAS(
  s: Pick<EmailStore, 'activeAccountId' | 'accountStates'>,
  patch: Partial<AccountViewState>,
): Record<string, AccountViewState> {
  const id = s.activeAccountId
  if (!id) return s.accountStates
  const prev = s.accountStates[id] ?? defaultAccountState()
  return { ...s.accountStates, [id]: { ...prev, ...patch } }
}

async function loadLocalEmails(accountId: string, activeFolder: ActiveFolder, activeSplit: InboxSplitId = 'all'): Promise<Email[]> {
  // Dexie 3.x can miss boolean compound keys in some browsers, so flag-heavy
  // folders intentionally query by accountId/folder and filter in JS. Keeping
  // this in one helper prevents the inbox/list and preload refresh paths from
  // drifting apart again.
  if (activeFolder === 'INBOX') {
    const emails = await db.emails
      .where('accountId').equals(accountId)
      .filter(e => e.folder === 'INBOX' && !e.isArchived && !e.isTrashed && !e.isSpam)
      .reverse().sortBy('date')
    return applyInboxSplit(emails, activeSplit)
  }
  if (activeFolder === 'Starred') {
    return db.emails
      .where('accountId').equals(accountId)
      .filter(e => !!e.isStarred && !e.isTrashed && !e.isSpam)
      .reverse().sortBy('date')
  }
  if (activeFolder === 'Drafts') {
    return db.emails
      .where('accountId').equals(accountId)
      .filter(e => (!!e.isDraft || folderLooksLike(e.folder, 'draft')) && !e.isTrashed)
      .reverse().sortBy('date')
  }
  if (activeFolder === 'Trash') {
    return db.emails
      .where('accountId').equals(accountId)
      .filter(e => !!e.isTrashed || folderLooksLike(e.folder, 'trash') || folderLooksLike(e.folder, 'deleted'))
      .reverse().sortBy('date')
  }
  if (activeFolder === 'Spam') {
    return db.emails
      .where('accountId').equals(accountId)
      .filter(e => !!e.isSpam || folderLooksLike(e.folder, 'spam') || folderLooksLike(e.folder, 'junk'))
      .reverse().sortBy('date')
  }
  if (activeFolder === 'snoozed') {
    return db.emails
      .where('accountId').equals(accountId)
      .filter(e => (e.snoozedUntil ?? 0) > 0)
      .reverse().sortBy('date')
  }
  if (typeof activeFolder === 'object' && activeFolder.kind === 'label') {
    const labelId = activeFolder.id
    return db.emails
      .where('accountId').equals(accountId)
      .filter(e => e.labels.includes(labelId) && !e.isTrashed && !e.isSpam)
      .reverse().sortBy('date')
  }
  return db.emails
    .where('[accountId+folder]').equals([accountId, activeFolder as string])
    .reverse().sortBy('date')
}

function folderLooksLike(folder: string, token: string) {
  return folder.toLowerCase().includes(token)
}

export function splitMatchesEmail(email: Email, split: InboxSplitId): boolean {
  if (split === 'all') return true
  const classification = classifyInboxEmail(email)
  if (split === 'important') return classification === 'important'
  return classification === split
}

function applyInboxSplit(emails: Email[], split: InboxSplitId): Email[] {
  if (split === 'all') return emails
  return emails.filter(email => splitMatchesEmail(email, split))
}

function classifyInboxEmail(email: Email): Exclude<InboxSplitId, 'all'> {
  const hay = `${email.subject} ${email.from.name} ${email.from.address} ${email.snippet} ${email.bodyText}`.toLowerCase()
  const from = email.from.address.toLowerCase()
  const hasCalendarAttachment = email.attachments.some(att =>
    att.contentType?.toLowerCase().includes('calendar') ||
    att.filename?.toLowerCase().endsWith('.ics'),
  )
  if (
    hasCalendarAttachment ||
    /\b(invitation|invite|accepted|declined|tentative|rescheduled|calendar|meeting|calendly|zoom|google meet)\b/.test(hay)
  ) return 'calendar'

  if (
    /\b(newsletter|digest|roundup|weekly|daily briefing|unsubscribe|subscription|bulletin)\b/.test(hay) ||
    /\b(news|updates|digest|newsletter)\b/.test(from)
  ) return 'news'

  if (
    /\b(no-?reply|noreply|notification|notifications|alerts?|automated|mailer-daemon|do-not-reply)\b/.test(from) ||
    /\b(promotion|promo|sale|discount|receipt|invoice|statement|security alert|verify|verification|social|like|followed|commented)\b/.test(hay)
  ) return 'other'

  return 'important'
}

async function mergeServerEmails(serverEmails: Email[]): Promise<Email[]> {
  const ids = serverEmails.map(e => e.id)
  const localRows = await db.emails.bulkGet(ids)
  const localById = new Map<string, Email>()
  localRows.forEach(r => { if (r) localById.set(r.id, r) })
  return serverEmails.map(raw => {
    const prior = localById.get(raw.id)
    if (!prior) return raw
	    return {
	      ...raw,
      snippet: raw.snippet || prior.snippet,
      bodyHtml: raw.bodyHtml || prior.bodyHtml,
      bodyText: raw.bodyText || prior.bodyText,
      attachments: raw.attachments.length > 0 ? raw.attachments : prior.attachments,
	      labels: mergeKnownLabels(raw.labels, prior.labels),
      isArchived: prior.isArchived || raw.isArchived,
      isTrashed: prior.isTrashed || raw.isTrashed,
      isSpam: prior.isSpam || raw.isSpam,
      isMuted: prior.isMuted || raw.isMuted,
      snoozedUntil: prior.snoozedUntil ?? raw.snoozedUntil,
      isRead: raw.isRead || prior.isRead,
    }
  })
}

function mergeKnownLabels(...labelSets: (string[] | undefined)[]): string[] {
  const knownLabels = useLabelsStore.getState().labels
  const merged = Array.from(new Set(labelSets.flatMap(labels => labels ?? [])))
  if (knownLabels.length === 0) return merged
  const validIds = new Set(knownLabels.map(label => label.id))
  return merged.filter(id => validIds.has(id))
}

async function resolvePreloadFolders(accountId: string): Promise<MailFolderInfo[]> {
  let remote: MailFolderInfo[] = []
  try {
    remote = (await accountsApi.folders(accountId)).folders
  } catch (err) {
    console.error('[preload] folder discovery failed, falling back to system folders', err)
  }

  const byName = new Map<string, MailFolderInfo>()
  for (const name of SYSTEM_PRELOAD_FOLDERS) {
    byName.set(name.toLowerCase(), { name, path: name })
  }
  for (const folder of remote) {
    const normalized = normalizePreloadFolder(folder)
    if (!normalized) continue
    if (normalized.name.toLowerCase() === 'all mail') continue
    byName.set(normalized.name.toLowerCase(), normalized)
  }
  return [...byName.values()]
}

function normalizePreloadFolder(folder: MailFolderInfo): MailFolderInfo | null {
  const name = folder.name || folder.path
  const lower = name.toLowerCase()
  if (!name || lower.includes('[gmail]') && lower.endsWith('/all mail')) return null
  if (folder.role === 'inbox') return { ...folder, name: 'INBOX' }
  if (folder.role === 'sent') return { ...folder, name: 'Sent' }
  if (folder.role === 'drafts') return { ...folder, name: 'Drafts' }
  if (folder.role === 'trash') return { ...folder, name: 'Trash' }
  if (folder.role === 'spam') return { ...folder, name: 'Spam' }
  if (folder.role === 'starred') return { ...folder, name: 'Starred' }
  return { ...folder, name }
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useEmailStore = create<EmailStore>((set, get) => ({
  accounts:        [],
  activeAccountId: null,
  accountStates:   {},
	  syncProgress:    null,
	  syncStatus:      null,

  // ─── Account management ──────────────────────────────────────────────────

  setAccounts: (accounts) => {
    set(s => {
      // Seed per-account state for any new accounts
      const states = { ...s.accountStates }
      for (const a of accounts) {
        if (!states[a.id]) states[a.id] = defaultAccountState()
      }
      return {
        accounts,
        accountStates: states,
        activeAccountId: s.activeAccountId ?? accounts[0]?.id ?? null,
      }
    })
  },

  addAccount: (account) => {
    set(s => {
      const exists = s.accounts.find(a => a.id === account.id)
      if (exists) return {}
      return {
        accounts:      [...s.accounts, account],
        accountStates: { ...s.accountStates, [account.id]: defaultAccountState() },
        activeAccountId: s.activeAccountId ?? account.id,
      }
    })
  },

  removeAccount: async (id) => {
    await db.emails.where('accountId').equals(id).delete()
    set(s => {
      const accounts = s.accounts.filter(a => a.id !== id)
      const { [id]: _, ...states } = s.accountStates
      const activeId = s.activeAccountId === id
        ? (accounts[0]?.id ?? null)
        : s.activeAccountId
      return { accounts, accountStates: states, activeAccountId: activeId }
    })
  },

  setActiveAccount: (id) => {
    set(s => {
      if (!s.accountStates[id]) {
        return { activeAccountId: id, accountStates: { ...s.accountStates, [id]: defaultAccountState() } }
      }
      return { activeAccountId: id }
    })
    // Kick off a load if the account has no emails yet
    const state = get().accountStates[id]
    if (!state || state.emails.length === 0) get().loadEmails()
  },

  getActiveAccount: () => {
    const { accounts, activeAccountId } = get()
    return accounts.find(a => a.id === activeAccountId) ?? null
  },

  // ─── Folder / load ───────────────────────────────────────────────────────

	  setActiveFolder: (folder) => {
    set(s => ({ accountStates: patchAS(s, {
      activeFolder: folder,
      activeSplit: folder === 'INBOX' ? getAS(s).activeSplit : 'all',
      focusedIndex: 0,
      selectedId: null,
    }) }))
	    get().loadEmails()
	  },

  setActiveSplit: (split) => {
    const state = getAS(get())
    if (state.activeFolder !== 'INBOX') {
      set(s => ({ accountStates: patchAS(s, { activeFolder: 'INBOX', activeSplit: split, focusedIndex: 0, selectedId: null }) }))
    } else {
      set(s => ({ accountStates: patchAS(s, { activeSplit: split, focusedIndex: 0, selectedId: null }) }))
    }
    get().loadEmails()
  },

  focusNextSplit: () => {
    const state = getAS(get())
    const idx = INBOX_SPLITS.findIndex(split => split.id === state.activeSplit)
    const next = INBOX_SPLITS[Math.min(idx + 1, INBOX_SPLITS.length - 1)] ?? INBOX_SPLITS[0]
    if (next) get().setActiveSplit(next.id)
  },

  focusPrevSplit: () => {
    const state = getAS(get())
    const idx = INBOX_SPLITS.findIndex(split => split.id === state.activeSplit)
    const prev = INBOX_SPLITS[Math.max(idx - 1, 0)] ?? INBOX_SPLITS[0]
    if (prev) get().setActiveSplit(prev.id)
  },

	  loadEmails: async () => {
    const account = get().getActiveAccount()
    if (!account) return

	    const { activeFolder, activeSplit } = getAS(get())
    set(s => ({ accountStates: patchAS(s, { isLoading: true }) }))

    try {
      // 1. Serve from IndexedDB first (instant)
      let local: Email[] = []
      const aid = account.id
      await get().processLocalWorkflow()

		      local = await loadLocalEmails(aid, activeFolder, activeSplit)

	      set(s => ({ accountStates: patchAS(s, { emails: local, isLoading: false }) }))
	      buildIndex(local)

	      // 2. Background sync from server (non-recursive)
	      get().triggerSync()
    } catch (err) {
      console.error('loadEmails', err)
      set(s => ({ accountStates: patchAS(s, { isLoading: false }) }))
    }
  },

  triggerSync: async () => {
    const account = get().getActiveAccount()
    if (!account) return

    // Snapshot folder + account at sync start. If the user navigates away
    // before the IMAP fetch returns, we still write to Dexie but DON'T
    // overwrite the now-current view with stale results.
    const startState  = getAS(get())
    const startFolder = startState.activeFolder
    const startSplit  = startState.activeSplit
    const accountId   = account.id
    const fkey        = folderKey(startFolder)

    // Already syncing this folder for this account — skip duplicate.
    if (startState.isSyncing) return

    const fetchFolder =
      startFolder === 'snoozed'
        ? 'INBOX'
        : (typeof startFolder === 'object' ? 'INBOX' : (startFolder as string))

    const isFirstSync = !startState.hasSyncedOnce[fkey]
    const limit       = isFirstSync ? FIRST_SYNC_LIMIT : DELTA_SYNC_LIMIT

    set(s => ({ accountStates: patchAS(s, { isSyncing: true }) }))

    try {
      console.log(`[sync] ${accountId} ${fetchFolder} limit=${limit} firstSync=${isFirstSync}`)
      const serverEmailsRaw = await emailsApi.list(accountId, fetchFolder, limit)
      console.log(`[sync] ${accountId} ${fetchFolder} → ${serverEmailsRaw.length} emails`)

      // Mark this folder as having been synced so future hits use the
      // cheaper delta fetch.
      const markSynced = (s: AccountViewState): Partial<AccountViewState> => ({
        hasSyncedOnce: { ...s.hasSyncedOnce, [fkey]: true },
      })

      if (serverEmailsRaw.length === 0) {
        set(s => ({ accountStates: patchAS(s, { ...markSynced(getAS(s)), isSyncing: false }) }))
        return
      }

      // Auto-tag with custom labels via the rule engine
      const tag = useLabelsStore.getState().tagEmail

      // Preserve client-only state across syncs. The IMAP server doesn't know
      // about manually-applied labels, snooze, or local archive/trash state,
      // so a fresh server fetch would otherwise wipe them. Merge with the
      // local Dexie row (or the in-memory copy) before persisting.
      const ids = serverEmailsRaw.map(e => e.id)
      const localRows = await db.emails.bulkGet(ids)
      const localById = new Map<string, Email>()
      localRows.forEach(r => { if (r) localById.set(r.id, r) })

      const serverEmails = serverEmailsRaw.map(raw => {
        const tagged = tag(raw)
        const prior  = localById.get(raw.id)
        if (!prior) return tagged
	        return {
	          ...tagged,
          snippet: tagged.snippet || prior.snippet,
          bodyHtml: tagged.bodyHtml || prior.bodyHtml,
          bodyText: tagged.bodyText || prior.bodyText,
          attachments: tagged.attachments.length > 0 ? tagged.attachments : prior.attachments,
	          // Union of auto-tagged labels and any user-applied labels.
          // Filter to known local label ids so provider-native Gmail label ids
          // never render as orphan chips.
          labels: mergeKnownLabels(tagged.labels, prior.labels),
          // Sticky client-side flags (server fetch never resets them)
          isArchived:   prior.isArchived || tagged.isArchived,
          isTrashed:    prior.isTrashed  || tagged.isTrashed,
          isSpam:       prior.isSpam     || tagged.isSpam,
          isMuted:      prior.isMuted    || tagged.isMuted,
          snoozedUntil: prior.snoozedUntil ?? tagged.snoozedUntil,
          // Preserve client-side read state ONLY if user marked it locally
          // and server hasn't seen the change yet
          isRead:       tagged.isRead || prior.isRead,
        }
      })

      await db.emails.bulkPut(serverEmails)
      await upsertContactsFromEmails(serverEmails)
      serverEmails.forEach(addToIndex)
      invalidateContactCache()

      // Only update the visible emails array if the user is still on the
      // folder + account we synced. Otherwise just persist to Dexie and
      // let the next loadEmails pick it up.
      const nowState  = getAS(get())
      const sameFolder = JSON.stringify(nowState.activeFolder) === JSON.stringify(startFolder)
      const sameAccount = get().activeAccountId === accountId

      if (sameFolder && sameAccount) {
        const serverIds = new Set(serverEmails.map(s => s.id))
        let merged = [
          ...serverEmails,
          ...nowState.emails.filter(e => !serverIds.has(e.id)),
        ].sort((a, b) => b.date - a.date)

        // For "virtual" folders (custom labels, snoozed) the server fetch is
        // always INBOX — re-apply the view filter so the merge doesn't dump
        // the entire inbox into a label view.
        if (typeof startFolder === 'object' && startFolder.kind === 'label') {
          const labelId = startFolder.id
          merged = merged.filter(e => e.labels.includes(labelId) && !e.isTrashed && !e.isSpam)
        } else if (startFolder === 'snoozed') {
          merged = merged.filter(e => (e.snoozedUntil ?? 0) > 0)
        } else if (startFolder === 'Starred') {
          merged = merged.filter(e => !!e.isStarred && !e.isTrashed && !e.isSpam)
	        } else if (startFolder === 'INBOX') {
	          merged = merged.filter(e => !e.isArchived && !e.isTrashed && !e.isSpam)
          merged = merged.filter(e => splitMatchesEmail(e, startSplit))
	        }
        // Other folders (Sent, Drafts, Trash, Spam) match by `folder` field
        // already because we fetched from that folder; no extra filter needed.

        set(s => ({
          accountStates: patchAS(s, {
            emails:    merged,
            isLoading: false,
            isSyncing: false,
            hasSyncedOnce: { ...nowState.hasSyncedOnce, [fkey]: true },
          }),
        }))
      } else {
        set(s => ({ accountStates: patchAS(s, { isSyncing: false }) }))
      }
    } catch (err) {
      console.error('[sync] failed', err)
      set(s => ({ accountStates: patchAS(s, { isSyncing: false }) }))
    }
  },

  preloadAllMail: async (targetAccountId, mode = 'auto') => {
    const account = targetAccountId
      ? get().accounts.find(a => a.id === targetAccountId)
      : get().getActiveAccount()
    if (!account) return

    const metaKey = `${account.id}:preload`
    const meta = await db.syncMeta.get(metaKey)
    const hasLocalMail = await db.emails.where('accountId').equals(account.id).count()
    const resolvedMode = mode === 'auto'
      ? (meta?.status === 'ready' || hasLocalMail > 0 ? 'delta' : 'full')
      : mode

    set({ syncProgress: 1, syncStatus: resolvedMode === 'full' ? 'Preparing mailbox preload…' : 'Checking for new mail…' })
    await db.syncMeta.put({
      key: metaKey,
      accountId: account.id,
      status: 'preloading',
      totalFetched: meta?.totalFetched ?? 0,
      updatedAt: Date.now(),
    })

    try {
      const folderInfo = await resolvePreloadFolders(account.id)
      const folders = folderInfo.map(f => f.name)
      const tag = useLabelsStore.getState().tagEmail
      let totalFetched = 0

      for (let i = 0; i < folders.length; i++) {
        const folder = folders[i]
        const maxPages = resolvedMode === 'delta' ? 1 : Number.POSITIVE_INFINITY
        let offset = 0
        let page = 0
        let keepGoing = true

        while (keepGoing && page < maxPages) {
          set({
            syncStatus: `${resolvedMode === 'full' ? 'Preloading' : 'Syncing'} ${folder}…`,
            syncProgress: Math.max(2, Math.round(((i + Math.min(page, 1) / 2) / folders.length) * 100)),
          })

          const batch = await emailsApi.list(account.id, folder, PRELOAD_PAGE_SIZE, offset)
          if (batch.length === 0) break

          const merged = await mergeServerEmails(batch.map(tag))
          await db.emails.bulkPut(merged)
          await upsertContactsFromEmails(merged)
          merged.forEach(addToIndex)
          totalFetched += merged.length

          offset += PRELOAD_PAGE_SIZE
          page += 1
          keepGoing = batch.length === PRELOAD_PAGE_SIZE
        }

        await db.syncMeta.put({
          key: `${account.id}:${folder}`,
          accountId: account.id,
          folder,
          status: 'ready',
          totalFetched: offset,
          cursor: offset,
          updatedAt: Date.now(),
        })
      }

      await db.syncMeta.put({
        key: metaKey,
        accountId: account.id,
        status: 'ready',
        totalFetched: (meta?.totalFetched ?? 0) + totalFetched,
        updatedAt: Date.now(),
      })

      set({ syncProgress: 100, syncStatus: resolvedMode === 'full' ? 'Mailbox preload complete' : 'Mailbox sync complete' })
      if (get().activeAccountId === account.id) {
	        const state = getAS(get())
	        const local = await loadLocalEmails(account.id, state.activeFolder, state.activeSplit)
        set(s => ({ accountStates: patchAS(s, { emails: local, isLoading: false, isSyncing: false }) }))
      }
      window.setTimeout(() => {
        if (get().syncProgress === 100) set({ syncProgress: null, syncStatus: null })
      }, 2000)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await db.syncMeta.put({
        key: metaKey,
        accountId: account.id,
        status: 'error',
        totalFetched: meta?.totalFetched ?? 0,
        updatedAt: Date.now(),
        error: message,
      })
      set({ syncProgress: null, syncStatus: `Preload failed: ${message}` })
      useUiStore.getState().toast('Mailbox preload failed')
      console.error(err)
    }
  },

  processLocalWorkflow: async () => {
    const account = get().getActiveAccount()
    if (!account) return
    const surfaced = await resurfaceDueSnoozes(account.id)
    if (surfaced.length === 0) return
    const state = getAS(get())
    if (state.activeFolder !== 'INBOX') return
    const existing = new Set(state.emails.map(e => e.id))
    const merged = [
      ...surfaced.filter(e => !existing.has(e.id)),
      ...state.emails,
    ].filter(e => !e.isTrashed && !e.isSpam).sort((a, b) => b.date - a.date)
    set(s => ({ accountStates: patchAS(s, { emails: merged }) }))
  },

  loadMore: async () => {
    const account = get().getActiveAccount()
    if (!account) return 0
    const startState = getAS(get())
    if (startState.isSyncing) return 0

    const startFolder = startState.activeFolder
    const fetchFolder =
      startFolder === 'snoozed'
        ? 'INBOX'
        : (typeof startFolder === 'object' ? 'INBOX' : (startFolder as string))

    set(s => ({ accountStates: patchAS(s, { isSyncing: true }) }))
    try {
      const offset = startState.emails.length
      const more   = await emailsApi.list(account.id, fetchFolder, FIRST_SYNC_LIMIT, offset)
      console.log(`[loadMore] ${account.id} ${fetchFolder} offset=${offset} → ${more.length}`)
      if (more.length === 0) {
        set(s => ({ accountStates: patchAS(s, { isSyncing: false }) }))
        return 0
      }
      const tag = useLabelsStore.getState().tagEmail
      // Merge with local rows so loaded-older mail keeps any prior labels /
      // archive state we already wrote (same reasoning as triggerSync).
      const ids = more.map(e => e.id)
      const localRows = await db.emails.bulkGet(ids)
      const localById = new Map<string, Email>()
      localRows.forEach(r => { if (r) localById.set(r.id, r) })

      const tagged = more.map(raw => {
        const t = tag(raw)
        const prior = localById.get(raw.id)
        if (!prior) return t
	        return {
	          ...t,
          snippet: t.snippet || prior.snippet,
          bodyHtml: t.bodyHtml || prior.bodyHtml,
          bodyText: t.bodyText || prior.bodyText,
          attachments: t.attachments.length > 0 ? t.attachments : prior.attachments,
	          labels:       mergeKnownLabels(t.labels, prior.labels),
          isArchived:   prior.isArchived || t.isArchived,
          isTrashed:    prior.isTrashed  || t.isTrashed,
          isSpam:       prior.isSpam     || t.isSpam,
          isMuted:      prior.isMuted    || t.isMuted,
          snoozedUntil: prior.snoozedUntil ?? t.snoozedUntil,
          isRead:       t.isRead || prior.isRead,
        }
      })
      await db.emails.bulkPut(tagged)
      await upsertContactsFromEmails(tagged)
      tagged.forEach(addToIndex)

      const nowState   = getAS(get())
      const sameFolder = JSON.stringify(nowState.activeFolder) === JSON.stringify(startFolder)
      if (sameFolder) {
        const haveIds = new Set(nowState.emails.map(e => e.id))
        let fresh     = tagged.filter(e => !haveIds.has(e.id))

        // Apply the same view filter as triggerSync — load-more on a label
        // view shouldn't bring in unlabeled INBOX emails.
        if (typeof startFolder === 'object' && startFolder.kind === 'label') {
          const labelId = startFolder.id
          fresh = fresh.filter(e => e.labels.includes(labelId) && !e.isTrashed && !e.isSpam)
        } else if (startFolder === 'snoozed') {
          fresh = fresh.filter(e => (e.snoozedUntil ?? 0) > 0)
        } else if (startFolder === 'Starred') {
          fresh = fresh.filter(e => !!e.isStarred && !e.isTrashed && !e.isSpam)
	        } else if (startFolder === 'INBOX') {
	          fresh = fresh.filter(e => !e.isArchived && !e.isTrashed && !e.isSpam)
          fresh = fresh.filter(e => splitMatchesEmail(e, startState.activeSplit))
	        }

        const merged  = [...nowState.emails, ...fresh].sort((a, b) => b.date - a.date)
        set(s => ({ accountStates: patchAS(s, { emails: merged, isSyncing: false }) }))
        return fresh.length
      }
      set(s => ({ accountStates: patchAS(s, { isSyncing: false }) }))
      return 0
    } catch (err) {
      console.error('[loadMore] failed', err)
      set(s => ({ accountStates: patchAS(s, { isSyncing: false }) }))
      return 0
    }
  },

  // ─── Labels ──────────────────────────────────────────────────────────────

	  applyLabel: async (labelId, emailId) => {
    const { emails, selectedId, focusedIndex } = getAS(get())
    const targetId = emailId ?? selectedId ?? emails[focusedIndex]?.id
    const target = emails.find(e => e.id === targetId)
    if (!target || target.labels.includes(labelId)) return
    const nextLabels = [...target.labels, labelId]
    set(s => ({ accountStates: patchAS(s, {
      emails: emails.map(e => e.id === targetId ? { ...e, labels: nextLabels } : e),
	    }) }))
	    await db.emails.update(targetId!, { labels: nextLabels })
    await queueMailMutation({ accountId: target.accountId, type: 'label', ids: [targetId!], payload: { labels: nextLabels } })
	  },

  removeLabel: async (labelId, emailId) => {
    const { emails, selectedId, focusedIndex } = getAS(get())
    const targetId = emailId ?? selectedId ?? emails[focusedIndex]?.id
    const target = emails.find(e => e.id === targetId)
    if (!target || !target.labels.includes(labelId)) return
    const nextLabels = target.labels.filter(l => l !== labelId)
    set(s => ({ accountStates: patchAS(s, {
      emails: emails.map(e => e.id === targetId ? { ...e, labels: nextLabels } : e),
	    }) }))
	    await db.emails.update(targetId!, { labels: nextLabels })
    await queueMailMutation({ accountId: target.accountId, type: 'label', ids: [targetId!], payload: { labels: nextLabels } })
	  },

  // ─── Navigation ──────────────────────────────────────────────────────────

  selectEmail: (id) => {
    set(s => ({ accountStates: patchAS(s, { selectedId: id }) }))
  },

  focusIndex: (index) => {
    const { emails } = getAS(get())
    const clamped = Math.max(0, Math.min(index, emails.length - 1))
    const id      = emails[clamped]?.id ?? null
    set(s => ({ accountStates: patchAS(s, { focusedIndex: clamped, selectedId: id }) }))
  },

  focusNext: () => {
    const { focusedIndex, emails } = getAS(get())
    const next = Math.min(focusedIndex + 1, emails.length - 1)
    const id   = emails[next]?.id ?? null
    // Auto-select for instant preview. mark-as-read is gated by a dwell timer
    // applied by the EmailList consumer so rapid j/k scrolling doesn't burn
    // through unread state.
    set(s => ({ accountStates: patchAS(s, { focusedIndex: next, selectedId: id }) }))
  },

  focusPrev: () => {
    const { focusedIndex, emails } = getAS(get())
    const next = Math.max(0, focusedIndex - 1)
    const id   = emails[next]?.id ?? null
    set(s => ({ accountStates: patchAS(s, { focusedIndex: next, selectedId: id }) }))
  },

  openFocused: () => {
    // Selection now happens automatically on focus change, so Enter just
    // forces the focused row to be selected (idempotent in the common case)
    // and immediately marks it read — bypassing the read-dwell timer.
    const { emails, focusedIndex } = getAS(get())
    const email = emails[focusedIndex]
    if (!email) return
    if (email.isDraft || folderLooksLike(email.folder, 'draft')) {
      useUiStore.getState().openCompose({ draftId: email.id })
      return
    }
    set(s => ({ accountStates: patchAS(s, { selectedId: email.id }) }))
    if (!email.isRead) get().markRead(email.id, true)
  },

  // ─── Optimistic mutations ─────────────────────────────────────────────────

  archiveEmail: async (id) => {
    const { emails, selectedId, focusedIndex, pendingArchive } = getAS(get())
    const targetId = id ?? selectedId ?? emails[focusedIndex]?.id
    const target = emails.find(e => e.id === targetId)
    if (!target) return

    const pending = new Map(pendingArchive)
    pending.set(targetId!, target)
    const updated = emails.filter(e => e.id !== targetId)
    // Keep the cursor on the same row index — that means the email below
    // the archived one slides up into the focus position. Auto-select it
    // so the reading pane immediately shows the next email (Superhuman's
    // "keep moving" feel).
    const newIndex = Math.min(focusedIndex, updated.length - 1)
    const newSelectedId = updated[newIndex]?.id ?? null
    set(s => ({ accountStates: patchAS(s, {
      emails: updated,
      pendingArchive: pending,
      focusedIndex: newIndex,
      selectedId: newSelectedId,
    }) }))

	    await db.emails.update(targetId!, { isArchived: true })
	    try {
	      await emailsApi.archive([targetId!])
	    } catch (err) {
	      const nextPending = new Map(getAS(get()).pendingArchive)
	      nextPending.delete(targetId!)
      set(s => ({ accountStates: patchAS(s, { pendingArchive: nextPending }) }))
      await queueMailMutation({ accountId: target.accountId, type: 'archive', ids: [targetId!] })
	      useUiStore.getState().toast('Archive queued until the server is reachable')
	      console.error(err)
	    }
	  },

  deleteEmail: async (id) => {
    const { emails, selectedId, focusedIndex, pendingDelete } = getAS(get())
    const targetId = id ?? selectedId ?? emails[focusedIndex]?.id
    const target = emails.find(e => e.id === targetId)
    if (!target) return

    const pending = new Map(pendingDelete)
    pending.set(targetId!, target)
    const updated = emails.filter(e => e.id !== targetId)
    const newIndex = Math.min(focusedIndex, updated.length - 1)
    const newSelectedId = updated[newIndex]?.id ?? null
    set(s => ({ accountStates: patchAS(s, {
      emails: updated,
      pendingDelete: pending,
      focusedIndex: newIndex,
      selectedId: newSelectedId,
    }) }))

	    await db.emails.update(targetId!, { isTrashed: true })
	    try {
	      await emailsApi.trash([targetId!])
	    } catch (err) {
	      const nextPending = new Map(getAS(get()).pendingDelete)
	      nextPending.delete(targetId!)
      set(s => ({ accountStates: patchAS(s, { pendingDelete: nextPending }) }))
      await queueMailMutation({ accountId: target.accountId, type: 'trash', ids: [targetId!] })
	      useUiStore.getState().toast('Delete queued until the server is reachable')
	      console.error(err)
	    }
	  },

  restoreEmail: async (id) => {
    const { emails, selectedId, focusedIndex } = getAS(get())
    const targetId = id ?? selectedId ?? emails[focusedIndex]?.id
    const target = emails.find(e => e.id === targetId)
    if (!target) return

    const updated = emails.filter(e => e.id !== targetId)
    const newIndex = Math.min(focusedIndex, updated.length - 1)
    set(s => ({ accountStates: patchAS(s, {
      emails: updated,
      focusedIndex: newIndex,
      selectedId: updated[newIndex]?.id ?? null,
    }) }))

    await db.emails.update(targetId!, {
      folder: 'INBOX',
      isArchived: false,
      isTrashed: false,
      isSpam: false,
      snoozedUntil: undefined,
    })
    try {
      await emailsApi.restore([targetId!])
    } catch (err) {
      await queueMailMutation({ accountId: target.accountId, type: 'restore', ids: [targetId!] })
      useUiStore.getState().toast('Move to inbox queued until the server is reachable')
      console.error(err)
    }
  },

  undoLast: async () => {
    const { emails, pendingArchive, pendingDelete } = getAS(get())
    const [archiveEntry] = [...pendingArchive.entries()].slice(-1)
    const [deleteEntry]  = [...pendingDelete.entries()].slice(-1)

    if (archiveEntry) {
      const [id, email] = archiveEntry
      const newPending  = new Map(pendingArchive)
      newPending.delete(id)
      const updated = [{ ...email, isArchived: false }, ...emails].sort((a, b) => b.date - a.date)
	      set(s => ({ accountStates: patchAS(s, { emails: updated, pendingArchive: newPending }) }))
	      await db.emails.update(id, { isArchived: false })
      await cancelMailMutations([id], ['archive'])
	      try { await emailsApi.restore([id]) } catch (err) { await queueMailMutation({ accountId: email.accountId, type: 'restore', ids: [id] }); useUiStore.getState().toast('Undo queued until the server is reachable'); console.error(err) }
	    } else if (deleteEntry) {
      const [id, email] = deleteEntry
      const newPending  = new Map(pendingDelete)
      newPending.delete(id)
      const updated = [{ ...email, isTrashed: false }, ...emails].sort((a, b) => b.date - a.date)
	      set(s => ({ accountStates: patchAS(s, { emails: updated, pendingDelete: newPending }) }))
	      await db.emails.update(id, { isTrashed: false })
      await cancelMailMutations([id], ['trash'])
	      try { await emailsApi.restore([id]) } catch (err) { await queueMailMutation({ accountId: email.accountId, type: 'restore', ids: [id] }); useUiStore.getState().toast('Undo queued until the server is reachable'); console.error(err) }
	    }
	  },

  starEmail: async (id) => {
    const { emails, selectedId, focusedIndex } = getAS(get())
    const targetId = id ?? selectedId ?? emails[focusedIndex]?.id
    const target   = emails.find(e => e.id === targetId)
    if (!target) return
    const starred  = !target.isStarred
    set(s => ({ accountStates: patchAS(s, {
      emails: emails.map(e => e.id === targetId ? { ...e, isStarred: starred } : e),
    }) }))
    await db.emails.update(targetId!, { isStarred: starred })
	    try {
	      await emailsApi.star([targetId!], starred)
	    } catch (err) {
	      await queueMailMutation({ accountId: target.accountId, type: 'star', ids: [targetId!], payload: { starred } })
		      useUiStore.getState().toast('Star update queued until the server is reachable')
	      console.error(err)
	    }
	  },

  markRead: async (id, read) => {
    const { emails } = getAS(get())
    set(s => ({ accountStates: patchAS(s, {
      emails: emails.map(e => e.id === id ? { ...e, isRead: read } : e),
    }) }))
	    const target = emails.find(e => e.id === id)
	    await db.emails.update(id, { isRead: read })
    try {
      await emailsApi.markRead([id], read)
    } catch (err) {
		      if (target) await queueMailMutation({ accountId: target.accountId, type: 'markRead', ids: [id], payload: { read } })
	      useUiStore.getState().toast('Read state queued until the server is reachable')
	      console.error(err)
	    }
	  },

  markUnread: async (id) => {
    const { selectedId, focusedIndex, emails } = getAS(get())
    const targetId = id ?? selectedId ?? emails[focusedIndex]?.id
    if (targetId) await get().markRead(targetId, false)
  },

  markSpam: async (id) => {
    const { emails, selectedId, focusedIndex } = getAS(get())
    const targetId = id ?? selectedId ?? emails[focusedIndex]?.id
    if (!targetId) return
    const updated = emails.filter(e => e.id !== targetId)
    const newIndex = Math.min(focusedIndex, updated.length - 1)
    set(s => ({ accountStates: patchAS(s, {
      emails: updated,
      focusedIndex: newIndex,
      selectedId: updated[newIndex]?.id ?? null,
    }) }))
    const target = emails.find(e => e.id === targetId)
    await db.emails.update(targetId, { isSpam: true })
    try {
      await emailsApi.spam([targetId])
    } catch (err) {
	      if (target) {
        await queueMailMutation({ accountId: target.accountId, type: 'spam', ids: [targetId] })
	      }
	      useUiStore.getState().toast('Spam move queued until the server is reachable')
	      console.error(err)
	    }
	  },

  muteThread: async (id) => {
    const { emails, selectedId, focusedIndex } = getAS(get())
    const targetId = id ?? selectedId ?? emails[focusedIndex]?.id
    const target   = emails.find(e => e.id === targetId)
    if (!target) return
    const updated = emails.filter(e => e.threadId !== target.threadId)
    const newIndex = Math.min(focusedIndex, updated.length - 1)
    set(s => ({ accountStates: patchAS(s, {
      emails: updated,
      focusedIndex: newIndex,
      selectedId: updated[newIndex]?.id ?? null,
    }) }))
    await db.emails.where('threadId').equals(target.threadId).modify({ isMuted: true, isArchived: true })
	    try { await emailsApi.mute(target.threadId) } catch (err) { await queueMailMutation({ accountId: target.accountId, type: 'mute', ids: [targetId!], payload: { threadId: target.threadId } }); useUiStore.getState().toast('Mute queued until the server is reachable'); console.error(err) }
	  },

  snoozeEmail: async (id, until) => {
    const { emails, focusedIndex } = getAS(get())
    const updated = emails.filter(e => e.id !== id)
    const newIndex = Math.min(focusedIndex, updated.length - 1)
    set(s => ({ accountStates: patchAS(s, {
      emails: updated,
      focusedIndex: newIndex,
      selectedId: updated[newIndex]?.id ?? null,
    }) }))
    const target = emails.find(e => e.id === id)
    await db.emails.update(id, { snoozedUntil: until, isArchived: true })
	    try {
	      await emailsApi.snooze([id], until)
	    } catch (err) {
	      if (target) await queueMailMutation({ accountId: target.accountId, type: 'snooze', ids: [id], payload: { until } })
	      useUiStore.getState().toast('Snooze queued until the server is reachable')
	      console.error(err)
	    }
  },
}))

// ─── Selectors (read from active account) ────────────────────────────────────

export const selectActiveState = (s: EmailStore) => getAS(s)

export const selectFocusedEmail = (s: EmailStore): Email | null => {
  const as = getAS(s)
  return as.emails[as.focusedIndex] ?? null
}

export const selectSelectedEmail = (s: EmailStore): Email | null => {
  const as = getAS(s)
  return as.emails.find(e => e.id === as.selectedId) ?? null
}
