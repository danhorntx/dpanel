import type { Email, SendEmailPayload, Account } from '@/types/email'

export interface MailFolderInfo {
  name: string
  path: string
  role?: 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'starred' | 'archive'
}

export interface GoogleOAuthStatus {
  configured: boolean
  missing: string[]
  redirectUri: string
  scopes: string[]
}

// Dev: Vite proxies /api → :3001 (relative URLs work).
// Prod (packaged Electron): renderer is served from app://duperhuman/, so we
// must hit the embedded Fastify server on http://127.0.0.1:3001 explicitly.
const BASE: string =
  typeof window !== 'undefined' && window.location.protocol === 'app:'
    ? 'http://127.0.0.1:3001'
    : (import.meta.env.VITE_API_URL ?? '')

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

interface RequestOptions extends RequestInit {
  /** Abort the request after this many ms. Defaults to 60s for safety. */
  timeoutMs?: number
}

async function request<T>(path: string, init?: RequestOptions): Promise<T> {
  const controller = new AbortController()
  const timeoutMs  = init?.timeoutMs ?? 60_000
  const timer      = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(`${BASE}/api${path}`, {
      headers: { 'Content-Type': 'application/json', ...init?.headers },
      signal:  controller.signal,
      ...init,
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => res.statusText)
      // Server convention is { error: string } — surface that cleanly.
      let msg = raw
      try {
        const parsed = JSON.parse(raw) as { error?: string; message?: string }
        msg = parsed.error ?? parsed.message ?? raw
      } catch { /* not JSON — keep raw */ }
      throw new ApiError(res.status, msg)
    }
    if (res.status === 204) return undefined as T
    const text = await res.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new ApiError(0, `Request timed out after ${timeoutMs}ms — server unreachable or hung`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// ─── Accounts ────────────────────────────────────────────────────────────────

export const accounts = {
  list: () => request<Account[]>('/accounts'),
  create: (data: Omit<Account, 'id' | 'syncState' | 'isActive'> & { password: string }) =>
    request<Account>('/accounts', {
      method:    'POST',
      body:      JSON.stringify(data),
      // Slightly above the server's 25s ROUTE_HARD_TIMEOUT_MS so we surface
      // the server's structured error (bad creds, timeout reason, etc.)
      // before the client's abort fires.
      timeoutMs: 30_000,
    }),
  delete: (id: string) =>
    request<void>(`/accounts/${id}`, { method: 'DELETE' }),

  folders: (id: string) =>
    request<{ folders: MailFolderInfo[] }>(`/accounts/${encodeURIComponent(id)}/folders`),

  googleStatus: () =>
    request<GoogleOAuthStatus>('/auth/google/status'),

  googleAuthUrl: () => `${BASE || 'http://127.0.0.1:3001'}/api/auth/google/start`,
}

// ─── Public config ───────────────────────────────────────────────────────────
// Every server exposes this so the client can detect whether it's running in
// DPanel multi-tenant mode or the stock single-tenant flow.

export interface PublicConfig {
  mode: 'dpanel' | 'normal'
  gmailEnabled: boolean
}

export const publicConfig = {
  get: () => request<PublicConfig>('/config/public', { credentials: 'include' }),
}

// ─── DPanel-mode auth ────────────────────────────────────────────────────────

export const dpanelAuth = {
  login: (email: string, password: string) =>
    request<Account>('/auth/dpanel-login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      credentials: 'include',
      timeoutMs: 15_000,
    }),

  session: () =>
    request<Account>('/auth/dpanel-session', { credentials: 'include' }),

  logout: () =>
    // Body required to dodge Fastify's FST_ERR_CTP_EMPTY_JSON_BODY — our
    // `request()` helper hard-codes Content-Type: application/json and
    // Fastify rejects a JSON content-type with an empty body. Empty object
    // satisfies the parser and the handler ignores req.body anyway.
    request<{ ok: boolean }>('/auth/logout', {
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({}),
    }),

  // DPanel-only: self-serve mailbox password change. Verified server-side by
  // re-probing IMAP with the current password before rewriting Dovecot's
  // userdb. Throws with a user-friendly message on 4xx; the session cookie
  // is rotated on success so the user stays logged in with the new password.
  changeMailPassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>('/account/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
      credentials: 'include',
    }),
}

// ─── Emails ───────────────────────────────────────────────────────────────────

export const emails = {
  list: (accountId: string, folder = 'INBOX', limit = 100, offset = 0) =>
    request<Email[]>(`/emails?accountId=${encodeURIComponent(accountId)}&folder=${encodeURIComponent(folder)}&limit=${limit}&offset=${offset}`),

  get: (id: string) =>
    request<Email>(`/emails/${encodeURIComponent(id)}`),

  send: (payload: SendEmailPayload) =>
    request<{ messageId: string }>('/emails/send', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  archive: (ids: string[]) =>
    request<void>('/emails/archive', { method: 'POST', body: JSON.stringify({ ids }) }),

  trash: (ids: string[]) =>
    request<void>('/emails/trash', { method: 'POST', body: JSON.stringify({ ids }) }),

  restore: (ids: string[]) =>
    request<void>('/emails/restore', { method: 'POST', body: JSON.stringify({ ids }) }),

  markRead: (ids: string[], read: boolean) =>
    request<void>('/emails/read', {
      method: 'POST',
      body: JSON.stringify({ ids, read }),
    }),

  star: (ids: string[], starred: boolean) =>
    request<void>('/emails/star', {
      method: 'POST',
      body: JSON.stringify({ ids, starred }),
    }),

  spam: (ids: string[]) =>
    request<void>('/emails/spam', { method: 'POST', body: JSON.stringify({ ids }) }),

  mute: (threadId: string) =>
    request<void>('/emails/mute', { method: 'POST', body: JSON.stringify({ threadId }) }),

  snooze: (ids: string[], until: number) =>
    request<void>('/emails/snooze', {
      method: 'POST',
      body: JSON.stringify({ ids, until }),
    }),

  label: (ids: string[], labels: string[]) =>
    request<void>('/emails/label', {
      method: 'POST',
      body: JSON.stringify({ ids, labels }),
    }),
}

// ─── Attachments ──────────────────────────────────────────────────────────────

export const attachments = {
  /** Stable URL the renderer can drop into <img src>, <iframe src>, or <a href>. */
  url: (emailId: string, index: number, opts?: { download?: boolean }): string => {
    const qs = opts?.download ? '?download=1' : ''
    return `${BASE}/api/emails/${encodeURIComponent(emailId)}/attachments/${index}${qs}`
  },
}

// ─── Search ───────────────────────────────────────────────────────────────────

export const search = {
  query: (q: string, accountId: string, limit = 20) =>
    request<Email[]>(`/search?q=${encodeURIComponent(q)}&accountId=${encodeURIComponent(accountId)}&limit=${limit}`),
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

export const sync = {
  trigger: (accountId: string, folder = 'INBOX') =>
    request<void>('/sync', { method: 'POST', body: JSON.stringify({ accountId, folder }) }),

  status: (accountId: string) =>
    request<{ status: string; progress: number; lastSync: number }>(`/sync/status?accountId=${encodeURIComponent(accountId)}`),
}
