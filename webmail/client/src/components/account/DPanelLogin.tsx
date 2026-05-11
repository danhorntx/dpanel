import { useState } from 'react'
import { dpanelAuth } from '@/lib/api'
import type { Account } from '@/types/email'

interface Props {
  onSuccess: (account: Account) => void
}

/**
 * DPanel-mode sign-in screen. Email + password only — IMAP/SMTP endpoints are
 * derived server-side from the DPanel mail stack so the user never sees
 * connection details.
 */
export function DPanelLogin({ onSuccess }: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const account = await dpanelAuth.login(email.trim(), password)
      onSuccess(account)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed')
    } finally {
      setLoading(false)
    }
  }

  const switchToClassic = () => {
    // 30-day cookie. Apache reads this cookie and proxies the request to the
    // classic webmail backend (DPanel's built-in webmail at /webmail) instead
    // of the duperhuman SPA.
    document.cookie = `webmail_mode=classic; max-age=${30 * 24 * 60 * 60}; path=/; SameSite=Lax`
    window.location.reload()
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: 'var(--bg-base)' }}>
      <div
        className="w-full max-w-md rounded-2xl overflow-hidden"
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
        }}
      >
        <div
          className="px-8 py-8 text-center"
          style={{ background: 'linear-gradient(135deg, #1b1938 0%, #13121f 100%)' }}
        >
          <div className="flex items-center justify-center gap-2.5 mb-4">
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center"
              style={{ background: 'var(--accent-faint)', border: '1px solid var(--border-accent)', color: 'var(--accent)' }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path
                  d="M17.5 1L7.5 13h5l-1 10 10-12h-5l1-10z"
                  fill="currentColor"
                  stroke="currentColor"
                  strokeWidth="0.5"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <span
              className="text-[var(--text-primary)]"
              style={{ fontSize: '1.25rem', fontWeight: 700, letterSpacing: '-0.035em' }}
            >
              Duperhuman
            </span>
          </div>
          <h1 className="text-base font-semibold text-[var(--text-primary)]" style={{ letterSpacing: '-0.025em' }}>
            Sign in to your mailbox
          </h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            Use your email address and password.
          </p>
        </div>

        <form onSubmit={submit} className="px-8 py-6 space-y-4">
          <div>
            <label className="text-[11px] text-[var(--text-muted)] font-medium uppercase tracking-wider block mb-1.5">
              Email
            </label>
            <input
              required
              type="email"
              autoFocus
              autoComplete="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full px-3 py-2 rounded-lg text-sm text-[var(--text-primary)] bg-[var(--bg-overlay)] outline-none transition-all"
              style={{ border: '1px solid var(--border-subtle)' }}
              onFocus={e => (e.target.style.borderColor = 'var(--border-accent)')}
              onBlur={e => (e.target.style.borderColor = 'var(--border-subtle)')}
            />
          </div>

          <div>
            <label className="text-[11px] text-[var(--text-muted)] font-medium uppercase tracking-wider block mb-1.5">
              Password
            </label>
            <input
              required
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full px-3 py-2 rounded-lg text-sm text-[var(--text-primary)] bg-[var(--bg-overlay)] outline-none transition-all"
              style={{ border: '1px solid var(--border-subtle)' }}
              onFocus={e => (e.target.style.borderColor = 'var(--border-accent)')}
              onBlur={e => (e.target.style.borderColor = 'var(--border-subtle)')}
            />
          </div>

          {error && (
            <p className="text-sm text-red-400 bg-red-400/10 rounded-lg px-3 py-2">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all duration-100 disabled:opacity-50"
            style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>

          <div className="pt-2 text-center">
            <button
              type="button"
              onClick={switchToClassic}
              className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] underline-offset-2 hover:underline"
            >
              Use classic webmail instead
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
