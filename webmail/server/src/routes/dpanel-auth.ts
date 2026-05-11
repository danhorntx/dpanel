import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import Imap from 'imap'
import { config } from '../lib/config.js'
import { seal, unseal, accountIdFor, type SessionPayload } from '../lib/session.js'
import { registerAccount, getAccount, removeAccount, type StoredAccount } from '../services/sync.js'
import { closeConnection } from '../services/imap.js'
import { clearTransport } from '../services/smtp.js'

export const SESSION_COOKIE = 'dp_webmail_session'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000  // 12 hours

// ─── IMAP login probe ─────────────────────────────────────────────────────────
// Open an IMAP connection with the user's credentials. On a successful LOGIN
// response Dovecot transitions to authenticated state and we know the password
// is good. We immediately close the probe; the real session connection opens
// lazily when the client fetches mail.

function probeImap(email: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = new Imap({
      user: email,
      password,
      host: config.imapHost,
      port: config.imapPort,
      tls: config.imapTls,
      // Dovecot on localhost presents a cert for mail.<domain>, not 127.0.0.1.
      // The user's password is the security boundary, not the loopback cert.
      tlsOptions: { rejectUnauthorized: !config.allowInsecureTls },
      authTimeout: 8_000,
      connTimeout: 8_000,
    })

    const cleanup = () => { try { probe.end() } catch { /* ignore */ } }

    probe.once('ready', () => { cleanup(); resolve() })
    probe.once('error', (err: Error) => { cleanup(); reject(err) })
    probe.connect()
  })
}

function buildAccount(session: SessionPayload): StoredAccount {
  return {
    id: session.accountId,
    provider: 'imap',
    name: session.name,
    email: session.email,
    username: session.username,
    password: session.password,
    imapHost: session.imapHost,
    imapPort: session.imapPort,
    imapTls: session.imapTls,
    smtpHost: session.smtpHost,
    smtpPort: session.smtpPort,
    smtpSecure: session.smtpSecure,
    isActive: true,
    lastSync: 0,
  }
}

// Decode the cookie if present and re-register the account in the in-memory
// store. Returns the account or null if no/invalid session.
export function hydrateSessionAccount(req: FastifyRequest): StoredAccount | null {
  const raw = (req.cookies as Record<string, string | undefined>)?.[SESSION_COOKIE]
  if (!raw) return null
  const session = unseal(raw)
  if (!session) return null
  if (Date.now() - session.issuedAt > SESSION_TTL_MS) return null

  // Refresh the in-memory account record if the server restarted since login.
  let account = getAccount(session.accountId)
  if (!account) {
    account = buildAccount(session)
    registerAccount(account)
  }
  return account
}

export async function dpanelAuthRoutes(app: FastifyInstance) {
  // ── Public config endpoint (always available so client can detect mode) ──
  app.get('/config/public', async () => ({
    mode: config.dpanelMode ? 'dpanel' : 'normal',
    gmailEnabled: !config.dpanelMode && !!config.googleOAuth.clientId,
  }))

  if (!config.dpanelMode) return

  // ── Login ────────────────────────────────────────────────────────────────
  app.post<{ Body: { email: string; password: string } }>('/auth/dpanel-login', async (req, reply) => {
    const email = (req.body?.email ?? '').trim().toLowerCase()
    const password = req.body?.password ?? ''
    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password are required' })
    }

    console.log(`[dpanel-login] attempt email=${email}`)

    try {
      await probeImap(email, password)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[dpanel-login] denied email=${email} err=${msg}`)
      // Don't echo back IMAP-level detail — keep it generic so we don't
      // help credential-stuffing tooling distinguish "no such user" from
      // "wrong password".
      return reply.status(401).send({ error: 'Invalid email or password' })
    }

    const accountId = accountIdFor(email)
    const session: SessionPayload = {
      accountId,
      email,
      name: email.split('@')[0],
      username: email,
      password,
      imapHost: config.imapHost,
      imapPort: config.imapPort,
      imapTls: config.imapTls,
      smtpHost: config.smtpHost,
      smtpPort: config.smtpPort,
      smtpSecure: config.smtpSecure,
      issuedAt: Date.now(),
    }

    const account = buildAccount(session)
    registerAccount(account)
    console.log(`[dpanel-login] ok email=${email} id=${accountId}`)

    const cookie = seal(session)
    return reply
      .setCookie(SESSION_COOKIE, cookie, {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.protocol === 'https',
        path: '/',
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
      })
      .send({
        id: account.id,
        provider: 'imap',
        name: account.name,
        email: account.email,
        imapHost: account.imapHost,
        imapPort: account.imapPort,
        imapTls: account.imapTls,
        smtpHost: account.smtpHost,
        smtpPort: account.smtpPort,
        smtpSecure: account.smtpSecure,
        username: account.username,
        isActive: true,
        syncState: { lastFullSync: 0, lastDeltaSync: 0, status: 'idle', progress: 100 },
      })
  })

  // ── Session check ────────────────────────────────────────────────────────
  app.get('/auth/dpanel-session', async (req, reply) => {
    const account = hydrateSessionAccount(req)
    if (!account) return reply.status(401).send({ error: 'No session' })
    return {
      id: account.id,
      provider: 'imap',
      name: account.name,
      email: account.email,
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      imapTls: account.imapTls,
      smtpHost: account.smtpHost,
      smtpPort: account.smtpPort,
      smtpSecure: account.smtpSecure,
      username: account.username,
      isActive: true,
      syncState: { lastFullSync: 0, lastDeltaSync: 0, status: 'idle', progress: 100 },
    }
  })

  // ── Logout ───────────────────────────────────────────────────────────────
  app.post('/auth/logout', async (req, reply) => {
    const account = hydrateSessionAccount(req)
    if (account) {
      closeConnection(account.id)
      clearTransport(account.id)
      removeAccount(account.id)
    }
    return reply
      .clearCookie(SESSION_COOKIE, { path: '/' })
      .send({ ok: true })
  })
}
