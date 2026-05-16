import { useState, useEffect, useRef } from 'react'
import { MagnifyingGlassIcon, KeyboardIcon, ArrowClockwiseIcon, SignOutIcon, ArrowsClockwiseIcon, ListIcon, ArrowLeftIcon, DotsThreeVerticalIcon } from '@phosphor-icons/react'
import { useEmailStore, selectActiveState } from '@/store/emailStore'
import { useUiStore } from '@/store/uiStore'
import { useLabelsStore } from '@/store/labelsStore'
import { isDpanelMode } from '@/lib/clientConfig'
import { dpanelAuth } from '@/lib/api'
import { db } from '@/db/db'

export function TopBar() {
	  const { activeFolder, isLoading } = useEmailStore(selectActiveState)
	  const triggerSync = useEmailStore(s => s.triggerSync)
	  const preloadAllMail = useEmailStore(s => s.preloadAllMail)
	  const syncProgress = useEmailStore(s => s.syncProgress)
	  const syncStatus = useEmailStore(s => s.syncStatus)
  const openSearch = useUiStore(s => s.openSearchView)
  const openShortcuts = useUiStore(s => s.openShortcuts)
  const toggleMobileNav = useUiStore(s => s.toggleMobileNav)
  const labels = useLabelsStore(s => s.labels)

  // Mobile back-arrow: when a thread is open, render a back button that
  // clears the selection. CSS hides this on desktop via .mobile-only.
  const selectEmail = useEmailStore(s => s.selectEmail)
  const threadOpen  = useEmailStore(s => {
    const id = s.activeAccountId
    return !!id && !!s.accountStates[id]?.selectedId
  })

  // Mobile-only overflow menu (Cache mail / Shortcuts / Switch-to-classic /
  // Sign out). Sync stays first-class because it's the most-used. Closes on
  // outside click or after any item runs.
  const [overflowOpen, setOverflowOpen] = useState(false)
  const overflowRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!overflowOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOverflowOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [overflowOpen])
  const closeOverflow = () => setOverflowOpen(false)

  const folderLabel =
    activeFolder === 'snoozed'
      ? 'Snoozed'
      : typeof activeFolder === 'object' && activeFolder.kind === 'label'
      ? (labels.find(l => l.id === activeFolder.id)?.name ?? 'Label')
      : (activeFolder as string).charAt(0).toUpperCase() + (activeFolder as string).slice(1)

  return (
    <header
      className="topbar-drag-region flex items-center gap-3 px-4 h-11 flex-shrink-0 border-b border-[var(--border-subtle)]"
      style={{ background: 'var(--bg-elevated)' }}
    >
      {/* Mobile-only: back arrow (when thread open) or hamburger.
          CSS toggles visibility — desktop never sees these. */}
      {threadOpen ? (
        <button
          onClick={() => selectEmail(null)}
          className="mobile-only mobile-back-button"
          aria-label="Back to inbox"
          title="Back"
          data-no-drag="true"
        >
          <ArrowLeftIcon size={18} weight="regular" />
        </button>
      ) : (
        <button
          onClick={toggleMobileNav}
          className="mobile-only mobile-back-button"
          aria-label="Open navigation"
          title="Menu"
          data-no-drag="true"
        >
          <ListIcon size={18} weight="regular" />
        </button>
      )}

      {/* Folder name */}
      <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight min-w-[80px]">
        {folderLabel}
      </h1>

      {/* Search trigger */}
      <button
	        onClick={() => openSearch('')}
        className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-[var(--text-muted)] transition-colors duration-100 hover:bg-[var(--bg-hover)] max-w-xs"
        style={{ border: '1px solid var(--border-subtle)' }}
      >
        <MagnifyingGlassIcon size={13} weight="regular" />
	        <span>Search mail</span>
        <span className="ml-auto flex items-center gap-0.5">
	          <kbd>/</kbd>
        </span>
      </button>

	      {syncProgress != null && (
	        <div className="hidden md:flex items-center gap-2 min-w-[180px] max-w-[260px]" data-no-drag="true">
	          <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: 'var(--bg-overlay)' }}>
	            <div
	              className="h-full rounded-full transition-all"
	              style={{ width: `${syncProgress}%`, background: 'var(--accent)' }}
	            />
	          </div>
	          <span className="text-[11px] text-[var(--text-muted)] truncate" title={syncStatus ?? undefined}>
	            {syncStatus ?? `${syncProgress}%`}
	          </span>
	        </div>
	      )}

	      <div className="flex items-center gap-1 ml-auto">
        {/* Sync — always first-class, both mobile and desktop. */}
        <button
          onClick={() => triggerSync()}
          className="p-1.5 rounded-lg transition-colors duration-100 hover:bg-[var(--bg-hover)]"
          style={{ color: 'var(--text-muted)' }}
	          title="Sync now"
          aria-label="Sync now"
        >
          <ArrowClockwiseIcon
            size={14}
            weight="regular"
            className={isLoading ? 'animate-spin' : ''}
          />
	        </button>

        {/* Desktop-only buttons. The same items live inside the mobile
            overflow menu below. */}
	        <button
	          onClick={() => preloadAllMail(undefined, 'full')}
	          className="desktop-only px-2 py-1.5 rounded-lg transition-colors duration-100 hover:bg-[var(--bg-hover)] text-[11px]"
	          style={{ color: 'var(--text-muted)' }}
		          title="Build local mail cache"
		          aria-label="Build local mail cache"
		        >
		          Cache mail
	        </button>

        <button
          onClick={openShortcuts}
          className="desktop-only p-1.5 rounded-lg transition-colors duration-100 hover:bg-[var(--bg-hover)]"
          style={{ color: 'var(--text-muted)' }}
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
        >
          <KeyboardIcon size={14} weight="regular" />
        </button>

        {isDpanelMode() && (
          <>
            <button
              onClick={() => {
                document.cookie = `webmail_mode=classic; max-age=${30 * 24 * 60 * 60}; path=/; SameSite=Lax`
                window.location.reload()
              }}
              className="desktop-only p-1.5 rounded-lg transition-colors duration-100 hover:bg-[var(--bg-hover)]"
              style={{ color: 'var(--text-muted)' }}
              title="Switch to classic webmail"
              aria-label="Switch to classic webmail"
            >
              <ArrowsClockwiseIcon size={14} weight="regular" />
            </button>
            <button
              onClick={async () => {
                try { await dpanelAuth.logout() } catch { /* still wipe local state */ }
                try { await db.delete() } catch { /* idb may already be gone */ }
                window.location.reload()
              }}
              className="desktop-only p-1.5 rounded-lg transition-colors duration-100 hover:bg-[var(--bg-hover)]"
              style={{ color: 'var(--text-muted)' }}
              title="Sign out"
              aria-label="Sign out"
            >
              <SignOutIcon size={14} weight="regular" />
            </button>
          </>
        )}

        {/* Mobile overflow menu. Hidden on desktop (`.mobile-only`); on
            phones it consolidates all the secondary buttons into a single
            tap target so the top bar isn't a 5-button traffic jam. */}
        <div className="mobile-only relative" ref={overflowRef} data-no-drag="true">
          <button
            onClick={() => setOverflowOpen(o => !o)}
            className="p-1.5 rounded-lg transition-colors duration-100 hover:bg-[var(--bg-hover)]"
            style={{ color: 'var(--text-muted)' }}
            aria-label="More"
            aria-expanded={overflowOpen}
            aria-haspopup="menu"
          >
            <DotsThreeVerticalIcon size={18} weight="bold" />
          </button>
          {overflowOpen && (
            <div
              role="menu"
              className="absolute right-0 mt-1 min-w-[200px] rounded-lg overflow-hidden z-50"
              style={{
                background: 'var(--bg-elevated)',
                border:     '1px solid var(--border-subtle)',
                boxShadow:  '0 12px 32px rgba(0,0,0,0.5)',
              }}
            >
              <button
                onClick={() => { preloadAllMail(undefined, 'full'); closeOverflow() }}
                role="menuitem"
                className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left hover:bg-[var(--bg-hover)]"
                style={{ color: 'var(--text-primary)' }}
              >
                <ArrowClockwiseIcon size={14} weight="regular" />
                Build local mail cache
              </button>
              {isDpanelMode() && (
                <>
                  <div style={{ height: 1, background: 'var(--border-subtle)' }} />
                  <button
                    onClick={() => {
                      document.cookie = `webmail_mode=classic; max-age=${30 * 24 * 60 * 60}; path=/; SameSite=Lax`
                      window.location.reload()
                    }}
                    role="menuitem"
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left hover:bg-[var(--bg-hover)]"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    <ArrowsClockwiseIcon size={14} weight="regular" />
                    Switch to classic webmail
                  </button>
                  <div style={{ height: 1, background: 'var(--border-subtle)' }} />
                  <button
                    onClick={async () => {
                      closeOverflow()
                      try { await dpanelAuth.logout() } catch { /* ignore */ }
                      try { await db.delete()       } catch { /* ignore */ }
                      window.location.reload()
                    }}
                    role="menuitem"
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left hover:bg-[var(--bg-hover)]"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    <SignOutIcon size={14} weight="regular" />
                    Sign out
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
