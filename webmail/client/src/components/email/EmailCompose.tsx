import { useState, useRef, useEffect, useMemo, forwardRef, useImperativeHandle } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  XIcon, PaperPlaneRightIcon, PaperclipIcon, TrashIcon,
  ClockIcon, ArrowsOutIcon, ArrowsInIcon, UserIcon,
} from '@phosphor-icons/react'
import DOMPurify from 'dompurify'
import { useUiStore } from '@/store/uiStore'
import { useEmailStore } from '@/store/emailStore'
import { SnippetPicker } from '@/components/snippets/SnippetPicker'
import { getContacts, filterContacts, type RankedContact } from '@/lib/contacts'
import { queueEmail, processOutbox } from '@/lib/outbox'
import { emails as emailsApi } from '@/lib/api'
import { generateId } from '@/lib/utils'
import { db } from '@/db/db'
import type { Email, EmailAddress, Snippet } from '@/types/email'

// `;` opens the snippet picker. Tracked at module scope per ComposeWindow
// instance via React state below.
const SNIPPET_TRIGGER = ';'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\n/g, '<br/>')
}

interface Recipient { name: string; address: string; raw: string }

function toRecipient(address: EmailAddress): Recipient {
  return { name: address.name, address: address.address, raw: address.address }
}

function uniqueRecipients(addresses: EmailAddress[], exclude: string[] = []): Recipient[] {
  const seen = new Set(exclude.map(addr => addr.toLowerCase()))
  const out: Recipient[] = []
  for (const address of addresses) {
    const key = address.address.toLowerCase()
    if (!address.address || seen.has(key)) continue
    seen.add(key)
    out.push(toRecipient(address))
  }
  return out
}

interface RecipientFieldHandle {
  focus: () => void
}

const RecipientField = forwardRef<RecipientFieldHandle, {
  label: string
  recipients: Recipient[]
  onAdd: (r: Recipient) => void
  onRemove: (i: number) => void
  accountId?: string | null
}>(function RecipientField({ label, recipients, onAdd, onRemove, accountId = null }, ref) {
  const [input, setInput]       = useState('')
  const [contacts, setContacts] = useState<RankedContact[]>([])
  const [acOpen, setAcOpen]     = useState(false)
  const [acCursor, setAcCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }))

  // Lazy-load contacts the first time the user starts typing in this field.
  // getContacts() has its own 30s TTL cache + auto-invalidation on sync.
  useEffect(() => {
    if (input.length > 0 && contacts.length === 0) {
      getContacts(accountId).then(setContacts)
    }
  }, [input, contacts.length, accountId])

  // Filter the contact list. Hide anyone already in this field so we don't
  // suggest them twice.
  const suggestions = useMemo(() => {
    if (!input.trim()) return []
    const present = new Set(recipients.map(r => r.address.toLowerCase()))
    return filterContacts(contacts, input.trim(), 12)
      .filter(c => !present.has(c.address.toLowerCase()))
  }, [input, contacts, recipients])

  // Reset cursor when suggestions change
  useEffect(() => setAcCursor(0), [suggestions.length, input])
  useEffect(() => setAcOpen(suggestions.length > 0), [suggestions.length])

  const commitFromInput = () => {
    const addr = input.trim()
    if (!addr) return
    const m = addr.match(/^(.+?)\s*<(.+?)>$/)
    if (m) onAdd({ name: m[1].trim(), address: m[2].trim(), raw: addr })
    else   onAdd({ name: '', address: addr, raw: addr })
    setInput('')
    setAcOpen(false)
  }

  const commitFromContact = (c: RankedContact) => {
    onAdd({ name: c.name, address: c.address, raw: c.address })
    setInput('')
    setAcOpen(false)
    inputRef.current?.focus()
  }

  return (
    <div className="relative flex items-start gap-2 px-4 py-2 border-b border-[var(--border-subtle)]">
      <span className="text-xs font-medium text-[var(--text-muted)] pt-1 w-6 flex-shrink-0">
        {label}
      </span>
      <div className="flex flex-wrap gap-1 flex-1 min-w-0">
        {recipients.map((r, i) => (
          <span
            key={i}
            title={r.address}
            className="flex items-center gap-1 px-2 py-0.5 rounded-md text-xs"
            style={{
              background: 'var(--accent-faint)',
              border:     '1px solid var(--border-accent)',
              color:      'var(--accent)',
            }}
          >
            {r.name || r.address}
            <button
              onClick={() => onRemove(i)}
              className="hover:opacity-70 transition-opacity"
            >
              <XIcon size={10} weight="bold" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            // Autocomplete navigation has priority over the default
            // commit-on-Enter behaviour
            if (acOpen && suggestions.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setAcCursor(c => Math.min(c + 1, suggestions.length - 1))
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setAcCursor(c => Math.max(c - 1, 0))
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                commitFromContact(suggestions[acCursor])
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setAcOpen(false)
                return
              }
            }
            if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitFromInput() }
            if (e.key === 'Backspace' && !input && recipients.length > 0) onRemove(recipients.length - 1)
          }}
          onBlur={() => {
            // Slight delay so a click on the dropdown still registers
            setTimeout(() => {
              commitFromInput()
              setAcOpen(false)
            }, 120)
          }}
          onFocus={() => { if (suggestions.length > 0) setAcOpen(true) }}
          placeholder={recipients.length === 0 ? 'Add recipient…' : ''}
          className="flex-1 min-w-[120px] bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
        />
      </div>

      {/* Contact autocomplete dropdown */}
      {acOpen && suggestions.length > 0 && (
        <div
          className="absolute left-12 right-4 top-full z-30 mt-1 rounded-lg overflow-hidden"
          style={{
            background: 'var(--bg-overlay)',
            border:     '1px solid var(--border-strong)',
            boxShadow:  '0 12px 32px rgba(0,0,0,0.5)',
          }}
          onMouseDown={e => e.preventDefault()}    // keep input focused
        >
          <div className="max-h-[280px] overflow-y-auto py-1">
            {suggestions.map((c, i) => (
              <button
                key={c.address}
                onMouseEnter={() => setAcCursor(i)}
                onClick={() => commitFromContact(c)}
                className="w-full flex items-center gap-3 px-3 py-2 text-sm text-left transition-colors duration-75"
                style={{
                  background: acCursor === i ? 'var(--bg-active)' : 'transparent',
                  color:      'var(--text-primary)',
                }}
              >
                <UserIcon size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                <div className="flex-1 min-w-0">
                  {c.name && (
                    <div className="text-sm truncate">{c.name}</div>
                  )}
                  <div className={`text-xs truncate ${c.name ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>
                    {c.address}
                  </div>
                </div>
                {c.count > 1 && (
                  <span className="text-[10px] text-[var(--text-muted)] flex-shrink-0">
                    {c.count}×
                  </span>
                )}
                {acCursor === i && <kbd>↵</kbd>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
})

export function ComposeWindow() {
  const { composeOpen, composeReplyToId, composeForwardId, composeDraftId, composeReplyAll, closeCompose, toast } = useUiStore()
  const settings = useUiStore(s => s.settings)
  const setSetting = useUiStore(s => s.setSetting)
  const getActiveAccount = useEmailStore(s => s.getActiveAccount)
  const activeAccount = getActiveAccount()

  // Determine the right "default" full-screen state for this compose session
  const isReply = !!(composeReplyToId || composeForwardId)
  const wantFullScreen = isReply ? settings.replyFullScreen : settings.composeFullScreen

  // Per-session override (lets the user toggle within an open window without
  // changing their saved preference)
  const [fullScreen, setFullScreen] = useState(wantFullScreen)
  useEffect(() => { if (composeOpen) setFullScreen(wantFullScreen) }, [composeOpen, wantFullScreen])

  const [to, setTo] = useState<Recipient[]>([])
  const [cc, setCc] = useState<Recipient[]>([])
  const [bcc, setBcc] = useState<Recipient[]>([])
  const [showCc, setShowCc] = useState(false)
  const [showBcc, setShowBcc] = useState(false)
  const [subject, setSubject] = useState('')
  const [sourceEmail, setSourceEmail] = useState<Email | null>(null)
  const [draftKey, setDraftKey] = useState<string | null>(null)
  const draftKeyRef = useRef<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const toFieldRef = useRef<RecipientFieldHandle>(null)
  const [sending, setSending] = useState(false)
  const [undoSendTimer, setUndoSendTimer] = useState<number | null>(null)
  const undoCancelledRef = useRef(false)
  const [scheduledAt, setScheduledAt] = useState<number | null>(null)

  // ─ Snippet picker state ───────────────────────────────────────────────────
  // We remember (a) where in the DOM the trigger `;` was inserted so we can
  // splice the typed query out and the snippet body in, and (b) the live
  // query the user types after the trigger for filtering.
  const [snippetOpen,   setSnippetOpen]   = useState(false)
  const [snippetAnchor, setSnippetAnchor] = useState<{ x: number; y: number } | null>(null)
  const [snippetQuery,  setSnippetQuery]  = useState('')
  // Range covering the trigger `;` + any chars typed after it. We replace
  // this range when the snippet is inserted.
  const triggerRangeRef = useRef<Range | null>(null)
  const triggerStartRef = useRef<{ node: Node; offset: number } | null>(null)

  useEffect(() => {
    if (!composeOpen) {
      setSourceEmail(null)
      setDraftKey(null)
      draftKeyRef.current = null
      return
    }
    const sourceId = composeReplyToId ?? composeForwardId ?? composeDraftId
    if (!activeAccount) return
    draftKeyRef.current = composeDraftId
      ? `${activeAccount.id}:edit-draft:${composeDraftId}`
      : sourceId
      ? `${activeAccount.id}:${sourceId}`
      : `${activeAccount.id}:new:${generateId()}`
    setDraftKey(draftKeyRef.current)

    let cancelled = false
    ;(async () => {
      let source = sourceId ? await db.emails.get(sourceId) : null
      if (composeDraftId && source && !source.bodyHtml && !source.bodyText) {
        source = await emailsApi.get(composeDraftId)
        await db.emails.put(source)
      }
      if (!cancelled) setSourceEmail(source ?? null)
    })()
    return () => { cancelled = true }
  }, [composeOpen, composeReplyToId, composeForwardId, composeDraftId, activeAccount?.id])

  // Pre-fill for replies/forwards/new
  useEffect(() => {
    if (!composeOpen) return
    if (composeDraftId && sourceEmail) {
      setTo(sourceEmail.to.map(toRecipient))
      setCc(sourceEmail.cc.map(toRecipient))
      setBcc(sourceEmail.bcc.map(toRecipient))
      setShowCc(sourceEmail.cc.length > 0)
      setShowBcc(sourceEmail.bcc.length > 0)
      setSubject(sourceEmail.subject)
      if (bodyRef.current) {
        bodyRef.current.innerHTML = DOMPurify.sanitize(sourceEmail.bodyHtml || escapeHtml(sourceEmail.bodyText))
      }
	    } else if (composeReplyToId && sourceEmail) {
      const ownAddress = activeAccount?.email ?? ''
      const baseTo = [sourceEmail.replyTo ?? sourceEmail.from]
      setTo(composeReplyAll
        ? uniqueRecipients([...baseTo, ...sourceEmail.to], [ownAddress])
        : uniqueRecipients(baseTo, [ownAddress]))
      setCc(composeReplyAll ? uniqueRecipients(sourceEmail.cc, [ownAddress, ...baseTo.map(a => a.address)]) : [])
      setBcc([])
      setShowCc(composeReplyAll && sourceEmail.cc.length > 0)
      setShowBcc(false)
	      setSubject(sourceEmail.subject.startsWith('Re:') ? sourceEmail.subject : `Re: ${sourceEmail.subject}`)
	      if (bodyRef.current) {
	        const quoted = DOMPurify.sanitize(sourceEmail.bodyHtml || escapeHtml(sourceEmail.bodyText))
	        bodyRef.current.innerHTML = `<br/><br/><blockquote style="border-left:3px solid rgba(143,179,255,0.25);margin:8px 0;padding:4px 0 4px 16px;color:rgba(240,241,242,0.6)">${quoted}</blockquote>`
	      }
	    } else if (composeForwardId && sourceEmail) {
	      setTo([])
      setCc([])
      setBcc([])
      setShowCc(false)
      setShowBcc(false)
	      setSubject(sourceEmail.subject.startsWith('Fwd:') ? sourceEmail.subject : `Fwd: ${sourceEmail.subject}`)
	      if (bodyRef.current) {
	        const quoted = DOMPurify.sanitize(sourceEmail.bodyHtml || escapeHtml(sourceEmail.bodyText))
	        bodyRef.current.innerHTML = `<br/><br/><blockquote style="border-left:3px solid rgba(143,179,255,0.25);margin:8px 0;padding:4px 0 4px 16px;color:rgba(240,241,242,0.6)"><strong>Forwarded message:</strong><br/>${quoted}</blockquote>`
	      }
	    } else {
	      setTo([])
	      setCc([])
      setBcc([])
      setShowCc(false)
      setShowBcc(false)
	      setSubject('')
	      if (bodyRef.current) bodyRef.current.innerHTML = ''
	    }
	    setScheduledAt(null)
	  }, [composeOpen, composeReplyToId, composeForwardId, composeDraftId, composeReplyAll, sourceEmail, activeAccount?.email])

  useEffect(() => {
    if (!composeOpen || !draftKey) return
    let cancelled = false
    ;(async () => {
      const draft = await db.drafts.get(draftKey)
      if (!draft || cancelled) return
      setTo(draft.to.map(a => ({ ...a, raw: a.address })))
      setCc((draft.cc ?? []).map(a => ({ ...a, raw: a.address })))
      setBcc((draft.bcc ?? []).map(a => ({ ...a, raw: a.address })))
      setShowCc((draft.cc ?? []).length > 0)
      setShowBcc((draft.bcc ?? []).length > 0)
      setSubject(draft.subject)
      setScheduledAt(draft.scheduledSendAt ?? null)
      if (bodyRef.current) bodyRef.current.innerHTML = DOMPurify.sanitize(draft.bodyHtml)
    })()
    return () => { cancelled = true }
  }, [composeOpen, draftKey])

	  useEffect(() => {
	    if (!composeOpen || !activeAccount || !draftKey) return
	    const timer = window.setInterval(async () => {
	      const bodyHtml = bodyRef.current?.innerHTML ?? ''
	      if (to.length === 0 && cc.length === 0 && bcc.length === 0 && !subject.trim() && !bodyHtml.trim()) return
	      await db.drafts.put({
	        id: draftKey,
	        accountId: activeAccount.id,
	        replyToId: composeReplyToId ?? undefined,
	        forwardOfId: composeForwardId ?? undefined,
	        draftSourceId: composeDraftId ?? undefined,
	        to: to.map(r => ({ name: r.name, address: r.address })),
	        cc: cc.map(r => ({ name: r.name, address: r.address })),
	        bcc: bcc.map(r => ({ name: r.name, address: r.address })),
	        subject,
        bodyHtml,
        attachments: [],
        savedAt: Date.now(),
        scheduledSendAt: scheduledAt ?? undefined,
      })
	    }, 2500)
	    return () => window.clearInterval(timer)
	  }, [composeOpen, activeAccount, draftKey, composeReplyToId, composeForwardId, composeDraftId, to, cc, bcc, subject, scheduledAt])

  // Focus the right field after the open animation settles. New compose and
  // forward go to the To input; replies go to the body so the user can start
  // typing their response immediately.
  useEffect(() => {
    if (!composeOpen) return
    const focusTo = !composeReplyToId && !composeDraftId // new compose OR forward
    const focusBody = !!composeReplyToId || !!composeDraftId
    const t = setTimeout(() => {
      if (focusTo) {
        toFieldRef.current?.focus()
      } else if (focusBody && bodyRef.current) {
        bodyRef.current.focus()
        // Place caret at start of body so user types ABOVE the quote
        const range = document.createRange()
        range.setStart(bodyRef.current, 0)
        range.collapse(true)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
    }, 220) // matches the motion `duration: 0.18` + a hair of buffer
    return () => clearTimeout(t)
  }, [composeOpen, composeReplyToId, composeForwardId, composeDraftId])

	  const sendEmail = async () => {
	    if (!activeAccount || to.length === 0) return

	    const bodyHtml = bodyRef.current?.innerHTML ?? ''
	    const bodyText = bodyRef.current?.innerText ?? ''
      const editedDraftId = composeDraftId
	    const payload = {
		      accountId: activeAccount.id,
		      to: to.map(r => ({ name: r.name, address: r.address })),
		      cc: cc.map(r => ({ name: r.name, address: r.address })),
        bcc: bcc.map(r => ({ name: r.name, address: r.address })),
		      subject,
	      bodyHtml: DOMPurify.sanitize(bodyHtml),
	      bodyText,
	      replyToId: composeReplyToId ?? undefined,
	      forwardOfId: composeForwardId ?? undefined,
	      draftSourceId: composeDraftId ?? undefined,
	    }

		    if (scheduledAt && scheduledAt > Date.now() + 5000) {
		      await queueEmail(payload, scheduledAt)
        if (draftKeyRef.current) await db.drafts.delete(draftKeyRef.current)
		      toast(`Scheduled for ${new Date(scheduledAt).toLocaleString()}`)
		      closeCompose()
	      return
	    }

	    toast('Sending in 5s…', {
	      action: { label: 'Undo', fn: () => { undoCancelledRef.current = true } },
	      duration: 5500,
	    })
	    closeCompose()

	    const timer = window.setTimeout(async () => {
	      if (undoCancelledRef.current) { undoCancelledRef.current = false; return }
	      setSending(true)
		      try {
		        await queueEmail(payload, Date.now())
		        const result = await processOutbox()
            if (result.failed > 0) throw new Error('Outbox send failed')
            if (draftKeyRef.current) await db.drafts.delete(draftKeyRef.current)
            if (editedDraftId) await db.emails.delete(editedDraftId)
	        toast('Sent')
      } catch (err) {
        toast('Failed to send — check your connection')
        console.error(err)
      } finally {
        setSending(false)
      }
    }, 5000)
    setUndoSendTimer(timer)
  }

  useEffect(() => () => { if (undoSendTimer) clearTimeout(undoSendTimer) }, [undoSendTimer])

  // Cmd+Enter to send
  useEffect(() => {
    if (!composeOpen) return
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        sendEmail()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [composeOpen, to, subject, sending]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─ Snippet picker handlers ────────────────────────────────────────────────

  const closeSnippetPicker = () => {
    setSnippetOpen(false)
    setSnippetAnchor(null)
    setSnippetQuery('')
    triggerRangeRef.current = null
    triggerStartRef.current = null
  }

  const openSnippetPicker = () => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0).cloneRange()
    // Anchor the picker at the caret's screen position
    const rect = range.getBoundingClientRect()
    // For collapsed selections at start of an empty line, getBoundingClientRect
    // may return zeroes — fall back to the body element rect.
    const x = rect.left || (bodyRef.current?.getBoundingClientRect().left ?? 100)
    const y = rect.bottom || (bodyRef.current?.getBoundingClientRect().top ?? 100)
    triggerStartRef.current = { node: range.startContainer, offset: range.startOffset }
    setSnippetAnchor({ x, y })
    setSnippetQuery('')
    setSnippetOpen(true)
  }

  // Watch keystrokes inside the contentEditable body to detect / extend the
  // trigger and to cancel it when the caret leaves the trigger zone.
  const onBodyKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Markdown shortcuts
    if (e.key === 'b' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); document.execCommand('bold'); return }
    if (e.key === 'i' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); document.execCommand('italic'); return }

    if (snippetOpen) {
      // Backspace: trim the query; close picker if we delete past the `;`
      if (e.key === 'Backspace') {
        if (snippetQuery.length === 0) {
          // Caret is sitting just after `;` — let the default backspace remove
          // the trigger and close the picker.
          closeSnippetPicker()
          return
        }
        setSnippetQuery(q => q.slice(0, -1))
        return
      }
      // Plain printable char extends the query (Enter / Tab / Esc are
      // handled by the picker's own window-level listener)
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setSnippetQuery(q => q + e.key)
        return
      }
      // Whitespace / arrow keys cancel
      if (e.key === ' ' || e.key.startsWith('Arrow')) {
        closeSnippetPicker()
        return
      }
      return
    }

    if (e.key === SNIPPET_TRIGGER) {
      // Defer to next tick so the `;` actually lands in the DOM before we
      // anchor the picker. We don't preventDefault — keeping the visible
      // `;` gives the user clear feedback.
      setTimeout(openSnippetPicker, 0)
    }
  }

  /**
   * Replace the typed `;query` range with the snippet's HTML body and place
   * the caret at the end of the inserted content.
   */
  const insertSnippet = (snippet: Snippet) => {
    if (!bodyRef.current) { closeSnippetPicker(); return }
    const start = triggerStartRef.current
    if (!start) { closeSnippetPicker(); return }

    const sel = window.getSelection()
    if (!sel) { closeSnippetPicker(); return }

    // Build a range from the `;` (start) to the current caret (end).
    // We re-locate the current caret via the live selection rather than the
    // stored range so it's always up to date with what the user typed.
    const liveRange = sel.rangeCount > 0 ? sel.getRangeAt(0) : null
    if (!liveRange) { closeSnippetPicker(); return }

    const range = document.createRange()
    try {
      range.setStart(start.node, start.offset)
      range.setEnd(liveRange.endContainer, liveRange.endOffset)
    } catch {
      closeSnippetPicker(); return
    }

    range.deleteContents()

    // Insert the snippet body as parsed HTML so blockquotes / line breaks
    // render correctly. We use a temporary container so we can place the
    // caret after the LAST inserted node.
    const tmp = document.createElement('div')
	    tmp.innerHTML = DOMPurify.sanitize(snippet.body)
    const frag = document.createDocumentFragment()
    let lastNode: ChildNode | null = null
    while (tmp.firstChild) {
      lastNode = tmp.firstChild
      frag.appendChild(tmp.firstChild)
    }
    range.insertNode(frag)

    // Caret after the inserted content
    if (lastNode) {
      const caret = document.createRange()
      caret.setStartAfter(lastNode)
      caret.collapse(true)
      sel.removeAllRanges()
      sel.addRange(caret)
    }

    closeSnippetPicker()
    bodyRef.current.focus()
  }

  // Toggle the per-session full-screen mode AND save the preference so it
  // becomes the new default for this session type.
  const toggleFullScreen = () => {
    const next = !fullScreen
    setFullScreen(next)
    if (isReply) setSetting('replyFullScreen', next)
    else         setSetting('composeFullScreen', next)
  }

  const discardCompose = async () => {
    const key = draftKeyRef.current
    if (key) await db.drafts.delete(key)

    if (composeDraftId) {
      const store = useEmailStore.getState()
      const activeState = activeAccount ? store.accountStates[activeAccount.id] : null
      const isVisibleDraft = activeState?.emails.some(e => e.id === composeDraftId)

      if (isVisibleDraft) {
        await store.deleteEmail(composeDraftId)
      } else {
        const draft = await db.emails.get(composeDraftId)
        await db.emails.delete(composeDraftId)
        try {
          await emailsApi.trash([composeDraftId])
        } catch (err) {
          if (draft) await db.emails.put({ ...draft, isTrashed: true })
          toast('Draft delete will retry when the server is reachable')
          console.error(err)
        }
      }
      toast('Draft discarded')
    }

    closeCompose()
  }

  const titleText =
    composeDraftId ? 'Edit Draft' :
    composeReplyToId ? 'Reply' :
    composeForwardId ? 'Forward' :
    'New Message'

  // ─ Layout: full-screen vs corner panel ─────────────────────────────────────
  const containerStyle = fullScreen
    ? {
        // Sit inside main-area: top bar is 44px, sidebar is on the left of
        // .app-shell so we anchor to the right of the sidebar.
        position: 'fixed' as const,
        top: 0, right: 0, bottom: 0,
        left: 'var(--sidebar-width)',
        background: 'var(--bg-base)',
        borderLeft: '1px solid var(--border-subtle)',
        boxShadow: '-12px 0 60px rgba(0,0,0,0.5)',
        zIndex: 50,
      }
    : {
        position: 'fixed' as const,
        bottom: 0, right: 24,
        width: 540,
        maxHeight: '80vh',
        background: 'var(--bg-overlay)',
        border: '1px solid var(--border-strong)',
        borderBottom: 'none',
        borderRadius: '12px 12px 0 0',
        boxShadow: '0 -8px 40px rgba(0,0,0,0.5)',
        zIndex: 50,
      }

  // Animation parameters — fade-in for fullscreen, slide-up for corner panel
  const motionProps = fullScreen
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit:    { opacity: 0 },
      }
    : {
        initial: { opacity: 0, y: 20, scale: 0.97 },
        animate: { opacity: 1, y: 0,  scale: 1 },
        exit:    { opacity: 0, y: 16, scale: 0.97 },
      }

  return (
    <AnimatePresence>
      {composeOpen && (
        <motion.div
          className="flex flex-col"
          {...motionProps}
          transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
          style={containerStyle}
        >
          {/* Title bar */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-subtle)]">
            <span className="text-sm font-semibold text-[var(--text-primary)]">{titleText}</span>
            <div className="flex items-center gap-1">
              <button
                onClick={toggleFullScreen}
                className="p-1.5 rounded-lg hover:bg-[var(--bg-hover)] transition-colors"
                style={{ color: 'var(--text-muted)' }}
                title={fullScreen ? 'Shrink to corner' : 'Open full screen'}
              >
                {fullScreen ? <ArrowsInIcon size={13} /> : <ArrowsOutIcon size={13} />}
              </button>
              <button
                onClick={discardCompose}
                className="p-1.5 rounded-lg hover:bg-[var(--bg-hover)] transition-colors"
                style={{ color: 'var(--text-muted)' }}
                title={composeDraftId ? 'Discard draft' : 'Discard'}
              >
                <TrashIcon size={13} weight="regular" />
              </button>
              <button
                onClick={closeCompose}
                className="p-1.5 rounded-lg hover:bg-[var(--bg-hover)] transition-colors"
                style={{ color: 'var(--text-muted)' }}
                title="Close (Esc)"
              >
                <XIcon size={13} weight="bold" />
              </button>
            </div>
          </div>

          {/* Content scroll container */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Recipients */}
            <RecipientField
              ref={toFieldRef}
              label="To" recipients={to}
              accountId={activeAccount?.id ?? null}
              onAdd={r => setTo(p => [...p, r])}
              onRemove={i => setTo(p => p.filter((_, j) => j !== i))}
            />

	            {showCc && (
	              <RecipientField
	                label="Cc" recipients={cc}
	                accountId={activeAccount?.id ?? null}
	                onAdd={r => setCc(p => [...p, r])}
	                onRemove={i => setCc(p => p.filter((_, j) => j !== i))}
	              />
	            )}

            {showBcc && (
              <RecipientField
                label="Bcc" recipients={bcc}
                accountId={activeAccount?.id ?? null}
                onAdd={r => setBcc(p => [...p, r])}
                onRemove={i => setBcc(p => p.filter((_, j) => j !== i))}
              />
            )}

	            {(!showCc || !showBcc) && (
	              <button
	                onClick={() => {
                  if (!showCc) setShowCc(true)
                  else setShowBcc(true)
                }}
	                className="text-xs text-[var(--text-muted)] px-4 py-1 hover:text-[var(--text-secondary)] transition-colors text-left flex-shrink-0"
	              >
	                {!showCc ? '+ Cc' : '+ Bcc'}
	              </button>
	            )}

            {/* Subject */}
            <div className="px-4 py-2 border-b border-[var(--border-subtle)] flex-shrink-0">
              <input
                type="text"
                value={subject}
                onChange={e => setSubject(e.target.value)}
                placeholder="Subject"
                className="w-full bg-transparent text-sm font-medium text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
              />
            </div>

            {/* Body */}
            <div
              ref={bodyRef}
              contentEditable
              suppressContentEditableWarning
              data-placeholder="Write your message… try ; for a snippet, **bold**, *italic*"
              className="compose-editor flex-1 px-4 py-3 overflow-y-auto"
              style={{ minHeight: fullScreen ? 'auto' : 160, maxHeight: fullScreen ? 'none' : 340 }}
              onKeyDown={onBodyKeyDown}
            />
          </div>

          {/* Snippet picker (anchored to caret) */}
          <SnippetPicker
            open={snippetOpen}
            anchor={snippetAnchor}
            query={snippetQuery}
            onSelect={insertSnippet}
            onCancel={closeSnippetPicker}
          />

          {/* Footer */}
          <div
            className="flex items-center gap-2 px-4 py-3 border-t border-[var(--border-subtle)] flex-shrink-0"
            style={{ background: 'rgba(0,0,0,0.2)' }}
          >
            <button
              onClick={sendEmail}
              disabled={sending || to.length === 0}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-100 disabled:opacity-40"
              style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
            >
              <PaperPlaneRightIcon size={13} weight="bold" />
              {sending ? 'Sending…' : 'Send'}
              <kbd style={{ background: 'rgba(11,18,32,0.18)', color: 'var(--accent-contrast)', borderColor: 'rgba(11,18,32,0.28)' }}>
                ⌘↵
              </kbd>
            </button>

	            <button
	              onClick={() => {
	                const next = scheduledAt
	                  ? null
	                  : Date.now() + 60 * 60_000
	                setScheduledAt(next)
	                if (next) toast('Send scheduled for 1 hour from now')
	              }}
	              className="p-2 rounded-lg hover:bg-[var(--bg-hover)] transition-colors"
	              style={{ color: scheduledAt ? 'var(--accent)' : 'var(--text-muted)' }}
	              title={scheduledAt ? 'Scheduled send enabled' : 'Schedule send for 1 hour from now'}
	            >
	              <ClockIcon size={14} />
	            </button>

	            <button
              type="button"
              disabled
	              className="p-2 rounded-lg transition-colors opacity-40 cursor-not-allowed"
	              style={{ color: 'var(--text-muted)' }}
	              title="Attachments are read-only for now"
	            >
              <PaperclipIcon size={14} />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
