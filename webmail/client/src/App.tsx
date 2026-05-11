import { useEffect, useState } from 'react'
import { AppLayout }    from '@/components/layout/AppLayout'
import { useGlobalKeyboard } from '@/hooks/useKeyboard'
import { useEmailStore } from '@/store/emailStore'
import { useUiStore } from '@/store/uiStore'
import { accounts as accountsApi, dpanelAuth, publicConfig, type GoogleOAuthStatus, type PublicConfig } from '@/lib/api'
import { processOutbox } from '@/lib/outbox'
import { processMailMutations } from '@/lib/mailMutations'
import { dueFollowUps, completeFollowUp } from '@/lib/localWorkflow'
import { db }           from '@/db/db'
import type { Account } from '@/types/email'
import { DPanelLogin } from '@/components/account/DPanelLogin'
import { setClientConfig } from '@/lib/clientConfig'

function schedulePreload(fn: () => void) {
  const win = window as typeof window & { requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number }
  if (win.requestIdleCallback) {
    win.requestIdleCallback(fn, { timeout: 5000 })
  } else {
    window.setTimeout(fn, 2500)
  }
}

// ─── Electron API bridge (typed, optional) ────────────────────────────────────

interface ElectronAPI {
  platform:      string
  isElectron:    boolean
  loadAccounts:  () => Promise<(Account & { password: string })[]>
  saveAccount:   (a: Account & { password: string }) => Promise<void>
  removeAccount: (id: string) => Promise<void>
}

function electronAPI(): ElectronAPI | null {
  return (window as typeof window & { electronAPI?: ElectronAPI }).electronAPI ?? null
}

// ─── First-run setup screen ───────────────────────────────────────────────────

function SetupScreen({ onSetup }: { onSetup: (account: Account, password: string) => void }) {
  const [form, setForm] = useState({
    name: '', email: '', password: '',
    imapHost: 'imap.gmail.com', imapPort: 993, imapTls: true,
    smtpHost: 'smtp.gmail.com', smtpPort: 587, smtpSecure: false,
  })
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
  const [googleStatus, setGoogleStatus] = useState<GoogleOAuthStatus | null>(null)

  useEffect(() => {
    accountsApi.googleStatus().then(setGoogleStatus).catch(() => setGoogleStatus(null))
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const account = await accountsApi.create({ ...form, username: form.email })
      onSetup(account, form.password)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Connection failed. Check your credentials.')
    } finally {
      setLoading(false)
    }
  }

  const connectGmail = async () => {
    setLoading(true)
    setError('')

    try {
      const status = await accountsApi.googleStatus()
      setGoogleStatus(status)

      if (!status.configured) {
        setGoogleStatus(status)
        setLoading(false)
        setError(`Google OAuth needs setup. Add ${status.missing.join(' and ') || 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET'} to .env, then restart the server.`)
        return
      }

      const before = new Set((await accountsApi.list().catch(() => [])).map(a => a.id))
      const popup = window.open(accountsApi.googleAuthUrl(), '_blank', 'width=520,height=720')

      if (!popup) {
        setLoading(false)
        setError('Google sign-in popup was blocked. Allow pop-ups for this app and try again.')
        return
      }

      const started = Date.now()
      let done = false
      let poll = 0
      let onMessage: (event: MessageEvent) => void = () => {}

      const cleanup = () => {
        window.clearInterval(poll)
        window.removeEventListener('message', onMessage)
        setLoading(false)
      }

      const complete = (account: Account) => {
        if (done) return
        done = true
        cleanup()
        onSetup(account, '')
      }

      const checkForAccount = async () => {
        if (done) return

        try {
          const accounts = await accountsApi.list()
          const account = accounts.find(a => a.provider === 'gmail' && !before.has(a.id))
            ?? accounts.find(a => a.provider === 'gmail')

          if (account) {
            complete(account)
          } else if (Date.now() - started > 120_000) {
            done = true
            cleanup()
            setError('Google sign-in timed out. Try again.')
          }
        } catch (err) {
          done = true
          cleanup()
          setError(err instanceof Error ? err.message : 'Google sign-in failed.')
        }
      }

      onMessage = (event: MessageEvent) => {
        if ((event.data as { type?: string } | undefined)?.type === 'duperhuman:gmail-connected') {
          void checkForAccount()
        }
      }

      window.addEventListener('message', onMessage)
      poll = window.setInterval(checkForAccount, 1500)
      void checkForAccount()
    } catch (err) {
      setLoading(false)
      setError(err instanceof Error ? err.message : 'Google sign-in failed.')
    }
  }

  const presets: Record<string, Partial<typeof form>> = {
    Gmail:    { imapHost: 'imap.gmail.com',        imapPort: 993, imapTls: true, smtpHost: 'smtp.gmail.com',        smtpPort: 587, smtpSecure: false },
    Fastmail: { imapHost: 'imap.fastmail.com',     imapPort: 993, imapTls: true, smtpHost: 'smtp.fastmail.com',     smtpPort: 587, smtpSecure: false },
    iCloud:   { imapHost: 'imap.mail.me.com',      imapPort: 993, imapTls: true, smtpHost: 'smtp.mail.me.com',      smtpPort: 587, smtpSecure: false },
    Outlook:  { imapHost: 'outlook.office365.com', imapPort: 993, imapTls: true, smtpHost: 'smtp.office365.com',    smtpPort: 587, smtpSecure: false },
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: 'var(--bg-base)' }}>
      <div className="w-full max-w-md rounded-2xl overflow-hidden"
        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', boxShadow: '0 24px 80px rgba(0,0,0,0.5)' }}
      >
        {/* Header */}
        <div className="px-8 py-8 text-center"
          style={{ background: 'linear-gradient(135deg, #1b1938 0%, #13121f 100%)' }}
        >
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: 'var(--accent-faint)', border: '1px solid var(--border-accent)', color: 'var(--accent)' }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M17.5 1L7.5 13h5l-1 10 10-12h-5l1-10z" fill="currentColor" stroke="currentColor" strokeWidth="0.5" strokeLinejoin="round" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-[var(--text-primary)]" style={{ letterSpacing: '-0.03em' }}>
            Connect your email
          </h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
	            Credentials stay inside your local Duperhuman app and helper server.
          </p>
        </div>

	        <div className="px-8 pt-6">
		          <button
		            type="button"
		            onClick={connectGmail}
		            disabled={loading}
		            className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all duration-100 disabled:opacity-50"
		            style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
		          >
		            Connect Gmail with Google
		          </button>
          {googleStatus && !googleStatus.configured && (
            <div className="mt-3 rounded-xl px-3 py-2 text-xs text-left" style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
              <div className="font-semibold text-[var(--text-primary)] mb-1">Google OAuth setup needed</div>
              <div>Authorized redirect URI:</div>
              <code className="block mt-1 break-all text-[var(--accent)]">{googleStatus.redirectUri}</code>
            </div>
          )}
	          <div className="flex items-center gap-3 my-5">
	            <div className="h-px flex-1" style={{ background: 'var(--border-subtle)' }} />
	            <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-widest">or IMAP</span>
	            <div className="h-px flex-1" style={{ background: 'var(--border-subtle)' }} />
	          </div>
	        </div>

	        <form onSubmit={submit} className="px-8 pb-6 space-y-4">
          {/* Provider presets */}
          <div>
            <label className="text-label text-[var(--text-muted)] block mb-2">Provider</label>
            <div className="grid grid-cols-4 gap-2">
              {Object.entries(presets).map(([name, vals]) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setForm(f => ({ ...f, ...vals }))}
                  className="py-1.5 px-2 rounded-lg text-xs font-medium transition-colors duration-100"
                  style={{
                    background: form.imapHost === vals.imapHost ? 'var(--accent-faint)' : 'var(--bg-overlay)',
                    border:     form.imapHost === vals.imapHost ? '1px solid var(--border-accent)' : '1px solid var(--border-subtle)',
                    color:      form.imapHost === vals.imapHost ? 'var(--accent)' : 'var(--text-secondary)',
                  }}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-label text-[var(--text-muted)] block mb-1">Name</label>
              <input required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Your Name"
                className="w-full px-3 py-2 rounded-lg text-sm text-[var(--text-primary)] bg-[var(--bg-overlay)] outline-none transition-all"
                style={{ border: '1px solid var(--border-subtle)' }}
                onFocus={e => e.target.style.borderColor = 'var(--border-accent)'}
                onBlur={e  => e.target.style.borderColor = 'var(--border-subtle)'}
              />
            </div>
            <div>
              <label className="text-label text-[var(--text-muted)] block mb-1">Email</label>
              <input required type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                placeholder="you@gmail.com"
                className="w-full px-3 py-2 rounded-lg text-sm text-[var(--text-primary)] bg-[var(--bg-overlay)] outline-none"
                style={{ border: '1px solid var(--border-subtle)' }}
                onFocus={e => e.target.style.borderColor = 'var(--border-accent)'}
                onBlur={e  => e.target.style.borderColor = 'var(--border-subtle)'}
              />
            </div>
          </div>

          <div>
            <label className="text-label text-[var(--text-muted)] block mb-1">
              App Password
              <span className="ml-2 font-normal normal-case text-[var(--text-disabled)]">(not your main password)</span>
            </label>
            <input required type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              placeholder="xxxx xxxx xxxx xxxx"
              className="w-full px-3 py-2 rounded-lg text-sm text-[var(--text-primary)] bg-[var(--bg-overlay)] outline-none font-mono"
              style={{ border: '1px solid var(--border-subtle)' }}
              onFocus={e => e.target.style.borderColor = 'var(--border-accent)'}
              onBlur={e  => e.target.style.borderColor = 'var(--border-subtle)'}
            />
          </div>

          {error && <p className="text-sm text-red-400 bg-red-400/10 rounded-lg px-3 py-2">{error}</p>}

          <button type="submit" disabled={loading}
            className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all duration-100 disabled:opacity-50"
            style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
          >
            {loading ? 'Connecting…' : 'Connect Account'}
          </button>

          <p className="text-xs text-center text-[var(--text-disabled)]">
            For Gmail/Google Workspace, generate an App Password at myaccount.google.com/apppasswords
          </p>
        </form>
      </div>
    </div>
  )
}

// ─── Root ─────────────────────────────────────────────────────────────────────

function AppInner() {
  useGlobalKeyboard()
  const processLocalWorkflow = useEmailStore(s => s.processLocalWorkflow)
  const activeAccountId = useEmailStore(s => s.activeAccountId)
  const setAccounts = useEmailStore(s => s.setAccounts)
  const toast = useUiStore(s => s.toast)

  useEffect(() => {
    const run = async () => {
	      await processOutbox()
      await processMailMutations()
	      await processLocalWorkflow()
      if (activeAccountId) {
        const due = await dueFollowUps(activeAccountId)
        if (due.length > 0) {
          // Mark reminders complete after surfacing them once. The email remains
          // in local cache and can be found through search or labels.
          await Promise.all(due.map(f => completeFollowUp(f.id)))
          toast(`${due.length} follow-up${due.length === 1 ? '' : 's'} due`)
        }
      }
    }
    run()
    const timer = window.setInterval(run, 30_000)
    return () => window.clearInterval(timer)
  }, [activeAccountId, processLocalWorkflow, toast])

  useEffect(() => {
    let cancelled = false

    const refreshAccounts = async () => {
      try {
        const serverAccounts = await accountsApi.list()
        if (cancelled || serverAccounts.length === 0) return

        const current = useEmailStore.getState().accounts
        const currentIds = new Set(current.map(a => a.id))
        const changed = serverAccounts.length !== current.length ||
          serverAccounts.some(account => !currentIds.has(account.id))

        if (!changed) return
        setAccounts(serverAccounts)
        await db.accounts.bulkPut(serverAccounts)
      } catch (err) {
        console.error('[accounts] refresh failed', err)
      }
    }

    const onFocus = () => { void refreshAccounts() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    void refreshAccounts()

    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [setAccounts])

  return <AppLayout />
}

export default function App() {
  const { setAccounts, addAccount, setActiveAccount, loadEmails, preloadAllMail } = useEmailStore()
  const [ready,      setReady]      = useState(false)
  const [hasAccount, setHasAccount] = useState(false)
  const [config,     setConfig]     = useState<PublicConfig | null>(null)

  const hydrateAccount = async (account: Account) => {
    setAccounts([account])
    addAccount(account)
    setActiveAccount(account.id)
    await db.accounts.put(account)
    await loadEmails()
    schedulePreload(() => preloadAllMail(account.id, 'auto'))
    setHasAccount(true)
  }

  useEffect(() => {
    // Public-config fetch is unauthenticated and lets us pick the right boot
    // path before doing anything else. Defaults to non-DPanel if unreachable.
    publicConfig.get()
      .then(c => { setClientConfig(c); setConfig(c) })
      .catch(() => {
        const fallback: PublicConfig = { mode: 'normal', gmailEnabled: false }
        setClientConfig(fallback); setConfig(fallback)
      })
  }, [])

  useEffect(() => {
    if (!config) return

    const boot = async () => {
      try {
        // ── DPanel mode: cookie session lookup. No IndexedDB resurrection,
        //    no Electron path — every login is a fresh session.
        if (config.mode === 'dpanel') {
          // If the cached account in IndexedDB belongs to a different email
          // than the session, clear it so we don't show stale mail.
          try {
            const account = await dpanelAuth.session()
            const cached = await db.accounts.toArray()
            if (cached.some(c => c.email !== account.email)) {
              await db.delete()
            }
            await hydrateAccount(account)
          } catch {
            // No valid session — DPanelLogin will render.
          }
          return
        }

        // ── 1. Try to load persisted accounts (Electron) ──────────────────
        const eAPI = electronAPI()
        if (eAPI) {
          const stored = await eAPI.loadAccounts()
          if (stored.length > 0) {
            // Re-register each account with the server (server is stateless)
            const registered: Account[] = []
	            for (const sa of stored) {
	              try {
	                const acc = await accountsApi.create(sa)
	                registered.push(acc)
	                await db.accounts.put(acc)
	              } catch {
	                // If already registered (server kept it), try listing
	              }
	            }
            // Fall back to server list if registration failed for all
            const serverAccounts = registered.length > 0
              ? registered
              : await accountsApi.list()

	            if (serverAccounts.length > 0) {
	              setAccounts(serverAccounts)
	              await db.accounts.bulkPut(serverAccounts)
	              await loadEmails()
              schedulePreload(() => preloadAllMail(serverAccounts[0]?.id, 'auto'))
	              setHasAccount(true)
              setReady(true)
              return
            }
          }
        }

        // ── 2. No persisted accounts — check server (dev / web mode) ──────
        const serverAccounts = await accountsApi.list()
	        if (serverAccounts.length > 0) {
	          setAccounts(serverAccounts)
	          await db.accounts.bulkPut(serverAccounts)
	          await loadEmails()
          schedulePreload(() => preloadAllMail(serverAccounts[0]?.id, 'auto'))
          setHasAccount(true)
          setReady(true)
          return
        }

        // If the server is reachable and has no accounts, prefer the setup
        // screen over resurrecting stale IndexedDB accounts that cannot sync.
      } catch (err) {
        console.error('boot error', err)
        // Try IndexedDB fallback
        const local = await db.accounts.toArray()
	        if (local.length > 0) {
	          setAccounts(local)
	          await loadEmails()
          schedulePreload(() => preloadAllMail(local[0]?.id, 'auto'))
          setHasAccount(true)
        }
      } finally {
        setReady(true)
      }
    }
    boot()
  }, [config])

  const handleFirstAccount = async (account: Account, password: string) => {
    const eAPI = electronAPI()
    if (eAPI) {
      await eAPI.saveAccount({ ...account, password })
    }
    await db.accounts.put(account)
    addAccount(account)
    setActiveAccount(account.id)
    await loadEmails()
    schedulePreload(() => preloadAllMail(account.id, 'full'))
    setHasAccount(true)
  }

  if (!ready || !config) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-base)' }}>
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: 'var(--accent-faint)', border: '1px solid var(--border-accent)', color: 'var(--accent)' }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M17.5 1L7.5 13h5l-1 10 10-12h-5l1-10z" fill="currentColor" stroke="currentColor" strokeWidth="0.5" strokeLinejoin="round" />
            </svg>
          </div>
          <p className="text-xs text-[var(--text-muted)]">Loading…</p>
        </div>
      </div>
    )
  }

  if (!hasAccount) {
    if (config.mode === 'dpanel') {
      return <DPanelLogin onSuccess={hydrateAccount} />
    }
    return <SetupScreen onSetup={handleFirstAccount} />
  }

  return <AppInner />
}
