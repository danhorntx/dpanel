import { config } from '../lib/config.js'
import type { StoredAccount } from './sync.js'
import type { FetchedEmail } from './imap.js'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'

export interface GmailLabel {
  id: string
  name: string
  type?: string
}

interface GmailMessageList {
  messages?: { id: string; threadId: string }[]
  nextPageToken?: string
}

interface GmailDraftList {
  drafts?: { id: string; message?: { id: string; threadId: string } }[]
  nextPageToken?: string
}

interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  historyId?: string
  internalDate?: string
  payload?: GmailPart
}

interface GmailPart {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: { name: string; value: string }[]
  body?: { data?: string; size?: number; attachmentId?: string }
  parts?: GmailPart[]
}

export interface OAuthTokens {
  access_token: string
  expires_in: number
  refresh_token?: string
}

export async function exchangeCode(code: string): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    code,
    client_id: config.googleOAuth.clientId,
    client_secret: config.googleOAuth.clientSecret,
    redirect_uri: config.googleOAuth.redirectUri,
    grant_type: 'authorization_code',
  })
  const res = await fetch(TOKEN_URL, { method: 'POST', body })
  if (!res.ok) throw new Error(`Google token exchange failed: ${await res.text()}`)
  return res.json() as Promise<OAuthTokens>
}

export function loadPersistedGmailAccounts(): StoredAccount[] {
  try {
    const file = gmailAccountsFile()
    if (!fs.existsSync(file)) return []
    const encrypted = JSON.parse(fs.readFileSync(file, 'utf8')) as { iv: string; tag: string; data: string }
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(encrypted.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'))
    const plain = Buffer.concat([
      decipher.update(Buffer.from(encrypted.data, 'base64')),
      decipher.final(),
    ]).toString('utf8')
    return JSON.parse(plain) as StoredAccount[]
  } catch (err) {
    console.error('[gmail] failed to load persisted accounts', err)
    return []
  }
}

export function persistGmailAccount(account: StoredAccount) {
  const accounts = loadPersistedGmailAccounts().filter(a => a.id !== account.id)
  accounts.push({ ...account, gmailAccessToken: undefined, gmailAccessTokenExpiresAt: undefined })
  persistGmailAccounts(accounts)
}

export function removePersistedGmailAccount(id: string) {
  persistGmailAccounts(loadPersistedGmailAccounts().filter(a => a.id !== id))
}

export async function getGoogleUser(accessToken: string): Promise<{ email: string; name: string }> {
  const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new Error(`Google userinfo failed: ${await res.text()}`)
  const data = await res.json() as { email?: string; name?: string }
  if (!data.email) throw new Error('Google userinfo did not include an email address')
  return { email: data.email, name: data.name ?? data.email }
}

export async function getAccessToken(account: StoredAccount): Promise<string> {
  if (account.gmailAccessToken && account.gmailAccessTokenExpiresAt && account.gmailAccessTokenExpiresAt > Date.now() + 60_000) {
    return account.gmailAccessToken
  }
  if (!account.oauthRefreshToken) throw new Error('Gmail account is missing refresh token')
  const body = new URLSearchParams({
    client_id: config.googleOAuth.clientId,
    client_secret: config.googleOAuth.clientSecret,
    refresh_token: account.oauthRefreshToken,
    grant_type: 'refresh_token',
  })
  const res = await fetch(TOKEN_URL, { method: 'POST', body })
  if (!res.ok) throw new Error(`Google token refresh failed: ${await res.text()}`)
  const data = await res.json() as OAuthTokens
  account.gmailAccessToken = data.access_token
  account.gmailAccessTokenExpiresAt = Date.now() + data.expires_in * 1000
  return data.access_token
}

async function gmailFetch<T>(account: StoredAccount, path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken(account)
  const res = await fetch(`${GMAIL_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  if (!res.ok) throw new Error(`Gmail API ${path} failed: ${await res.text()}`)
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export async function listGmailLabels(account: StoredAccount): Promise<GmailLabel[]> {
  const data = await gmailFetch<{ labels?: GmailLabel[] }>(account, '/labels')
  return data.labels ?? []
}

export async function fetchGmailEmails(
  account: StoredAccount,
  folder = 'INBOX',
  limit = 100,
  offset = 0,
): Promise<(FetchedEmail & { gmailHistoryId?: string })[]> {
  const labelId = logicalToLabelId(folder)
  let pageToken: string | undefined
  let skipped = 0
  const ids: { id: string; threadId: string }[] = []

  while (ids.length < limit) {
    const maxResults = Math.min(500, Math.max(limit + offset - skipped, limit))
    const qs = new URLSearchParams({ maxResults: String(maxResults), includeSpamTrash: 'true' })
    if (labelId) qs.set('labelIds', labelId)
    if (!labelId && folder) qs.set('q', `label:"${folder.replace(/"/g, '\\"')}"`)
    if (pageToken) qs.set('pageToken', pageToken)
    const data = await gmailFetch<GmailMessageList>(account, `/messages?${qs}`)
    const batch = data.messages ?? []
    for (const m of batch) {
      if (skipped < offset) skipped += 1
      else if (ids.length < limit) ids.push(m)
    }
    pageToken = data.nextPageToken
    if (!pageToken || batch.length === 0) break
  }

  const messages: GmailMessage[] = []
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10)
    const got = await Promise.all(chunk.map(m => gmailFetch<GmailMessage>(account, `/messages/${m.id}?format=full`)))
    messages.push(...got)
  }

  return messages.map((m, index) => toEmail(account, m, folder, offset + index))
    .sort((a, b) => b.date - a.date)
}

export async function gmailSend(account: StoredAccount, opts: {
  to: { name?: string; address: string }[]
  cc?: { name?: string; address: string }[]
  bcc?: { name?: string; address: string }[]
  subject: string
  html: string
  text: string
}): Promise<string> {
  const raw = buildMime(account, opts)
  const data = await gmailFetch<{ id: string }>(account, '/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw }),
  })
  return data.id
}

export async function gmailSendDraft(account: StoredAccount, draftMessageId: string, opts: Parameters<typeof gmailSend>[1]): Promise<string> {
  const draftId = await findDraftIdByMessageId(account, draftMessageId)
  if (!draftId) return gmailSend(account, opts)

  const raw = buildMime(account, opts)
  await gmailFetch(account, `/drafts/${draftId}`, {
    method: 'PUT',
    body: JSON.stringify({ id: draftId, message: { raw } }),
  })

  const data = await gmailFetch<{ id: string }>(account, '/drafts/send', {
    method: 'POST',
    body: JSON.stringify({ id: draftId }),
  })
  return data.id
}

export async function gmailDeleteDraftByMessageId(account: StoredAccount, draftMessageId: string): Promise<boolean> {
  const draftId = await findDraftIdByMessageId(account, draftMessageId)
  if (!draftId) return false
  await gmailFetch(account, `/drafts/${draftId}`, { method: 'DELETE' })
  return true
}

export async function gmailModify(account: StoredAccount, ids: string[], addLabelIds: string[] = [], removeLabelIds: string[] = []) {
  await gmailFetch(account, '/messages/batchModify', {
    method: 'POST',
    body: JSON.stringify({ ids, addLabelIds, removeLabelIds }),
  })
}

async function findDraftIdByMessageId(account: StoredAccount, messageId: string): Promise<string | null> {
  let pageToken: string | undefined
  do {
    const qs = new URLSearchParams()
    if (pageToken) qs.set('pageToken', pageToken)
    const suffix = qs.toString() ? `?${qs}` : ''
    const data = await gmailFetch<GmailDraftList>(account, `/drafts${suffix}`)
    const match = (data.drafts ?? []).find(draft => draft.message?.id === messageId)
    if (match) return match.id
    pageToken = data.nextPageToken
  } while (pageToken)
  return null
}

export async function gmailTrash(account: StoredAccount, ids: string[]) {
  for (const id of ids) {
    await gmailFetch(account, `/messages/${id}/trash`, { method: 'POST', body: '{}' })
  }
}

export async function gmailUntrash(account: StoredAccount, ids: string[]) {
  for (const id of ids) {
    await gmailFetch(account, `/messages/${id}/untrash`, { method: 'POST', body: '{}' })
  }
}

export async function gmailHistory(account: StoredAccount, startHistoryId: string) {
  return gmailFetch<{ historyId?: string; history?: unknown[] }>(
    account,
    `/history?${new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded', labelId: 'INBOX' })}`,
  )
}

function toEmail(account: StoredAccount, m: GmailMessage, folder: string, index: number): FetchedEmail & { gmailHistoryId?: string; gmailMessageId: string } {
  const headers = new Map((m.payload?.headers ?? []).map(h => [h.name.toLowerCase(), h.value]))
  const labelIds = m.labelIds ?? []
  const bodyHtml = findBody(m.payload, 'text/html') ?? ''
  const bodyText = findBody(m.payload, 'text/plain') ?? stripHtml(bodyHtml)
  const from = parseOneAddress(headers.get('from') ?? '')
  const date = Number(m.internalDate ?? 0) || Date.parse(headers.get('date') ?? '') || Date.now()
  const attachments = collectAttachments(m.payload)
  const uid = stableUid(m.id, index)
  return {
    id: `${account.id}:${folder}:${uid}`,
    accountId: account.id,
    uid,
    folder,
    messageId: headers.get('message-id') ?? m.id,
    threadId: m.threadId,
    subject: headers.get('subject') ?? '(no subject)',
    from,
    to: parseAddressList(headers.get('to') ?? ''),
    cc: parseAddressList(headers.get('cc') ?? ''),
    bcc: parseAddressList(headers.get('bcc') ?? ''),
    date,
    receivedAt: date,
    snippet: m.snippet ?? bodyText.slice(0, 200).replace(/\s+/g, ' ').trim(),
    bodyHtml,
    bodyText,
    attachments,
    // Gmail label ids are provider-specific remote metadata, not Duperhuman
    // custom label ids. Keep them out of the local label array so the UI only
    // renders labels the user created and can edit/remove in the app.
    labels: [],
    flags: {
      seen: !labelIds.includes('UNREAD'),
      answered: false,
      flagged: labelIds.includes('STARRED'),
      deleted: labelIds.includes('TRASH'),
      draft: labelIds.includes('DRAFT'),
    },
    isRead: !labelIds.includes('UNREAD'),
    isStarred: labelIds.includes('STARRED'),
    isArchived: !labelIds.includes('INBOX') && !labelIds.includes('SENT') && !labelIds.includes('DRAFT') && !labelIds.includes('TRASH') && !labelIds.includes('SPAM'),
    isTrashed: labelIds.includes('TRASH'),
    isSpam: labelIds.includes('SPAM'),
    isMuted: false,
    isDraft: labelIds.includes('DRAFT'),
    snoozedUntil: undefined,
    scheduledSendAt: undefined,
    syncedAt: Date.now(),
    gmailHistoryId: m.historyId,
    gmailMessageId: m.id,
  }
}

function logicalToLabelId(folder: string): string | null {
  const map: Record<string, string> = {
    INBOX: 'INBOX',
    Sent: 'SENT',
    Drafts: 'DRAFT',
    Trash: 'TRASH',
    Spam: 'SPAM',
    Starred: 'STARRED',
  }
  return map[folder] ?? null
}

function findBody(part: GmailPart | undefined, mimeType: string): string | undefined {
  if (!part) return undefined
  if (part.mimeType === mimeType && part.body?.data) return decodeBase64Url(part.body.data)
  for (const child of part.parts ?? []) {
    const found = findBody(child, mimeType)
    if (found) return found
  }
  return undefined
}

function collectAttachments(part: GmailPart | undefined): { filename: string; contentType: string; size: number }[] {
  if (!part) return []
  const own = part.filename
    ? [{ filename: part.filename, contentType: part.mimeType ?? 'application/octet-stream', size: part.body?.size ?? 0 }]
    : []
  return [...own, ...(part.parts ?? []).flatMap(collectAttachments)]
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

function parseAddressList(value: string) {
  if (!value) return []
  return value.split(',').map(parseOneAddress)
}

function parseOneAddress(value: string) {
  const m = value.match(/^(.*?)<([^>]+)>$/)
  if (m) return { name: m[1].trim().replace(/^"|"$/g, ''), address: m[2].trim() }
  return { name: '', address: value.trim() }
}

function stripHtml(html: string) {
  return html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function stableUid(id: string, fallback: number) {
  const n = Number.parseInt(id.slice(-12), 16)
  return Number.isSafeInteger(n) ? n : fallback + 1
}

function isSystemLabel(label: string) {
  return ['INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM', 'STARRED', 'UNREAD', 'IMPORTANT', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'].includes(label)
}

function buildMime(account: StoredAccount, opts: Parameters<typeof gmailSend>[1]) {
  const boundary = `duperhuman-${Date.now()}`
  const recipients = (items?: { name?: string; address: string }[]) => (items ?? []).map(a => a.name ? `"${a.name}" <${a.address}>` : a.address).join(', ')
  const lines = [
    `From: "${account.name}" <${account.email}>`,
    `To: ${recipients(opts.to)}`,
    opts.cc?.length ? `Cc: ${recipients(opts.cc)}` : '',
    opts.bcc?.length ? `Bcc: ${recipients(opts.bcc)}` : '',
    `Subject: ${opts.subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    opts.text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    '',
    opts.html,
    '',
    `--${boundary}--`,
  ].filter(Boolean).join('\r\n')
  return Buffer.from(lines).toString('base64url')
}

function gmailAccountsFile() {
  return path.join(config.userDataDir, 'gmail-accounts.enc.json')
}

function encryptionKey() {
  return crypto.createHash('sha256').update(config.sessionSecret).digest()
}

function persistGmailAccounts(accounts: StoredAccount[]) {
  fs.mkdirSync(config.userDataDir, { recursive: true })
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const data = Buffer.concat([
    cipher.update(JSON.stringify(accounts), 'utf8'),
    cipher.final(),
  ])
  const payload = {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
  fs.writeFileSync(gmailAccountsFile(), JSON.stringify(payload), 'utf8')
}
