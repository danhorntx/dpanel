/**
 * dpanel-account.ts — Self-serve mailbox account management for DPanel-mode.
 *
 * Currently exposes:
 *   POST /api/account/change-password
 *
 * The duperhuman service runs as root on the DPanel host, so it can edit
 * /etc/dovecot/users directly. We deliberately do NOT call out to the
 * DPanel main API for this — keeping the path narrow avoids round-tripping
 * to another service and means a password change is a single transaction
 * inside this process.
 *
 * Subdomain-agnostic by construction: every webmail.<domain> Apache vhost
 * proxies /api/* to 127.0.0.1:3501 (this service). The session cookie
 * created at login is scoped to that subdomain and is sent automatically
 * on the change-password request — no cross-origin or CORS issues.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import Imap from 'imap'
import { config } from '../lib/config.js'
import { seal, unseal, type SessionPayload } from '../lib/session.js'
import { SESSION_COOKIE, hydrateSessionAccount } from './dpanel-auth.js'
import { registerAccount } from '../services/sync.js'

const USERS_FILE     = '/etc/dovecot/users'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000

// ── Helpers ────────────────────────────────────────────────────────────────

function probeImap(email: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = new Imap({
      user:        email,
      password,
      host:        config.imapHost,
      port:        config.imapPort,
      tls:         config.imapTls,
      tlsOptions:  { rejectUnauthorized: !config.allowInsecureTls },
      authTimeout: 8_000,
      connTimeout: 8_000,
    })
    const cleanup = () => { try { probe.end() } catch { /* ignore */ } }
    probe.once('ready', () => { cleanup(); resolve() })
    probe.once('error', (err: Error) => { cleanup(); reject(err) })
    probe.connect()
  })
}

/**
 * Hash a plaintext password using doveadm. SHA512-CRYPT matches what
 * lib/mail.js writes for accounts created via the DPanel admin UI, so
 * passwords stored here are inspection-compatible with the rest of the
 * stack (same format on the same line).
 *
 * The password is passed via stdin to avoid leaking it on the process
 * argument list (which is world-readable in /proc).
 */
function hashPassword(plaintext: string): string {
  const result = spawnSync('doveadm', ['pw', '-s', 'SHA512-CRYPT', '-p', plaintext], {
    encoding: 'utf8',
    timeout:  10_000,
  })
  if (result.status !== 0) {
    throw new Error(`doveadm pw failed: ${result.stderr || 'unknown error'}`)
  }
  return result.stdout.trim()
}

/**
 * Atomically rewrite the matching line in /etc/dovecot/users.
 *
 * Format: email:hash:uid:gid:gecos:home:shell:extra_fields
 *         ───── ───── ─────────────────────────────────────
 *         keep  swap  keep verbatim (quota_rule, etc.)
 *
 * We preserve everything after the hash so quota / uid override / gecos
 * stay exactly as the admin configured them.
 *
 * Returns true on success; throws if the email isn't found.
 */
function updateUsersFile(email: string, newHash: string): void {
  const raw   = readFileSync(USERS_FILE, 'utf8')
  const lines = raw.split('\n')
  let matched = false

  const updated = lines.map(line => {
    if (!line.startsWith(`${email}:`)) return line
    matched = true
    // Split into [email, hash, ...rest] keeping rest exact (preserves : in values).
    const firstColon  = line.indexOf(':')
    const secondColon = line.indexOf(':', firstColon + 1)
    if (firstColon === -1 || secondColon === -1) return line
    const tail = line.slice(secondColon)   // includes the leading ':'
    return `${email}:${newHash}${tail}`
  })

  if (!matched) {
    throw new Error(`No userdb entry for ${email}`)
  }

  // Atomic-ish: write to temp file, rename over.
  const tmp = `${USERS_FILE}.tmp.${process.pid}`
  writeFileSync(tmp, updated.join('\n'), { mode: 0o640 })
  renameSync(tmp, USERS_FILE)
  // Match Dovecot's expected ownership (root:dovecot 640 on Ubuntu).
  try { execFileSync('chown', ['root:dovecot', USERS_FILE]) } catch { /* not fatal */ }
}

function reloadDovecot(): void {
  // Reload is enough — userdb is re-read on each auth attempt anyway, but the
  // reload guarantees passdb caches (if configured) are dropped.
  const r = spawnSync('systemctl', ['reload', 'dovecot'], { encoding: 'utf8', timeout: 10_000 })
  if (r.status !== 0) throw new Error(`dovecot reload failed: ${r.stderr || 'unknown'}`)
}

// ── Route ──────────────────────────────────────────────────────────────────

export async function dpanelAccountRoutes(app: FastifyInstance) {
  if (!config.dpanelMode) return

  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>(
    '/account/change-password',
    async (req, reply) => {
      const account = hydrateSessionAccount(req)
      if (!account) return reply.status(401).send({ error: 'Not authenticated' })

      const currentPassword = (req.body?.currentPassword ?? '').toString()
      const newPassword     = (req.body?.newPassword     ?? '').toString()

      if (!currentPassword || !newPassword) {
        return reply.status(400).send({ error: 'Current and new password are required.' })
      }
      if (newPassword.length < 8) {
        return reply.status(400).send({ error: 'New password must be at least 8 characters.' })
      }
      if (newPassword === currentPassword) {
        return reply.status(400).send({ error: 'New password must differ from current.' })
      }

      // Verify the current password by probing Dovecot. This both confirms
      // the user knows their password AND that the userdb entry we're about
      // to rewrite is the right one (no stale session against a renamed
      // account, etc.).
      try {
        await probeImap(account.email, currentPassword)
      } catch (err) {
        console.warn(`[dpanel-account] change-password denied email=${account.email}: ${(err as Error).message}`)
        return reply.status(401).send({ error: 'Current password is incorrect.' })
      }

      // Hash + persist.
      let newHash: string
      try {
        newHash = hashPassword(newPassword)
      } catch (err) {
        console.error('[dpanel-account] hashPassword failed:', err)
        return reply.status(500).send({ error: 'Failed to hash new password.' })
      }

      try {
        updateUsersFile(account.email, newHash)
        reloadDovecot()
      } catch (err) {
        console.error('[dpanel-account] persist failed:', err)
        return reply.status(500).send({ error: 'Failed to apply new password. Please try again.' })
      }

      console.log(`[dpanel-account] password updated email=${account.email}`)

      // Re-seal the session cookie + refresh the in-memory account record
      // with the new password. Otherwise the existing IMAP connections
      // would die on next reauth and the user would be silently logged out
      // even though they just authenticated successfully.
      const refreshed: SessionPayload = {
        accountId:  account.id,
        email:      account.email,
        name:       account.name,
        username:   account.username,
        password:   newPassword,
        imapHost:   account.imapHost,
        imapPort:   account.imapPort,
        imapTls:    account.imapTls,
        smtpHost:   account.smtpHost,
        smtpPort:   account.smtpPort,
        smtpSecure: account.smtpSecure,
        issuedAt:   Date.now(),
      }
      registerAccount({ ...account, password: newPassword, lastSync: account.lastSync })

      const cookie = seal(refreshed)
      return reply
        .setCookie(SESSION_COOKIE, cookie, {
          httpOnly: true,
          sameSite: 'lax',
          secure:   req.protocol === 'https',
          path:     '/',
          maxAge:   Math.floor(SESSION_TTL_MS / 1000),
        })
        .send({ ok: true })
    },
  )
}

// Re-export so other modules don't need to know the internal helper names.
export { unseal }
