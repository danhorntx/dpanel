import Imap from 'imap'
import { simpleParser } from 'mailparser'
import type { ParsedMail } from 'mailparser'
import crypto from 'crypto'
import { config } from '../lib/config.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ImapAccount {
  id: string
  email: string
  username: string
  password: string
  imapHost: string
  imapPort: number
  imapTls: boolean
}

export interface FetchedEmail {
  id: string
  accountId: string
  uid: number
  folder: string
  messageId: string
  threadId: string
  subject: string
  from: { name: string; address: string }
  to: { name: string; address: string }[]
  cc: { name: string; address: string }[]
  bcc: { name: string; address: string }[]
  date: number
  receivedAt: number
  snippet: string
  bodyHtml: string
  bodyText: string
  attachments: { filename: string; contentType: string; size: number }[]
  labels: string[]
  flags: { seen: boolean; answered: boolean; flagged: boolean; deleted: boolean; draft: boolean }
  isRead: boolean
  isStarred: boolean
  isArchived: boolean
  isTrashed: boolean
  isSpam: boolean
  isMuted: boolean
  isDraft: boolean
  snoozedUntil: number | undefined
  scheduledSendAt: number | undefined
  syncedAt: number
}

// ─── Connection pool ──────────────────────────────────────────────────────────

const connections = new Map<string, Imap>()

function getConnection(account: ImapAccount): Promise<Imap> {
  return new Promise((resolve, reject) => {
    const existing = connections.get(account.id)
    if (existing && (existing.state === 'authenticated' || existing.state === 'selected')) {
      return resolve(existing)
    }

    const imap = new Imap({
      user: account.username,
      password: account.password,
      host: account.imapHost,
      port: account.imapPort,
      tls: account.imapTls,
      tlsOptions: { rejectUnauthorized: !config.allowInsecureTls },
      keepalive: { interval: 10000, idleInterval: 300000, forceNoop: true },
    })

    imap.once('ready', () => { connections.set(account.id, imap); resolve(imap) })
    imap.once('error', (err: Error) => { connections.delete(account.id); reject(err) })
    imap.once('end', () => connections.delete(account.id))
    imap.connect()
  })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deriveThreadId(parsed: ParsedMail): string {
  const refs = parsed.references as string[] | undefined
  if (refs && refs.length > 0) return refs[0].replace(/[<>]/g, '')
  const inReplyTo = parsed.inReplyTo as string | undefined
  if (inReplyTo) return inReplyTo.replace(/[<>]/g, '')
  const msgId = (parsed.messageId as string | undefined) ?? ''
  return msgId.replace(/[<>]/g, '') || crypto.randomBytes(8).toString('hex')
}

type MailAddr = import('mailparser').AddressObject | undefined
type ImapWithLabels = Imap & {
  addLabels: (uids: number[], labels: string[], cb: (err?: Error) => void) => void
  delLabels: (uids: number[], labels: string[], cb: (err?: Error) => void) => void
}

function parseAddress(addr: MailAddr): { name: string; address: string }[] {
  if (!addr) return []
  return (addr.value ?? []).map(a => ({ name: a.name ?? '', address: a.address ?? '' }))
}

type FetchMode = 'headers' | 'full'

function toFetchedEmail(raw: Buffer, flags: string[], uid: number, accountId: string, folder: string, mode: FetchMode): Promise<FetchedEmail | null> {
  return simpleParser(raw)
    .then(parsed => {
      const flagsObj = {
        seen:     flags.includes('\\Seen'),
        answered: flags.includes('\\Answered'),
        flagged:  flags.includes('\\Flagged'),
        deleted:  flags.includes('\\Deleted'),
        draft:    flags.includes('\\Draft'),
      }
      const fromAddrs = parseAddress(parsed.from as MailAddr)
      const from = fromAddrs[0] ?? { name: '', address: '' }
      const bodyText = mode === 'full' ? (parsed.text ?? '') : ''
      const snippet = bodyText
        ? bodyText.slice(0, 200).replace(/\s+/g, ' ').trim()
        : ''
      const emailId = `${accountId}:${folder}:${uid}`

      return {
        id: emailId,
        accountId,
        uid,
        folder,
        messageId: (parsed.messageId as string | undefined) ?? emailId,
        threadId: deriveThreadId(parsed),
        subject: parsed.subject ?? '(no subject)',
        from,
        to: parseAddress(parsed.to as MailAddr),
        cc: parseAddress(parsed.cc as MailAddr),
        bcc: parseAddress(parsed.bcc as MailAddr),
        date: parsed.date?.getTime() ?? Date.now(),
        receivedAt: Date.now(),
        snippet,
        bodyHtml: mode === 'full' && typeof parsed.html === 'string' ? parsed.html : '',
        bodyText,
        attachments: mode === 'full'
          ? (parsed.attachments ?? []).map(a => ({
              filename: a.filename ?? 'attachment',
              contentType: a.contentType,
              size: a.size,
            }))
          : [],
        labels: [],
        flags: flagsObj,
        isRead:     flagsObj.seen,
        isStarred:  flagsObj.flagged,
        isArchived: false,
        isTrashed:  folder.toLowerCase().includes('trash'),
        isSpam:     folder.toLowerCase().includes('spam'),
        isMuted:    false,
        isDraft:    flagsObj.draft || folder.toLowerCase().includes('draft'),
        snoozedUntil:    undefined,
        scheduledSendAt: undefined,
        syncedAt: Date.now(),
      }
    })
    .catch(err => {
      console.error(`Parse error uid=${uid}:`, err)
      return null
    })
}

// ─── Fetch a batch of messages. List views use headers only; body fetch is lazy.

function fetchRange(imap: Imap, seqRange: string, accountId: string, folder: string, mode: FetchMode): Promise<FetchedEmail[]> {
  return new Promise((resolve, reject) => {
    const results: Map<number, { raw: Buffer; flags: string[]; uid: number }> = new Map()

    const fetcher = imap.seq.fetch(seqRange, {
      bodies: mode === 'full'
        ? ''
        : 'HEADER.FIELDS (FROM TO CC BCC SUBJECT DATE MESSAGE-ID REFERENCES IN-REPLY-TO)',
      markSeen: false,
      struct: false,
    })

    fetcher.on('message', (msg, seqno) => {
      const chunks: Buffer[] = []
      let flags: string[] = []
      let uid = seqno

      msg.on('body', (stream) => {
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      })
      msg.once('attributes', (attrs) => {
        uid = attrs.uid ?? seqno
        flags = attrs.flags ?? []
      })
      msg.once('end', () => {
        results.set(uid, { raw: Buffer.concat(chunks), flags, uid })
      })
    })

    fetcher.once('error', reject)
	    fetcher.once('end', async () => {
	      const emails = (await Promise.all(
          [...results.values()].map(({ raw, flags, uid }) => toFetchedEmail(raw, flags, uid, accountId, folder, mode)),
        )).filter((email): email is FetchedEmail => !!email)

	      resolve(emails.sort((a, b) => b.date - a.date))
	    })
  })
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function fetchEmails(
  account: ImapAccount,
  folder = 'INBOX',
  limit = 100,
  offset = 0,
  fetchBodies = false,
): Promise<FetchedEmail[]> {
  const imap = await getConnection(account)

  return new Promise((resolve, reject) => {
    imap.openBox(folder, true, async (err, box) => {
      if (err) return reject(err)
      const total = box.messages.total
      if (total === 0) return resolve([])

      const end = Math.max(1, total - offset)
      const start = Math.max(1, end - limit + 1)
      const range = `${start}:${end}`

      try {
	        const emails = await fetchRange(imap, range, account.id, folder, fetchBodies ? 'full' : 'headers')
	        resolve(emails)
      } catch (fetchErr) {
        reject(fetchErr)
      }
    })
  })
}

export async function addFlags(account: ImapAccount, folder: string, uids: number[], flags: string[]): Promise<void> {
  const imap = await getConnection(account)
  return new Promise((resolve, reject) => {
    imap.openBox(folder, false, (err) => {
      if (err) return reject(err)
      imap.addFlags(uids, flags, e => e ? reject(e) : resolve())
    })
  })
}

export async function setLabels(account: ImapAccount, folder: string, uids: number[], labels: string[]): Promise<void> {
  const imap = await getConnection(account)
  return new Promise((resolve, reject) => {
    imap.openBox(folder, false, (err) => {
      if (err) return reject(err)
      ;(imap as ImapWithLabels).addLabels(uids, labels, (e?: Error) => e ? reject(e) : resolve())
    })
  })
}

export async function removeLabels(account: ImapAccount, folder: string, uids: number[], labels: string[]): Promise<void> {
  const imap = await getConnection(account)
  return new Promise((resolve, reject) => {
    imap.openBox(folder, false, (err) => {
      if (err) return reject(err)
      ;(imap as ImapWithLabels).delLabels(uids, labels, (e?: Error) => e ? reject(e) : resolve())
    })
  })
}

export async function removeFlags(account: ImapAccount, folder: string, uids: number[], flags: string[]): Promise<void> {
  const imap = await getConnection(account)
  return new Promise((resolve, reject) => {
    imap.openBox(folder, false, (err) => {
      if (err) return reject(err)
      imap.delFlags(uids, flags, e => e ? reject(e) : resolve())
    })
  })
}

export async function moveMessages(account: ImapAccount, src: string, uids: number[], dest: string): Promise<void> {
  const imap = await getConnection(account)
  return new Promise((resolve, reject) => {
    imap.openBox(src, false, (err) => {
      if (err) return reject(err)
      imap.move(uids, dest, e => e ? reject(e) : resolve())
    })
  })
}

export async function listFolders(account: ImapAccount): Promise<string[]> {
  const imap = await getConnection(account)
  return new Promise((resolve, reject) => {
    imap.getBoxes((err, boxes) => {
      if (err) return reject(err)
      const folders: string[] = []
      const walk = (obj: Imap.MailBoxes, prefix = '') => {
        for (const [name, box] of Object.entries(obj)) {
          const full = prefix ? `${prefix}${box.delimiter ?? '/'}${name}` : name
          folders.push(full)
          if (box.children) walk(box.children, full)
        }
      }
      walk(boxes)
      resolve(folders)
    })
  })
}

export function closeConnection(accountId: string) {
  const conn = connections.get(accountId)
  if (conn) { conn.end(); connections.delete(accountId) }
}

export async function fetchEmailByUid(
  account: ImapAccount,
  folder: string,
  uid: number,
): Promise<FetchedEmail | null> {
  const imap = await getConnection(account)

  return new Promise((resolve, reject) => {
    imap.openBox(folder, true, (err) => {
      if (err) return reject(err)
      const fetcher = imap.fetch(String(uid), { bodies: '', markSeen: false })
      const chunks: Buffer[] = []
      let flags: string[] = []

      fetcher.on('message', (msg) => {
        msg.on('body', (stream) => {
          stream.on('data', (c: Buffer) => chunks.push(c))
        })
        msg.once('attributes', attrs => {
          flags = attrs.flags ?? []
        })
      })
      fetcher.once('error', reject)
      fetcher.once('end', async () => {
        if (chunks.length === 0) return resolve(null)
        const email = await toFetchedEmail(Buffer.concat(chunks), flags, uid, account.id, folder, 'full')
        resolve(email)
      })
    })
  })
}

// ─── Single-message fetch (for attachment downloads / previews) ──────────────

export interface FetchedAttachmentBlob {
  filename:    string
  contentType: string
  size:        number
  content:     Buffer
}

/**
 * Fetch one full RFC822 message by UID and parse out a single attachment by
 * its index in the parsed `attachments` array. Returns null if the message
 * or attachment can't be found. Used by the /attachments/:index route to
 * stream the binary back to the renderer on demand.
 */
export async function fetchAttachmentByUid(
  account: ImapAccount,
  folder: string,
  uid: number,
  index: number,
): Promise<FetchedAttachmentBlob | null> {
  const imap = await getConnection(account)

  return new Promise((resolve, reject) => {
    imap.openBox(folder, true, (err) => {
      if (err) return reject(err)
      // imap.fetch (no .seq) uses UID
      const fetcher = imap.fetch(String(uid), { bodies: '', markSeen: false })
      const chunks: Buffer[] = []

      fetcher.on('message', (msg) => {
        msg.on('body', (stream) => {
          stream.on('data', (c: Buffer) => chunks.push(c))
        })
      })
      fetcher.once('error', reject)
      fetcher.once('end', async () => {
        try {
          if (chunks.length === 0) return resolve(null)
          const parsed = await simpleParser(Buffer.concat(chunks))
          const att = (parsed.attachments ?? [])[index]
          if (!att) return resolve(null)
          resolve({
            filename:    att.filename ?? `attachment-${index}`,
            contentType: att.contentType ?? 'application/octet-stream',
            size:        att.size ?? att.content?.length ?? 0,
            content:     att.content as Buffer,
          })
        } catch (e) { reject(e) }
      })
    })
  })
}
