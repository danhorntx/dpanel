import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(moduleDir, '../../..', '.env') })
dotenv.config()

const googleOAuthConfigured = !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET
const dpanelMode = process.env.DPANEL_MODE === 'true' || process.env.DPANEL_MODE === '1'

// In DPanel mode the server has no concept of a "default account" — every
// session brings its own. The env-IMAP fast-path is for single-tenant only.
const defaultImapEnabled = !dpanelMode && (process.env.ENABLE_DEFAULT_IMAP_ACCOUNT === 'true' || !googleOAuthConfigured)

export const config = {
  port: parseInt(process.env.PORT ?? '3001', 10),
  sessionSecret: process.env.SESSION_SECRET ?? 'dev-secret-change-me',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  syncIntervalMs: parseInt(process.env.SYNC_INTERVAL_MS ?? '30000', 10),
  initialSyncLimit: parseInt(process.env.INITIAL_SYNC_LIMIT ?? '200', 10),
  allowInsecureTls: process.env.ALLOW_INSECURE_MAIL_TLS === 'true',
  googleOAuth: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI ?? `http://127.0.0.1:${process.env.PORT ?? '3001'}/api/auth/google/callback`,
  },
  userDataDir: process.env.DUPERHUMAN_USER_DATA ?? process.cwd(),

  // ─── DPanel mode ──────────────────────────────────────────────────────────
  // When enabled, the server expects to live next to a Dovecot/Postfix stack
  // and exposes /api/auth/dpanel-login that authenticates against localhost
  // IMAP. The Gmail OAuth UI is hidden.
  dpanelMode,
  // 32+ byte hex string. Encrypts the IMAP password held in the session cookie.
  cookieSecret: process.env.DPANEL_COOKIE_SECRET ?? '',
  imapHost: process.env.DPANEL_IMAP_HOST ?? '127.0.0.1',
  imapPort: parseInt(process.env.DPANEL_IMAP_PORT ?? '993', 10),
  imapTls:  process.env.DPANEL_IMAP_TLS !== 'false',
  smtpHost: process.env.DPANEL_SMTP_HOST ?? '127.0.0.1',
  smtpPort: parseInt(process.env.DPANEL_SMTP_PORT ?? '587', 10),
  smtpSecure: process.env.DPANEL_SMTP_SECURE === 'true',

  // Default account from env (can also be configured via API)
  defaultAccount: defaultImapEnabled && process.env.IMAP_USER
    ? {
        id: 'default',
        name: process.env.SMTP_FROM_NAME ?? 'User',
        email: process.env.IMAP_USER,
        username: process.env.IMAP_USER,
        password: process.env.IMAP_PASS ?? '',
        imapHost: process.env.IMAP_HOST ?? 'imap.gmail.com',
        imapPort: parseInt(process.env.IMAP_PORT ?? '993', 10),
        imapTls: process.env.IMAP_TLS !== 'false',
        smtpHost: process.env.SMTP_HOST ?? 'smtp.gmail.com',
        smtpPort: parseInt(process.env.SMTP_PORT ?? '587', 10),
        smtpSecure: process.env.SMTP_SECURE === 'true',
      }
    : null,
}
