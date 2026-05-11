import { MagnifyingGlassIcon, KeyboardIcon, ArrowClockwiseIcon, SignOutIcon, ArrowsClockwiseIcon } from '@phosphor-icons/react'
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
  const labels = useLabelsStore(s => s.labels)

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
        {/* Sync button */}
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
	        <button
	          onClick={() => preloadAllMail(undefined, 'full')}
	          className="px-2 py-1.5 rounded-lg transition-colors duration-100 hover:bg-[var(--bg-hover)] text-[11px]"
	          style={{ color: 'var(--text-muted)' }}
		          title="Build local mail cache"
		          aria-label="Build local mail cache"
		        >
		          Cache mail
	        </button>

        {/* Shortcuts */}
        <button
          onClick={openShortcuts}
          className="p-1.5 rounded-lg transition-colors duration-100 hover:bg-[var(--bg-hover)]"
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
              className="p-1.5 rounded-lg transition-colors duration-100 hover:bg-[var(--bg-hover)]"
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
              className="p-1.5 rounded-lg transition-colors duration-100 hover:bg-[var(--bg-hover)]"
              style={{ color: 'var(--text-muted)' }}
              title="Sign out"
              aria-label="Sign out"
            >
              <SignOutIcon size={14} weight="regular" />
            </button>
          </>
        )}
      </div>
    </header>
  )
}
