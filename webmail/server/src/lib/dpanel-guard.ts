import type { FastifyRequest, FastifyReply } from 'fastify'
import { hydrateSessionAccount } from '../routes/dpanel-auth.js'
import type { StoredAccount } from '../services/sync.js'

const PROTECTED_PREFIXES = ['/api/accounts', '/api/emails', '/api/search', '/api/sync', '/api/account']

// Some routes must remain reachable without a session.
const ALLOWLIST = new Set<string>([])

function rewriteEmailId(emailId: string, sessionAccountId: string): string {
  // Email ids are shaped `accountId:folder:uid`. Replace the accountId prefix
  // so a forged id in the URL can't reach another user's cached/in-memory data.
  const parts = emailId.split(':')
  if (parts.length < 3) return emailId
  parts[0] = sessionAccountId
  return parts.join(':')
}

export async function dpanelSessionGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const url = req.url
  const path = url.split('?')[0]

  if (!PROTECTED_PREFIXES.some(p => path.startsWith(p))) return
  if (ALLOWLIST.has(path)) return

  const account = hydrateSessionAccount(req)
  if (!account) {
    reply.status(401).send({ error: 'Not signed in' })
    return
  }
  ;(req as FastifyRequest & { account?: StoredAccount }).account = account

  // ── Normalize the accountId in every place the routes might read it ────────
  // The user only ever has access to their own session account. Any forged
  // accountId in query/body/params is silently rewritten so the existing
  // route handlers stay correct without per-route patches.

  const q = req.query as Record<string, string> | undefined
  if (q && typeof q === 'object' && 'accountId' in q) {
    q.accountId = account.id
  }

  const b = req.body as Record<string, unknown> | undefined
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    if ('accountId' in b) (b as { accountId: string }).accountId = account.id
    const ids = (b as { ids?: unknown }).ids
    if (Array.isArray(ids)) {
      (b as { ids: string[] }).ids = ids.map(id =>
        typeof id === 'string' ? rewriteEmailId(id, account.id) : (id as unknown as string)
      )
    }
  }

  const p = req.params as Record<string, string> | undefined
  if (p && typeof p === 'object' && p.id) {
    if (path.startsWith('/api/accounts/')) {
      // /accounts/:id — :id is an account id; force to session's.
      p.id = account.id
    } else if (path.startsWith('/api/emails/')) {
      // /emails/:id (and /emails/:id/attachments/:index) — :id is an email
      // id whose first segment is the account id.
      p.id = rewriteEmailId(p.id, account.id)
    }
  }
}
