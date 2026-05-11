import Fastify from 'fastify'
import cors from '@fastify/cors'
import sensible from '@fastify/sensible'
import cookie from '@fastify/cookie'
import { config } from './lib/config.js'
import { accountRoutes } from './routes/accounts.js'
import { emailRoutes } from './routes/emails.js'
import { searchRoutes } from './routes/search.js'
import { dpanelAuthRoutes } from './routes/dpanel-auth.js'
import { dpanelSessionGuard } from './lib/dpanel-guard.js'
import { registerAccount, startBackgroundSync } from './services/sync.js'
import { loadPersistedGmailAccounts } from './services/gmail.js'

const app = Fastify({
  logger:
    config.nodeEnv === 'development'
      ? {
          level:     'info',
          transport: { target: 'pino-pretty', options: { colorize: true } },
        }
      : false,
})

// ─── Plugins ──────────────────────────────────────────────────────────────────

await app.register(cors, {
  origin: (origin, cb) => {
    // DPanel mode is same-origin (Apache reverse-proxies /api → Fastify on the
    // webmail.<domain> vhost) so the browser sends no Origin header. Accept it.
    if (
      !origin ||
      origin === 'null' ||
      origin.startsWith('app://') ||
      origin.startsWith('http://localhost') ||
      origin.startsWith('http://127.0.0.1') ||
      origin.startsWith('https://webmail.')
    ) {
      cb(null, true)
    } else {
      cb(new Error(`CORS: blocked origin ${origin}`), false)
    }
  },
  credentials: true,
})

await app.register(sensible)
await app.register(cookie, { secret: config.cookieSecret || config.sessionSecret })

// ─── Routes ───────────────────────────────────────────────────────────────────

await app.register(dpanelAuthRoutes, { prefix: '/api' })

// Mailbox routes are scoped inside an encapsulated plugin so the session
// guard only fires for them (not for the auth/config endpoints above).
await app.register(async (instance) => {
  if (config.dpanelMode) {
    instance.addHook('preHandler', dpanelSessionGuard)
  }
  await instance.register(accountRoutes, { prefix: '/api' })
  await instance.register(emailRoutes, { prefix: '/api' })
  await instance.register(searchRoutes, { prefix: '/api' })
})

// Health check
app.get('/health', async () => ({ ok: true, ts: Date.now() }))

// ─── Startup: seed default account from env (non-DPanel mode only) ───────────

if (!config.dpanelMode && config.defaultAccount) {
  const d = config.defaultAccount
  registerAccount({
    id: d.id,
    name: d.name,
    email: d.email,
    username: d.username,
    password: d.password,
    imapHost: d.imapHost,
    imapPort: d.imapPort,
    imapTls: d.imapTls,
    smtpHost: d.smtpHost,
    smtpPort: d.smtpPort,
    smtpSecure: d.smtpSecure,
    isActive: true,
    lastSync: 0,
  })
  app.log.info(`Default account registered: ${d.email}`)
}

if (!config.dpanelMode) {
  for (const account of loadPersistedGmailAccounts()) {
    registerAccount(account)
    app.log.info(`Persisted Gmail account registered: ${account.email}`)
  }
}

// ─── Start background sync ────────────────────────────────────────────────────

startBackgroundSync(config.syncIntervalMs)
app.log.info(`Background sync every ${config.syncIntervalMs}ms`)

// ─── Listen ───────────────────────────────────────────────────────────────────

try {
  await app.listen({ port: config.port, host: '127.0.0.1' })
  console.log(`Server ready at http://127.0.0.1:${config.port}${config.dpanelMode ? ' (DPanel mode)' : ''}`)
} catch (err) {
  console.error('Server failed to start:', err)
  process.exit(1)
}
