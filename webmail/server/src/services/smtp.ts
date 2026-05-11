import nodemailer from 'nodemailer'
import type Mail from 'nodemailer/lib/mailer/index.js'
import SMTPTransport from 'nodemailer/lib/smtp-transport/index.js'
import { config } from '../lib/config.js'
import { gmailSend } from './gmail.js'

export interface SmtpAccount {
  id: string
  provider?: 'imap' | 'gmail'
  name: string
  email: string
  username: string
  password: string
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
}

export interface SendOptions {
  to: { name?: string; address: string }[]
  cc?: { name?: string; address: string }[]
  bcc?: { name?: string; address: string }[]
  subject: string
  html: string
  text: string
  replyTo?: string
  inReplyTo?: string
  references?: string[]
}

const transportCache = new Map<string, nodemailer.Transporter>()

// Hard ceilings. Without these, nodemailer falls back to its 2-minute
// connection timeout and 10-minute socket timeout — long enough that the
// renderer's "Connecting..." spinner appears to hang forever when Gmail
// throttles the second login attempt from the same IP.
const SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout:    8_000,
  socketTimeout:     15_000,
}

// Defense in depth: even if nodemailer's own timeouts get ignored (it has
// happened — see node-mailer #1297), enforce one at the verify() layer.
const VERIFY_HARD_TIMEOUT_MS = 20_000

function getTransport(account: SmtpAccount): nodemailer.Transporter {
  const key = account.id
  const cached = transportCache.get(key)
  if (cached) return cached

  const options: SMTPTransport.Options = {
    host:    account.smtpHost,
    port:    account.smtpPort,
    secure:  account.smtpSecure,
    auth:    { user: account.username, pass: account.password },
    tls:     { rejectUnauthorized: !config.allowInsecureTls },
    ...SMTP_TIMEOUTS,
  }
  const transport = nodemailer.createTransport(options)

  transportCache.set(key, transport)
  return transport
}

export async function sendEmail(account: SmtpAccount, opts: SendOptions): Promise<string> {
  if (account.provider === 'gmail') {
    return gmailSend(account as Parameters<typeof gmailSend>[0], opts)
  }
  const transport = getTransport(account)

  const mailOptions: Mail.Options = {
    from: `"${account.name}" <${account.email}>`,
    to:   opts.to.map(a  => (a.name ? `"${a.name}" <${a.address}>` : a.address)),
    cc:   opts.cc?.map(a => (a.name ? `"${a.name}" <${a.address}>` : a.address)),
    bcc:  opts.bcc?.map(a => (a.name ? `"${a.name}" <${a.address}>` : a.address)),
    subject: opts.subject,
    html:    opts.html,
    text:    opts.text,
    replyTo:  opts.replyTo,
    inReplyTo: opts.inReplyTo,
    references: opts.references,
  }

  const info = await transport.sendMail(mailOptions)
  return info.messageId
}

/**
 * Verify SMTP credentials. Always resolves or rejects within
 * VERIFY_HARD_TIMEOUT_MS — never hangs, regardless of nodemailer behaviour.
 *
 * On failure, evicts the transport from the cache so a subsequent retry
 * doesn't reuse a half-dead connection.
 */
export async function verifySmtp(account: SmtpAccount): Promise<boolean> {
  const t0 = Date.now()
  console.log(`[smtp.verify] start id=${account.id} host=${account.smtpHost} user=${account.username}`)

  const transport = getTransport(account)

  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`SMTP verify timed out after ${VERIFY_HARD_TIMEOUT_MS}ms (host=${account.smtpHost})`))
    }, VERIFY_HARD_TIMEOUT_MS)
  })

  try {
    await Promise.race([transport.verify(), timeoutPromise])
    console.log(`[smtp.verify] ok id=${account.id} took=${Date.now() - t0}ms`)
    return true
  } catch (err) {
    console.error(`[smtp.verify] failed id=${account.id} took=${Date.now() - t0}ms err=${(err as Error).message}`)
    // Evict so the next attempt builds a fresh transport — a cached transport
    // whose underlying socket is in a bad state will keep failing.
    clearTransport(account.id)
    try { transport.close() } catch { /* ignore */ }
    throw err
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function clearTransport(accountId: string) {
  const t = transportCache.get(accountId)
  if (t) {
    try { t.close() } catch { /* ignore */ }
    transportCache.delete(accountId)
  }
}
