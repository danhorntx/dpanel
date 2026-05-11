import { useState, useEffect, useRef, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import DOMPurify from 'dompurify'
import {
  ArrowBendUpLeftIcon, ArrowBendDoubleUpLeftIcon, ArrowBendUpRightIcon,
  ArchiveIcon, TrashIcon, ClockIcon, TagIcon, CaretDownIcon,
  PaperclipIcon, EnvelopeSimpleOpenIcon, SunIcon, MoonIcon,
  DownloadSimpleIcon, EyeIcon, PencilSimpleIcon, TrayIcon,
} from '@phosphor-icons/react'
import { AttachmentPreview } from '@/components/email/AttachmentPreview'
import { attachments as attachmentsApi, emails as emailsApi } from '@/lib/api'
import { db } from '@/db/db'
import { Avatar } from '@/components/ui/Avatar'
import { useEmailStore, selectSelectedEmail } from '@/store/emailStore'
import { useUiStore } from '@/store/uiStore'
import { formatFullDate, formatEmailDate, formatAddressList, displayName } from '@/lib/utils'
import type { Email } from '@/types/email'

function EmailHeader({ email, expanded, onToggle }: { email: Email; expanded: boolean; onToggle: () => void }) {
  return (
    <div
      className="flex items-start gap-3 p-4 cursor-pointer select-none"
      onClick={onToggle}
    >
      <Avatar address={email.from} size="md" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2 mb-0.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-[var(--text-primary)]">
              {displayName(email.from)}
            </span>
            {!email.isRead && (
              <span
                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                style={{ background: 'var(--accent)' }}
              />
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-xs text-[var(--text-muted)]">{formatEmailDate(email.date)}</span>
            <CaretDownIcon
              size={12}
              weight="bold"
              style={{
                color: 'var(--text-muted)',
                transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 0.15s ease',
              }}
            />
          </div>
        </div>
        <p className="text-xs text-[var(--text-muted)] truncate">
          {expanded
            ? `to ${formatAddressList(email.to)}`
            : email.snippet}
        </p>
      </div>
    </div>
  )
}

/**
 * Renders raw email HTML inside a sandboxed iframe. This is the only safe way
 * to display arbitrary email markup — emails routinely contain <style> tags,
 * !important rules, and absolute-positioned elements that, if injected with
 * dangerouslySetInnerHTML, hijack the host app's layout and typography.
 *
 * sandbox: no allow-scripts (kills tracking pixels' JS, kills any inline JS),
 *          no allow-forms,    (kills credential phishing forms)
 *          BUT allow-same-origin so the parent can read scrollHeight to size
 *          the frame and route safe links to the browser.
 */
function EmailFrame({
  html,
  theme,
  sender,
  blockRemoteImages,
  onBlockedImages,
}: {
  html: string
  theme: 'dark' | 'light'
  sender: string
  blockRemoteImages: boolean
  onBlockedImages: (count: number) => void
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [height, setHeight] = useState(120)

  const normalizeExternalHref = (raw: string): string | null => {
    const href = raw.trim()
    if (/^https?:\/\//i.test(href) || /^(mailto|tel):/i.test(href)) return href
    if (href.startsWith('//')) return `https:${href}`
    return null
  }

  // Sanitize first: even though the iframe sandbox blocks JS execution, we
  // strip <script>, on*= attrs, javascript: URIs, etc. before injecting so
  // we belt-and-suspenders against future protocol/sandbox bypasses and
  // strip CSS expression() that some renderers still honour.
  const safe = useMemo(() => {
    const sanitized = DOMPurify.sanitize(html, {
      FORBID_TAGS:    ['script', 'iframe', 'object', 'embed', 'meta', 'link', 'base'],
      FORBID_ATTR:    ['onload', 'onerror', 'onclick', 'onmouseover', 'onfocus', 'onblur'],
      ALLOW_DATA_ATTR: false,
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|cid):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    })
    if (!blockRemoteImages) {
      return { html: sanitized, blocked: 0 }
    }
    const wrapper = document.createElement('div')
    wrapper.innerHTML = sanitized
    let blocked = 0
    wrapper.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src') ?? ''
      if (!/^https?:\/\//i.test(src)) return
      blocked += 1
      img.setAttribute('data-blocked-src', src)
      img.removeAttribute('src')
      img.setAttribute('alt', img.getAttribute('alt') || 'Remote image blocked')
      img.setAttribute('style', `${img.getAttribute('style') ?? ''};display:none!important;`)
    })
    return { html: wrapper.innerHTML, blocked }
  }, [html, blockRemoteImages, onBlockedImages])

  useEffect(() => {
    onBlockedImages(safe.blocked)
  }, [safe.blocked, onBlockedImages])

  const isDark   = theme === 'dark'
  const bgColor  = isDark ? 'transparent'                : '#ffffff'
  const fgColor  = isDark ? '#e8e6f0'                    : '#1a1a1a'
  const linkColor = isDark ? '#8fb3ff'                   : '#315fa9'
  const blockBorder = isDark ? 'rgba(143,179,255,0.35)'  : 'rgba(49,95,169,0.35)'
  const blockText  = isDark ? 'rgba(232,230,240,0.7)'    : 'rgba(26,26,26,0.7)'

  // Wrap the email HTML in a minimal document that resets defaults and applies
  // theme-appropriate base styles.
  const srcDoc = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<base target="_blank">
<style>
  html, body {
    margin: 0;
    padding: 12px 0 0 0;
    background: ${bgColor};
    color: ${fgColor};
    font-family: 'Geist', system-ui, -apple-system, sans-serif;
    font-size: 14px;
    line-height: 1.6;
    word-wrap: break-word;
    overflow-wrap: anywhere;
  }
  img, table { max-width: 100% !important; height: auto; }
  a { color: ${linkColor}; }
  blockquote {
    border-left: 3px solid ${blockBorder};
    margin: 12px 0; padding: 4px 0 4px 16px;
    color: ${blockText};
  }
</style>
</head>
<body>${safe.html}</body>
</html>`

  // Re-measure whenever the iframe loads or its contents change. We use a
  // ResizeObserver inside the iframe doc so late-loading images don't leave
  // the frame too short.
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return

    let observer: ResizeObserver | null = null
    let cancelled = false
    let removeLinkHandler: (() => void) | null = null

    const measure = () => {
      if (cancelled) return
      const doc = iframe.contentDocument
      if (!doc?.body) return
      // scrollHeight on documentElement is the most reliable cross-content size
      const next = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight)
      setHeight(prev => (Math.abs(prev - next) > 1 ? next : prev))
    }

    const onLoad = () => {
      measure()
      const doc = iframe.contentDocument
      if (!doc?.body) return
      observer = new ResizeObserver(measure)
      observer.observe(doc.body)

      doc.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(anchor => {
        anchor.setAttribute('target', '_blank')
        anchor.setAttribute('rel', 'noopener noreferrer')
      })

      const onLinkClick = (event: MouseEvent) => {
        const target = event.target instanceof Element ? event.target : null
        const anchor = target?.closest('a[href]') as HTMLAnchorElement | null
        if (!anchor) return

        const href = normalizeExternalHref(anchor.getAttribute('href') ?? '')
        if (!href) return

        event.preventDefault()
        event.stopPropagation()
        window.open(href, '_blank', 'noopener,noreferrer')
      }

      doc.addEventListener('click', onLinkClick)
      removeLinkHandler = () => doc.removeEventListener('click', onLinkClick)

      // Also re-measure once images have loaded
      doc.querySelectorAll('img').forEach(img => {
        if (!(img as HTMLImageElement).complete) {
          img.addEventListener('load', measure, { once: true })
          img.addEventListener('error', measure, { once: true })
        }
      })
    }

    iframe.addEventListener('load', onLoad)
    return () => {
      cancelled = true
      iframe.removeEventListener('load', onLoad)
      removeLinkHandler?.()
      observer?.disconnect()
    }
  }, [html])

  return (
    <iframe
      ref={iframeRef}
      title={`Email content from ${sender}`}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      style={{
        width:  '100%',
        height,
        border: 0,
        display: 'block',
        background: isDark ? 'transparent' : '#ffffff',
        borderRadius: isDark ? 0 : 8,
        colorScheme: theme,
      }}
    />
  )
}

const THEME_PREF_KEY = 'duperhuman:emailTheme'

function getThemePref(senderDomain: string, defaultTheme: 'dark' | 'light'): 'dark' | 'light' {
  try {
    const raw = localStorage.getItem(THEME_PREF_KEY)
    if (!raw) return defaultTheme
    const map = JSON.parse(raw) as Record<string, 'dark' | 'light'>
    return map[senderDomain] ?? defaultTheme
  } catch { return defaultTheme }
}

function setThemePref(senderDomain: string, theme: 'dark' | 'light') {
  try {
    const raw = localStorage.getItem(THEME_PREF_KEY)
    const map = raw ? (JSON.parse(raw) as Record<string, 'dark' | 'light'>) : {}
    map[senderDomain] = theme
    localStorage.setItem(THEME_PREF_KEY, JSON.stringify(map))
  } catch { /* localStorage unavailable */ }
}

function EmailBody({ email }: { email: Email }) {
  const [hydratedEmail, setHydratedEmail] = useState(email)
  const senderDomain = hydratedEmail.from.address.split('@')[1] ?? ''
  const emailPreviewTheme = useUiStore(s => s.settings.emailPreviewTheme)
  const automaticallyLoadImages = useUiStore(s => s.settings.automaticallyLoadImages)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => getThemePref(senderDomain, emailPreviewTheme))
  const [previewIdx, setPreviewIdx] = useState<number | null>(null)
  const [blockRemoteImages, setBlockRemoteImages] = useState(() => !automaticallyLoadImages)
  const [blockedImages, setBlockedImages] = useState(0)

  useEffect(() => {
    setHydratedEmail(email)
    if (email.bodyHtml || email.bodyText) return
    let cancelled = false
    emailsApi.get(email.id)
      .then(async full => {
        if (cancelled) return
        setHydratedEmail(full)
        await db.emails.put(full)
      })
      .catch(err => console.error('[thread] body hydrate failed', err))
    return () => { cancelled = true }
  }, [email])

  // Pick up the per-domain saved preference whenever the email changes
  useEffect(() => {
    setTheme(getThemePref(senderDomain, emailPreviewTheme))
  }, [senderDomain, emailPreviewTheme])

  useEffect(() => {
    setBlockRemoteImages(!automaticallyLoadImages)
  }, [hydratedEmail.id, automaticallyLoadImages])

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    setThemePref(senderDomain, next)
  }

  return (
    <div className="px-4 pb-4">
      {/* Metadata */}
      <div className="mb-3 text-xs text-[var(--text-muted)] space-y-0.5">
        <div><span className="text-[var(--text-disabled)]">From:</span>{' '}{hydratedEmail.from.name} &lt;{hydratedEmail.from.address}&gt;</div>
        <div><span className="text-[var(--text-disabled)]">To:</span>{' '}{hydratedEmail.to.map(a => `${a.name} <${a.address}>`).join(', ')}</div>
        {hydratedEmail.cc.length > 0 && (
          <div><span className="text-[var(--text-disabled)]">Cc:</span>{' '}{hydratedEmail.cc.map(a => `${a.name} <${a.address}>`).join(', ')}</div>
        )}
        <div><span className="text-[var(--text-disabled)]">Date:</span>{' '}{formatFullDate(hydratedEmail.date)}</div>
      </div>

	      {/* Theme toggle (only shows for HTML emails — plain text doesn't need it) */}
	      {hydratedEmail.bodyHtml && (
	        <div className="flex items-center justify-between gap-2 mb-2">
          {blockedImages > 0 && blockRemoteImages ? (
            <div className="text-[11px] text-[var(--text-muted)]">
              {blockedImages} remote image{blockedImages === 1 ? '' : 's'} blocked
              <button
                onClick={() => setBlockRemoteImages(false)}
                className="ml-2 text-[var(--accent)] hover:underline"
              >
                Load images
              </button>
            </div>
          ) : <div />}
	          <button
	            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light theme for this sender' : 'Switch to dark theme for this sender'}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] transition-colors"
            style={{
              background: 'var(--bg-hover)',
              border:     '1px solid var(--border-subtle)',
              color:      'var(--text-muted)',
            }}
          >
            {theme === 'dark' ? <SunIcon size={11} /> : <MoonIcon size={11} />}
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>
      )}

      {/* Body — HTML emails go through a sandboxed iframe so their <style>
          tags / wide tables / absolute positioning can't escape and reflow
          the host app. Plain-text bodies render inline (no escape risk). */}
	      {!hydratedEmail.bodyHtml && !hydratedEmail.bodyText ? (
        <div className="email-prose text-[var(--text-muted)]">Loading message body…</div>
      ) : hydratedEmail.bodyHtml ? (
	        <EmailFrame
            html={hydratedEmail.bodyHtml}
            theme={theme}
            sender={hydratedEmail.from.address}
            blockRemoteImages={blockRemoteImages}
            onBlockedImages={setBlockedImages}
          />
	      ) : (
	        <pre className="email-prose whitespace-pre-wrap font-sans">{hydratedEmail.bodyText}</pre>
	      )}

	      {/* Attachments */}
	      {hydratedEmail.attachments.length > 0 && (
        <div className="mt-4 pt-4 border-t border-[var(--border-subtle)]">
          <div className="flex items-center gap-1.5 mb-2">
            <PaperclipIcon size={12} style={{ color: 'var(--text-muted)' }} />
            <span className="text-xs text-[var(--text-muted)] font-medium">
	              {hydratedEmail.attachments.length} attachment{hydratedEmail.attachments.length > 1 ? 's' : ''}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
	            {hydratedEmail.attachments.map((att, i) => {
              const ct = att.contentType ?? ''
              const canPreview = ct.startsWith('image/') || ct === 'application/pdf'
              return (
                <div
                  key={i}
                  className="group flex items-center gap-2 pl-3 pr-1 py-1.5 rounded-lg text-xs transition-all"
                  style={{
                    background: 'var(--bg-hover)',
                    border:     '1px solid var(--border-subtle)',
                    color:      'var(--text-secondary)',
                  }}
                >
                  <button
	                    onClick={() => canPreview ? setPreviewIdx(i) : window.open(attachmentsApi.url(hydratedEmail.id, i, { download: true }))}
                    className="flex items-center gap-2 min-w-0"
                    title={canPreview ? `Preview ${att.filename}` : `Download ${att.filename}`}
                  >
                    <PaperclipIcon size={11} className="flex-shrink-0" />
                    <span className="max-w-[180px] truncate text-[var(--text-primary)]">{att.filename}</span>
                    <span className="text-[var(--text-muted)] flex-shrink-0">
                      {formatAttachmentSize(att.size)}
                    </span>
                  </button>
                  {canPreview && (
                    <button
                      onClick={() => setPreviewIdx(i)}
                      title="Preview"
                      className="p-1 rounded transition-all opacity-0 group-hover:opacity-100 hover:bg-[var(--bg-overlay)]"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <EyeIcon size={11} />
                    </button>
                  )}
                  <a
	                    href={attachmentsApi.url(hydratedEmail.id, i, { download: true })}
                    download={att.filename}
                    title="Download"
                    className="p-1 rounded transition-all opacity-0 group-hover:opacity-100 hover:bg-[var(--bg-overlay)]"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <DownloadSimpleIcon size={11} />
                  </a>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <AttachmentPreview
        open={previewIdx !== null}
	        emailId={hydratedEmail.id}
	        index={previewIdx ?? 0}
	        attachment={previewIdx !== null ? (hydratedEmail.attachments[previewIdx] ?? null) : null}
        onClose={() => setPreviewIdx(null)}
      />
    </div>
  )
}

function formatAttachmentSize(bytes: number): string {
  if (!bytes) return ''
  if (bytes < 1024)            return `${bytes} B`
  if (bytes < 1024 * 1024)     return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function ActionBar({ email }: { email: Email }) {
  const { archiveEmail, deleteEmail, restoreEmail } = useEmailStore()
  const { openCompose, openSnoozeModal, toast } = useUiStore()
  const isDraft = email.isDraft || email.folder.toLowerCase().includes('draft')
  const canMoveToInbox =
    email.isArchived ||
    email.isTrashed ||
    email.isSpam ||
    (email.snoozedUntil ?? 0) > 0 ||
    email.folder.toLowerCase().includes('trash') ||
    email.folder.toLowerCase().includes('spam')

  const draftActions = [
    {
      icon: <PencilSimpleIcon size={14} />,
      label: 'Edit draft',
      shortcut: 'Enter',
      onClick: () => openCompose({ draftId: email.id }),
    },
    {
      icon: <TrashIcon size={14} />,
      label: 'Delete',
      shortcut: '#',
      onClick: () => { deleteEmail(email.id); toast('Draft deleted', { action: { label: 'Undo', fn: () => useEmailStore.getState().undoLast() } }) },
    },
  ]

  const messageActions = [
    {
      icon: <ArrowBendUpLeftIcon size={14} />,
      label: 'Reply',
      shortcut: 'R',
      onClick: () => openCompose({ replyToId: email.id }),
    },
    {
      icon: <ArrowBendDoubleUpLeftIcon size={14} />,
	      label: 'Reply all',
	      shortcut: 'A',
	      onClick: () => openCompose({ replyToId: email.id, replyAll: true }),
    },
    {
      icon: <ArrowBendUpRightIcon size={14} />,
      label: 'Forward',
      shortcut: 'F',
      onClick: () => openCompose({ forwardId: email.id }),
    },
    {
      icon: <ArchiveIcon size={14} />,
      label: 'Archive',
      shortcut: 'E',
      onClick: () => { archiveEmail(email.id); toast('Archived', { action: { label: 'Undo', fn: () => useEmailStore.getState().undoLast() } }) },
    },
    ...(canMoveToInbox ? [{
      icon: <TrayIcon size={14} />,
      label: 'Move to Inbox',
      shortcut: '',
      onClick: () => { restoreEmail(email.id); toast('Moved to inbox') },
    }] : []),
    {
      icon: <ClockIcon size={14} />,
      label: 'Snooze',
      shortcut: 'H',
      onClick: openSnoozeModal,
    },
    {
      icon: <TrashIcon size={14} />,
      label: 'Delete',
      shortcut: '#',
      onClick: () => { deleteEmail(email.id); toast('Deleted', { action: { label: 'Undo', fn: () => useEmailStore.getState().undoLast() } }) },
    },
  ]
  const actions = isDraft ? draftActions : messageActions
  const primaryAction = isDraft
    ? { label: 'Edit Draft', icon: <PencilSimpleIcon size={13} />, onClick: () => openCompose({ draftId: email.id }) }
    : { label: 'Reply', icon: <ArrowBendUpLeftIcon size={13} />, onClick: () => openCompose({ replyToId: email.id }) }

  return (
    <div
      className="flex items-center gap-1 px-4 py-3 border-t border-[var(--border-subtle)] flex-shrink-0 min-w-0"
      style={{ background: 'var(--bg-elevated)' }}
    >
      {/* Action buttons can shrink (and the kbd hint disappears on narrow
          widths) but the Reply button on the right is flex-shrink-0 so it
          is always visible regardless of pane width. */}
      <div className="flex items-center gap-1 flex-1 min-w-0 overflow-hidden">
        {actions.map(a => (
          <button
            key={a.label}
            onClick={a.onClick}
            title={a.shortcut ? `${a.label} (${a.shortcut})` : a.label}
            className="group flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-100 hover:bg-[var(--bg-hover)] flex-shrink-0"
            style={{ color: 'var(--text-secondary)' }}
          >
            <span style={{ color: 'var(--text-muted)' }}>{a.icon}</span>
            <span className="hidden md:inline">{a.label}</span>
            {/* `hidden` removes the kbd from layout entirely until hover —
                opacity-0 left a 20px ghost that pushed Reply off-screen. */}
            {a.shortcut && <kbd className="hidden group-hover:inline-flex">{a.shortcut}</kbd>}
          </button>
        ))}
      </div>

      {/* Reply button — never shrinks, never overlaps */}
      <button
        onClick={primaryAction.onClick}
        className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-medium transition-all duration-100 flex-shrink-0 ml-2"
        style={{
          background: 'var(--accent-faint)',
          border:     '1px solid var(--border-accent)',
          color:      'var(--accent)',
        }}
      >
        {primaryAction.icon}
        {primaryAction.label}
      </button>
    </div>
  )
}

interface EmailThreadProps {
  /** Optional override — when provided (e.g. from SearchView), takes precedence
      over the store's selected email which is scoped to the active folder's
      in-memory list. */
  email?: Email | null
}

export function EmailThread({ email: overrideEmail }: EmailThreadProps = {}) {
  const storeEmail = useEmailStore(selectSelectedEmail)
  const email = overrideEmail ?? storeEmail
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [threadEmails, setThreadEmails] = useState<Email[]>([])

  // Auto-expand the latest email
  useEffect(() => {
    if (email) setExpandedIds(new Set([email.id]))
  }, [email?.id])

  useEffect(() => {
    if (!email) {
      setThreadEmails([])
      return
    }
    let cancelled = false
    ;(async () => {
      const rows = await db.emails
        .where('threadId').equals(email.threadId)
        .filter(row => row.accountId === email.accountId)
        .sortBy('date')
      const ordered = rows.length > 0 ? rows : [email]
      if (!cancelled) setThreadEmails(ordered)
    })()
    return () => { cancelled = true }
  }, [email])

  if (!email) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 px-8">
        <div
          className="w-14 h-14 rounded-xl flex items-center justify-center"
          style={{ background: 'var(--accent-faint)', border: '1px solid var(--border-accent)' }}
        >
          <EnvelopeSimpleOpenIcon size={24} style={{ color: 'var(--accent)' }} />
        </div>
        <div className="text-center">
          <p className="text-sm font-medium text-[var(--text-secondary)] mb-1">No email selected</p>
          <p className="text-xs text-[var(--text-muted)]">
            Press <kbd>J</kbd> / <kbd>K</kbd> to navigate, <kbd>Space</kbd> to read
          </p>
        </div>
      </div>
    )
  }

  const visibleThread = threadEmails.length > 0 ? threadEmails : [email]
  const latestEmail = visibleThread[visibleThread.length - 1] ?? email
  const actionEmail = (email.isDraft || email.folder.toLowerCase().includes('draft')) ? email : latestEmail
  const toggle = (id: string) =>
    setExpandedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Subject */}
      <div
        className="px-6 py-4 border-b border-[var(--border-subtle)] flex-shrink-0"
        style={{ background: 'var(--bg-elevated)' }}
      >
        <h2
          className="text-base font-semibold text-[var(--text-primary)] leading-snug"
          style={{ letterSpacing: '-0.02em' }}
        >
	          {email.subject || '(no subject)'}
	        </h2>
        {visibleThread.length > 1 && (
          <div className="mt-1 text-[11px] text-[var(--text-muted)]">
            {visibleThread.length} messages in this conversation
          </div>
        )}
	      </div>

      {/* Thread body — scrollable */}
      <div className="flex-1 overflow-y-auto" data-email-preview-scroll>
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15, ease: [0.32, 0.72, 0, 1] }}
        >
          {visibleThread.map(message => {
            const isExpanded = expandedIds.has(message.id)
            return (
              <div key={message.id} className="border-b border-[var(--border-subtle)] last:border-b-0">
                <EmailHeader email={message} expanded={isExpanded} onToggle={() => toggle(message.id)} />
                <AnimatePresence initial={false}>
                  {isExpanded && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
                      style={{ overflow: 'hidden' }}
                    >
                      <EmailBody email={message} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )
          })}
	        </motion.div>
	      </div>

	      {/* Action bar */}
	      <ActionBar email={actionEmail} />
    </div>
  )
}
