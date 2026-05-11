import { useEffect, useCallback, useRef } from 'react'
import { useEmailStore } from '@/store/emailStore'
import { useUiStore } from '@/store/uiStore'
import { isInputFocused } from '@/lib/utils'

// ─── Two-key sequence state ───────────────────────────────────────────────────
// For Vim-style g+i, g+s etc. We track the first key and reset after 500ms.

let pendingKey: string | null = null
let pendingTimer: ReturnType<typeof setTimeout> | null = null

function setPending(key: string, onExpire?: () => void) {
  if (pendingTimer) clearTimeout(pendingTimer)
  pendingKey = key
  pendingTimer = setTimeout(() => {
    pendingKey = null
    onExpire?.()
  }, 500)
}

function consumePending(): string | null {
  const k = pendingKey
  pendingKey = null
  if (pendingTimer) clearTimeout(pendingTimer)
  return k
}

function scrollEmailPreview(direction: 1 | -1) {
  const pane = document.querySelector<HTMLElement>('[data-email-preview-scroll]')
  if (!pane) return false

  const step = Math.max(160, Math.min(420, Math.round(pane.clientHeight * 0.6)))
  pane.scrollBy({ top: direction * step, behavior: 'smooth' })
  return true
}

function moveListBy(store: ReturnType<typeof useEmailStore.getState>, count: number) {
  const move = count > 0 ? store.focusNext : store.focusPrev
  for (let i = 0; i < Math.abs(count); i += 1) move()
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useGlobalKeyboard() {
  const store = useEmailStore()
  // Selected email lives inside per-account state — pull it via selector.
  const selectedEmail = useEmailStore(s => {
    const state = s.accountStates[s.activeAccountId ?? '']
    return state?.emails.find(email => email.id === state.selectedId) ?? null
  })
  const selectedId = selectedEmail?.id ?? null
  const ui = useUiStore()

  const handler = useCallback((e: KeyboardEvent) => {
    // Let the browser handle shortcuts when a modal / overlay is open
    if (ui.commandPaletteOpen || ui.shortcutsOverlayOpen || ui.composeOpen || ui.snoozeModalOpen || ui.labelDialogOpen) {
      if (e.key === 'Escape') {
        ui.closeCommandPalette()
        ui.closeShortcuts()
        ui.closeCompose()
        ui.closeSnoozeModal()
        ui.closeLabelDialog()
        ui.setSearchMode(false)
      }
      return
    }

    // Cmd/Ctrl+K → command palette
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault()
      ui.openCommandPalette()
      return
    }

    // Cmd/Ctrl+Z → undo
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
      e.preventDefault()
      store.undoLast()
      return
    }

    // Block single-key shortcuts when typing in an input
    if (isInputFocused()) return

    const key = e.key

    // ─── Two-key sequences ────────────────────────────────────────────────
    const prev = consumePending()
    if (prev) ui.setKeyHint(null)
    if (prev === 'g') {
      switch (key) {
        case 'i': store.setActiveFolder('INBOX'); return
        case 's': store.setActiveFolder('Starred'); return
        case 't': store.setActiveFolder('Sent'); return
        case 'd': store.setActiveFolder('Drafts'); return
        case 'e': store.setActiveFolder('Trash'); return
        default: break
      }
    }

	    // ─── Single key shortcuts ─────────────────────────────────────────────
	    switch (key) {
      case ' ': {
        e.preventDefault()
        scrollEmailPreview(e.shiftKey ? -1 : 1)
        break
      }
      case 'Tab': {
        e.preventDefault()
        if (e.shiftKey) store.focusPrevSplit()
        else store.focusNextSplit()
        break
      }
      case '1': store.setActiveSplit('all'); break
      case '2': store.setActiveSplit('important'); break
      case '3': store.setActiveSplit('other'); break
      case '4': store.setActiveSplit('calendar'); break
      case '5': store.setActiveSplit('news'); break
	      // Navigation
	      case 'j': store.focusNext(); break
      case 'k': store.focusPrev(); break
      case 'J': moveListBy(store, 6); break
      case 'K': moveListBy(store, -6); break
      case 'Enter': store.openFocused(); break
      case 'u': store.selectEmail(null); break

      // Actions
      case 'e': {
        e.preventDefault()
        const canMoveToInbox = !!selectedEmail && (
          selectedEmail.isArchived ||
          selectedEmail.isTrashed ||
          selectedEmail.isSpam ||
          (selectedEmail.snoozedUntil ?? 0) > 0 ||
          selectedEmail.folder.toLowerCase().includes('trash') ||
          selectedEmail.folder.toLowerCase().includes('spam')
        )
        if (canMoveToInbox) {
          store.restoreEmail()
          ui.toast('Moved to inbox')
        } else if (!(selectedEmail?.isDraft || selectedEmail?.folder.toLowerCase().includes('draft'))) {
          store.archiveEmail()
          ui.toast('Archived', { action: { label: 'Undo', fn: () => store.undoLast() } })
        }
        break
      }
      case '#': {
        e.preventDefault()
        store.deleteEmail()
        ui.toast('Deleted', { action: { label: 'Undo', fn: () => store.undoLast() } })
        break
      }
      case 's': store.starEmail(); break
      case '!': store.markSpam(); break
      case 'm': {
        store.muteThread()
        ui.toast('Thread muted and archived')
        break
      }
      case 'h': ui.openSnoozeModal(); break
      case 'l': {
        e.preventDefault()
        ui.openLabelDialog()
        break
      }

      case 'U': {   // Shift+U
        e.preventDefault()
        store.markUnread()
        ui.toast('Marked as unread')
        break
      }

      // Compose
      case 'c': ui.openCompose(); break
      case 'r': {
        const sel = selectedId
        if (sel && !(selectedEmail?.isDraft || selectedEmail?.folder.toLowerCase().includes('draft'))) ui.openCompose({ replyToId: sel })
        break
      }
	      case 'a': {
	        const sel = selectedId
	        if (sel && !(selectedEmail?.isDraft || selectedEmail?.folder.toLowerCase().includes('draft'))) ui.openCompose({ replyToId: sel, replyAll: true })
	        break
	      }
      case 'f': {
        const sel = selectedId
        if (sel && !(selectedEmail?.isDraft || selectedEmail?.folder.toLowerCase().includes('draft'))) ui.openCompose({ forwardId: sel })
        break
      }

      // Search
	      case '/': {
	        e.preventDefault()
	        ui.openSearchView('')
	        break
	      }

      // Help
      case '?': ui.openShortcuts(); break

      // g prefix
	      case 'g':
          ui.setKeyHint('g')
          setPending('g', () => useUiStore.getState().setKeyHint(null))
          break

      default: break
    }
  }, [store, ui, selectedEmail, selectedId])

  useEffect(() => {
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handler])
}

// ─── Per-component shortcut binding ──────────────────────────────────────────

type KeyMap = Record<string, (e: KeyboardEvent) => void>

export function useKeyMap(map: KeyMap, active = true) {
  const ref = useRef(map)
  ref.current = map

  useEffect(() => {
    if (!active) return
    const handler = (e: KeyboardEvent) => {
      const fn = ref.current[e.key]
      if (fn) fn(e)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [active])
}
