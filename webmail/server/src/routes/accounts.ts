import type { FastifyInstance, FastifyRequest } from 'fastify'
import { registerAccount, getAccount, listAccounts, removeAccount, logicalFolderName, type StoredAccount } from '../services/sync.js'
import { verifySmtp, clearTransport } from '../services/smtp.js'
import { listFolders, closeConnection } from '../services/imap.js'
import { exchangeCode, getGoogleUser, listGmailLabels, persistGmailAccount, removePersistedGmailAccount } from '../services/gmail.js'
import { config } from '../lib/config.js'
import crypto from 'crypto'

// Belt-and-suspenders. Even if verifySmtp's own 20s timeout misbehaves,
// the route still resolves within 25s so the renderer is never stuck.
const ROUTE_HARD_TIMEOUT_MS = 25_000
const GOOGLE_OAUTH_STATE_TTL_MS = 10 * 60_000
const googleOAuthStates = new Set<string>()
const GOOGLE_GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
]

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => { if (timer) clearTimeout(timer) }) as Promise<T>
}

function redactedAccount(account: StoredAccount) {
  return {
    id: account.id,
    provider: account.provider ?? 'imap',
    name: account.name,
    email: account.email,
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    imapTls: account.imapTls,
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    smtpSecure: account.smtpSecure,
    username: account.username,
    gmailHistoryId: account.gmailHistoryId,
    isActive: account.isActive,
    syncState: {
      lastFullSync: account.lastSync,
      lastDeltaSync: account.lastSync,
      status: 'idle',
      progress: 100,
    },
  }
}

function googleOAuthStatus() {
  const missing: string[] = []
  if (!config.googleOAuth.clientId) missing.push('GOOGLE_CLIENT_ID')
  if (!config.googleOAuth.clientSecret) missing.push('GOOGLE_CLIENT_SECRET')
  return {
    configured: missing.length === 0,
    missing,
    redirectUri: config.googleOAuth.redirectUri,
    scopes: GOOGLE_GMAIL_SCOPES,
  }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export async function accountRoutes(app: FastifyInstance) {
  // List accounts (passwords redacted). In DPanel mode the global store holds
  // every signed-in user's account; restrict the response to just the caller's.
  app.get('/accounts', async (req) => {
    if (config.dpanelMode) {
      const account = (req as FastifyRequest & { account?: StoredAccount }).account
      return account ? [redactedAccount(account)] : []
    }
    return listAccounts().map(redactedAccount)
  })

  // Add account
  app.post<{
	    Body: {
	      id?: string; name: string; email: string; password?: string
	      provider?: 'imap' | 'gmail'
	      oauthRefreshToken?: string
	      gmailHistoryId?: string
	      imapHost: string; imapPort: number; imapTls: boolean
	      smtpHost: string; smtpPort: number; smtpSecure: boolean
      username?: string
    }
  }>('/accounts', async (req, reply) => {
    if (config.dpanelMode) {
      return reply.status(403).send({ error: 'Use /api/auth/dpanel-login in DPanel mode' })
    }
    const body = req.body
    const id = body.id ?? `acc_${crypto.randomBytes(6).toString('hex')}`

    console.log(`[POST /accounts] start id=${id} email=${body.email} host=${body.imapHost}`)

    if (body.provider === 'gmail' && !body.oauthRefreshToken) {
      const existing = getAccount(id)
      if (existing?.provider === 'gmail') {
        console.log(`[POST /accounts] reused encrypted Gmail credentials id=${id}`)
        return redactedAccount(existing)
      }
      return reply.status(400).send({ error: 'Gmail OAuth credentials are missing. Connect with Google again.' })
    }

	    const account = {
	      id,
	      name: body.name,
	      email: body.email,
	      username: body.username ?? body.email,
	      password: body.password ?? '',
	      provider: body.provider ?? 'imap',
	      imapHost: body.imapHost,
      imapPort: body.imapPort,
      imapTls: body.imapTls,
      smtpHost: body.smtpHost,
      smtpPort: body.smtpPort,
      smtpSecure: body.smtpSecure,
	      isActive: true,
	      lastSync: 0,
	      oauthRefreshToken: body.oauthRefreshToken,
	      gmailHistoryId: body.gmailHistoryId,
	    }

	    if (account.provider !== 'gmail') {
	      // Verify SMTP connectivity before persisting. Wrapped in an outer race
	      // so even if verifySmtp's own ceiling misfires, the request resolves.
	      try {
	        await withTimeout(verifySmtp(account), ROUTE_HARD_TIMEOUT_MS, 'SMTP verify')
	      } catch (err) {
	        const msg = err instanceof Error ? err.message : String(err)
	        console.error(`[POST /accounts] verify failed id=${id} err=${msg}`)
	        // Make absolutely sure we don't leave a wedged transport behind.
	        clearTransport(id)
	        return reply.status(400).send({ error: `SMTP connection failed: ${msg}` })
	      }
	    }

    console.log(`[POST /accounts] verify ok id=${id}`)
    registerAccount(account)
    console.log(`[POST /accounts] registered id=${id}`)

    return redactedAccount(account)
  })

  // Delete account
  app.delete<{ Params: { id: string } }>('/accounts/:id', async (req, reply) => {
    const { id } = req.params
    if (!getAccount(id)) return reply.status(404).send({ error: 'Account not found' })
	    closeConnection(id)
	    removePersistedGmailAccount(id)
	    removeAccount(id)
    return reply.status(204).send()
  })

  // List folders for an account
	  app.get<{ Params: { id: string } }>('/accounts/:id/folders', async (req, reply) => {
	    const account = getAccount(req.params.id)
	    if (!account) return reply.status(404).send({ error: 'Not found' })
	    if (account.provider === 'gmail') {
	      const labels = await listGmailLabels(account)
	      return {
	        folders: labels.map(label => ({
	          name: gmailLabelName(label.id, label.name),
	          path: label.id,
	          role: folderRole(gmailLabelName(label.id, label.name)),
	        })),
	      }
	    }
	    const folders = await listFolders(account)
    return {
      folders: folders.map(path => {
        const name = logicalFolderName(account.imapHost, path)
        return { name, path, role: folderRole(name) }
      }),
    }
	  })

  app.get('/auth/google/status', async (_req, reply) => {
    if (config.dpanelMode) return reply.status(404).send({ error: 'Gmail OAuth disabled in DPanel mode' })
    return googleOAuthStatus()
  })

	  app.get('/auth/google/start', async (_req, reply) => {
    if (config.dpanelMode) return reply.status(404).send({ error: 'Gmail OAuth disabled in DPanel mode' })
    const status = googleOAuthStatus()
	    if (!status.configured) {
	      return reply.status(400).type('text/html').send(`
          <!doctype html>
          <html>
            <head>
              <meta charset="utf-8" />
              <title>Google OAuth setup needed</title>
              <style>
                body { margin: 0; background: #101112; color: #f0f1f2; font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, sans-serif; }
                main { max-width: 720px; margin: 64px auto; padding: 0 24px; }
                code { background: #1e2023; border: 1px solid rgba(255,255,255,.13); border-radius: 6px; padding: 2px 6px; color: #8fb3ff; }
                .box { background: #161719; border: 1px solid rgba(255,255,255,.09); border-radius: 12px; padding: 20px; }
              </style>
            </head>
            <body>
              <main>
                <div class="box">
                  <h1>Google OAuth is not configured</h1>
                  <p>Add these values to <code>.env</code> and restart the server:</p>
                  <p><code>GOOGLE_CLIENT_ID</code><br/><code>GOOGLE_CLIENT_SECRET</code><br/><code>GOOGLE_REDIRECT_URI=${escapeHtml(status.redirectUri)}</code></p>
                  <p>In Google Cloud Console, create a Web application OAuth client and add this exact authorized redirect URI:</p>
                  <p><code>${escapeHtml(status.redirectUri)}</code></p>
                </div>
              </main>
            </body>
          </html>
        `)
	    }
	    const state = crypto.randomBytes(12).toString('hex')
	    googleOAuthStates.add(state)
	    setTimeout(() => googleOAuthStates.delete(state), GOOGLE_OAUTH_STATE_TTL_MS).unref()
	    const qs = new URLSearchParams({
	      client_id: config.googleOAuth.clientId,
	      redirect_uri: config.googleOAuth.redirectUri,
	      response_type: 'code',
	      access_type: 'offline',
	      prompt: 'consent',
	      state,
	      scope: GOOGLE_GMAIL_SCOPES.join(' '),
	    })
	    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${qs}`)
	  })

	  app.get<{ Querystring: { code?: string; error?: string; state?: string } }>('/auth/google/callback', async (req, reply) => {
    if (config.dpanelMode) return reply.status(404).send({ error: 'Gmail OAuth disabled in DPanel mode' })
	    if (req.query.error) return reply.type('text/html').send(`<h1>Google sign-in failed</h1><p>${req.query.error}</p>`)
	    if (!req.query.code) return reply.status(400).send({ error: 'Missing OAuth code' })
	    if (!req.query.state || !googleOAuthStates.delete(req.query.state)) {
	      return reply.status(400).send({ error: 'Invalid OAuth state' })
	    }
	    const tokens = await exchangeCode(req.query.code)
	    if (!tokens.refresh_token) {
	      return reply.type('text/html').send('<h1>Google sign-in needs consent</h1><p>Please try again and approve offline access.</p>')
	    }
	    const user = await getGoogleUser(tokens.access_token)
	    const id = `gmail_${crypto.createHash('sha1').update(user.email).digest('hex').slice(0, 12)}`
		    const account = {
		      id,
		      provider: 'gmail' as const,
	      name: user.name,
	      email: user.email,
	      username: user.email,
	      password: '',
	      imapHost: 'gmail-api',
	      imapPort: 0,
	      imapTls: true,
	      smtpHost: 'gmail-api',
	      smtpPort: 0,
	      smtpSecure: true,
	      isActive: true,
	      lastSync: 0,
	      oauthRefreshToken: tokens.refresh_token,
	      gmailAccessToken: tokens.access_token,
	      gmailAccessTokenExpiresAt: Date.now() + tokens.expires_in * 1000,
	    }
	    registerAccount(account)
	    persistGmailAccount(account)
	    return reply.type('text/html').send(`
        <!doctype html>
        <html>
          <head>
            <meta charset="utf-8" />
            <title>Duperhuman connected Gmail</title>
            <style>
              body { margin: 0; background: #101112; color: #f0f1f2; font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, sans-serif; }
              main { max-width: 560px; margin: 80px auto; padding: 0 24px; text-align: center; }
              button { border: 0; border-radius: 10px; padding: 10px 14px; background: #8fb3ff; color: #0b1220; font-weight: 700; cursor: pointer; }
            </style>
          </head>
          <body>
            <main>
              <h1>Gmail connected</h1>
              <p>You can return to Duperhuman now.</p>
              <button onclick="window.close()">Close window</button>
            </main>
            <script>
              try {
                window.opener && window.opener.postMessage({ type: 'duperhuman:gmail-connected' }, '*');
              } catch (err) {}
              setTimeout(() => window.close(), 1000);
            </script>
          </body>
        </html>
      `)
	  })
	}

function folderRole(name: string) {
  const n = name.toLowerCase()
  if (n === 'inbox') return 'inbox'
  if (n === 'sent' || n.includes('sent mail')) return 'sent'
  if (n === 'drafts' || n.includes('draft')) return 'drafts'
  if (n === 'trash' || n.includes('bin') || n.includes('deleted')) return 'trash'
  if (n === 'spam' || n.includes('junk')) return 'spam'
  if (n === 'starred') return 'starred'
  if (n === 'all mail' || n === 'archive') return 'archive'
  return undefined
}

function gmailLabelName(id: string, name: string) {
  const map: Record<string, string> = {
    INBOX: 'INBOX',
    SENT: 'Sent',
    DRAFT: 'Drafts',
    TRASH: 'Trash',
    SPAM: 'Spam',
    STARRED: 'Starred',
  }
  return map[id] ?? name
}
