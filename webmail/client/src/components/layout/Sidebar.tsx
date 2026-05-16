import { useEffect, useRef, useState } from 'react'
import {
  TrayIcon, StarIcon, PaperPlaneRightIcon, FileIcon,
  TrashIcon, ClockIcon, TagIcon, GearSixIcon, PlusIcon,
  SidebarSimpleIcon, WarningIcon,
} from '@phosphor-icons/react'
import { useEmailStore, selectActiveState } from '@/store/emailStore'
import { useUiStore, SIDEBAR_LIMITS } from '@/store/uiStore'
import { useLabelsStore } from '@/store/labelsStore'
import { avatarColor, initials } from '@/lib/utils'
import type { ActiveFolder } from '@/types/email'

interface NavItem {
  label:        string
  // System folders only — string subset of ActiveFolder
  folder:       Extract<ActiveFolder, string>
  icon:         React.ReactNode
  shortcut?:    string
  unreadCount?: number
}

interface SidebarProps {
  onAddAccount?: () => void
}

function isLabelFolder(folder: ActiveFolder): folder is { kind: 'label'; id: string } {
  return typeof folder === 'object' && folder !== null && folder.kind === 'label'
}

export function Sidebar({ onAddAccount }: SidebarProps) {
  const accounts        = useEmailStore(s => s.accounts)
  const activeAccountId = useEmailStore(s => s.activeAccountId)
  const setActiveAccount = useEmailStore(s => s.setActiveAccount)
  const activeState     = useEmailStore(selectActiveState)
  const setActiveFolderRaw = useEmailStore(s => s.setActiveFolder)
  const openCompose     = useUiStore(s => s.openCompose)
  const openLabelManager = useUiStore(s => s.openLabelManager)
  const openMailView    = useUiStore(s => s.openMailView)
  const closeCompose    = useUiStore(s => s.closeCompose)
  const labels          = useLabelsStore(s => s.labels)
  const loadLabels      = useLabelsStore(s => s.load)
	  const removeLabel     = useLabelsStore(s => s.remove)
	  const renameLabel     = useLabelsStore(s => s.rename)
	  const moveLabel       = useLabelsStore(s => s.move)
  const toast           = useUiStore(s => s.toast)

  // ─ Right-click context menu state ─────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; labelId: string } | null>(null)
	  useEffect(() => {
	    if (!ctxMenu) return
	    const close = () => setCtxMenu(null)
	    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
	    window.addEventListener('click', close)
	    window.addEventListener('contextmenu', close)
	    window.addEventListener('keydown', onKey)
	    return () => {
	      window.removeEventListener('click', close)
	      window.removeEventListener('contextmenu', close)
	      window.removeEventListener('keydown', onKey)
	    }
	  }, [ctxMenu])

  const handleLabelDelete = async (labelId: string, name: string) => {
    if (!confirm(`Delete label "${name}"? Emails keep their data, just lose this tag.`)) return
    await removeLabel(labelId)
    toast(`Deleted "${name}"`)
  }
  const handleLabelRename = async (labelId: string, current: string) => {
    const next = prompt('Rename label:', current)
    if (!next || next.trim() === current) return
    await renameLabel(labelId, next.trim())
    toast(`Renamed to "${next.trim()}"`)
  }

  // ─ Sidebar layout state ─────────────────────────────────────────────────
  const sidebarWidth     = useUiStore(s => s.settings.sidebarWidth)
  const sidebarCollapsed = useUiStore(s => s.settings.sidebarCollapsed)
  const setSidebarWidth     = useUiStore(s => s.setSidebarWidth)
  const setSidebarCollapsed = useUiStore(s => s.setSidebarCollapsed)
  const toggleSidebar       = useUiStore(s => s.toggleSidebar)

  // Mobile drawer state. On phones the sidebar is fixed-position and slides
  // in from the left when mobileNavOpen is true (CSS handles the transform).
  const mobileNavOpen  = useUiStore(s => s.mobileNavOpen)
  const closeMobileNav = useUiStore(s => s.closeMobileNav)

  const effectiveWidth = sidebarCollapsed ? SIDEBAR_LIMITS.COLLAPSED_PX : sidebarWidth
  const collapsed      = sidebarCollapsed

  // Mirror the effective width into the global CSS variable so .sidebar and
  // any consumer (e.g. full-screen ComposeWindow that anchors to it) react.
  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-width', `${effectiveWidth}px`)
  }, [effectiveWidth])

  // Drag-to-resize plumbing
  const [resizing, setResizing] = useState(false)
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    if (!resizing) return
    const onMove = (e: MouseEvent) => {
      const s = dragStateRef.current
      if (!s) return
      const next = s.startWidth + (e.clientX - s.startX)
      // Live-update the CSS variable for instant feedback (no React re-render
      // per pixel — we commit to state on mouseup)
      const clamped = Math.max(SIDEBAR_LIMITS.MIN, Math.min(SIDEBAR_LIMITS.MAX, next))
      document.documentElement.style.setProperty('--sidebar-width', `${clamped}px`)
      // Snap-collapse if the user drags below the threshold
      if (next < SIDEBAR_LIMITS.COLLAPSE_AT) {
        document.documentElement.style.setProperty('--sidebar-width', `${SIDEBAR_LIMITS.COLLAPSED_PX}px`)
      }
    }
    const onUp = (e: MouseEvent) => {
      const s = dragStateRef.current
      if (s) {
        const next = s.startWidth + (e.clientX - s.startX)
        if (next < SIDEBAR_LIMITS.COLLAPSE_AT) {
          setSidebarCollapsed(true)
        } else {
          setSidebarWidth(next)
        }
      }
      dragStateRef.current = null
      setResizing(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp, { once: true })
    // Disable text selection / iframe interception while dragging
    document.body.style.cursor      = 'col-resize'
    document.body.style.userSelect  = 'none'
    return () => {
      window.removeEventListener('mousemove', onMove)
      document.body.style.cursor     = ''
      document.body.style.userSelect = ''
    }
  }, [resizing, setSidebarWidth, setSidebarCollapsed])

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    dragStateRef.current = { startX: e.clientX, startWidth: effectiveWidth }
    setResizing(true)
  }

  // Keyboard: Cmd/Ctrl+\ toggles the sidebar (matches Notion / VS Code)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSidebar])

  useEffect(() => { loadLabels() }, [loadLabels])

  // Picking any mailbox/label/account from the sidebar should always return
  // the user to the mail view and dismiss compose / search / settings.
  const goToMail = () => { openMailView(); closeCompose() }
  const setActiveFolder: typeof setActiveFolderRaw = (folder) => {
    goToMail()
    setActiveFolderRaw(folder)
  }
  const switchAccount = (id: string) => {
    goToMail()
    setActiveAccount(id)
  }

	  const isLabelActive = (id: string): boolean => {
	    const af = activeState.activeFolder
	    return isLabelFolder(af) && af.id === id
	  }

  const inboxUnread = activeState.activeFolder === 'INBOX'
    ? activeState.emails.filter(e => !e.isRead).length
    : 0

  const navItems: NavItem[] = [
    { label: 'Inbox',   folder: 'INBOX',   icon: <TrayIcon weight="duotone" size={15} />,            shortcut: 'gi', unreadCount: inboxUnread },
    { label: 'Starred', folder: 'Starred', icon: <StarIcon weight="duotone" size={15} />,             shortcut: 'gs' },
    { label: 'Sent',    folder: 'Sent',    icon: <PaperPlaneRightIcon weight="duotone" size={15} />,  shortcut: 'gt' },
    { label: 'Drafts',  folder: 'Drafts',  icon: <FileIcon weight="duotone" size={15} />,             shortcut: 'gd' },
    { label: 'Snoozed', folder: 'snoozed', icon: <ClockIcon weight="duotone" size={15} /> },
    { label: 'Spam',    folder: 'Spam',    icon: <WarningIcon weight="duotone" size={15} /> },
    { label: 'Trash',   folder: 'Trash',   icon: <TrashIcon weight="duotone" size={15} />,            shortcut: 'ge' },
  ]

  const isMac = typeof window !== 'undefined' &&
	                (window as typeof window & { electronAPI?: { platform?: string } }).electronAPI?.platform === 'darwin'

  // ─ COLLAPSED RENDERING ────────────────────────────────────────────────────
  if (collapsed) {
    return (
      <aside
      className={`sidebar select-none flex flex-col items-center ${resizing ? 'resizing' : ''}${mobileNavOpen ? ' mobile-open' : ''}`}
      onClick={(e) => {
        // On mobile, tapping any actionable item inside the drawer dismisses
        // the drawer. We skip the resize handle and any pure-display elements.
        const t = e.target as HTMLElement
        if (t.closest('button, .nav-item, a, [role="button"]')
            && !t.closest('.sidebar-resize-handle')) {
          closeMobileNav()
        }
      }}
    >
        {isMac && <div aria-hidden="true" style={{ height: 32, flexShrink: 0 }} />}

        {/* Expand */}
        <button
          onClick={toggleSidebar}
          title="Expand sidebar (⌘\)"
          className="my-2 p-2 rounded-lg transition-colors hover:bg-[var(--bg-hover)]"
          style={{ color: 'var(--text-muted)' }}
        >
          <SidebarSimpleIcon size={15} weight="duotone" />
        </button>

        {/* Account dots */}
        <div className="flex flex-col items-center gap-1.5 px-2 py-2 border-t border-b w-full" style={{ borderColor: 'var(--border-subtle)' }}>
          {accounts.map(account => {
            const isActive = account.id === activeAccountId
            const color    = avatarColor(account.email)
            const abbr     = initials(account.name || account.email)
            return (
              <button
                key={account.id}
                onClick={() => switchAccount(account.id)}
                title={account.email}
                className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold transition-all duration-150"
                style={{
                  background:  isActive ? color : 'var(--bg-overlay)',
                  color:       isActive ? '#fff' : 'var(--text-muted)',
                  boxShadow:   isActive ? `0 0 0 2px var(--bg-base), 0 0 0 3.5px ${color}` : 'none',
                  border:      isActive ? 'none' : '1px solid var(--border-subtle)',
                }}
              >
                {abbr}
              </button>
            )
          })}
          {onAddAccount && (
            <button
              onClick={onAddAccount}
              title="Add account"
              className="w-7 h-7 rounded-full flex items-center justify-center"
              style={{ background: 'transparent', border: '1.5px dashed var(--border-subtle)', color: 'var(--text-muted)' }}
            >
              <PlusIcon size={11} weight="bold" />
            </button>
          )}
        </div>

        {/* Compose */}
        <button
          onClick={() => openCompose()}
          title="Compose (C)"
          className="my-2 w-9 h-9 rounded-lg flex items-center justify-center transition-colors"
          style={{ background: 'var(--accent-faint)', border: '1px solid var(--border-accent)', color: 'var(--accent)' }}
        >
          <PlusIcon size={14} weight="bold" />
        </button>

        {/* Folder icons */}
        <nav className="flex-1 flex flex-col items-center gap-1 py-2">
          {navItems.map(item => {
            const active = activeState.activeFolder === item.folder
            return (
              <button
                key={item.folder}
                onClick={() => setActiveFolder(item.folder)}
                title={item.label}
                className="relative w-9 h-9 rounded-lg flex items-center justify-center transition-colors"
                style={{
                  background: active ? 'var(--bg-active)' : 'transparent',
                  color:      active ? 'var(--accent)' : 'var(--text-muted)',
                }}
              >
                {item.icon}
                {item.unreadCount != null && item.unreadCount > 0 && (
                  <span
                    className="absolute -top-0.5 -right-0.5 text-[8px] font-bold px-1 rounded-full"
                    style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
                  >
                    {item.unreadCount > 99 ? '99' : item.unreadCount}
                  </span>
                )}
              </button>
            )
          })}

          {/* Label color dots */}
          {labels.length > 0 && (
            <div className="mt-2 pt-2 border-t w-7" style={{ borderColor: 'var(--border-subtle)' }}>
              {labels.map(l => {
                const active = isLabelActive(l.id)
                return (
                  <button
                    key={l.id}
                    onClick={() => setActiveFolder({ kind: 'label', id: l.id })}
                    title={l.name}
                    className="my-1 w-9 h-7 rounded-md flex items-center justify-center transition-colors"
                    style={{ background: active ? 'var(--bg-active)' : 'transparent' }}
                  >
                    <span className="w-3 h-3 rounded-sm" style={{ background: l.color }} />
                  </button>
                )
              })}
            </div>
          )}
        </nav>

        <button
          onClick={() => openLabelManager('__settings__')}
          title="Settings"
          className="mb-3 w-9 h-9 rounded-lg flex items-center justify-center transition-colors hover:bg-[var(--bg-hover)]"
          style={{ color: 'var(--text-muted)' }}
        >
          <GearSixIcon size={15} weight="duotone" />
        </button>

        <div className="sidebar-resize-handle" onMouseDown={startResize} />
      </aside>
    )
  }

  // ─ EXPANDED RENDERING ─────────────────────────────────────────────────────
  return (
    <aside
      className={`sidebar select-none flex flex-col ${resizing ? 'resizing' : ''}${mobileNavOpen ? ' mobile-open' : ''}`}
      onClick={(e) => {
        const t = e.target as HTMLElement
        if (t.closest('button, .nav-item, a, [role="button"]')
            && !t.closest('.sidebar-resize-handle')) {
          closeMobileNav()
        }
      }}
    >

      {isMac && <div aria-hidden="true" style={{ height: 32, flexShrink: 0 }} />}

      {/* ── Account tabs ──────────────────────────────────────────────────── */}
      <div
        className="flex items-center gap-1.5 px-3 py-2.5 border-b"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        {accounts.map(account => {
          const isActive = account.id === activeAccountId
          const color    = avatarColor(account.email)
          const abbr     = initials(account.name || account.email)
          return (
            <button
              key={account.id}
              onClick={() => switchAccount(account.id)}
              title={account.email}
              className="relative flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold transition-all duration-150"
              style={{
                background:  isActive ? color : 'var(--bg-overlay)',
                color:       isActive ? '#fff' : 'var(--text-muted)',
                boxShadow:   isActive ? `0 0 0 2px var(--bg-base), 0 0 0 3.5px ${color}` : 'none',
                border:      isActive ? 'none' : '1px solid var(--border-subtle)',
              }}
            >
              {abbr}
            </button>
          )
        })}

        {onAddAccount && (
          <button
            onClick={onAddAccount}
            title="Add account"
            className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-colors duration-150"
            style={{ background: 'transparent', border: '1.5px dashed var(--border-subtle)', color: 'var(--text-muted)' }}
            onMouseEnter={e => {
              ;(e.currentTarget as HTMLElement).style.borderColor = 'var(--border-accent)'
              ;(e.currentTarget as HTMLElement).style.color = 'var(--accent)'
            }}
            onMouseLeave={e => {
              ;(e.currentTarget as HTMLElement).style.borderColor = 'var(--border-subtle)'
              ;(e.currentTarget as HTMLElement).style.color = 'var(--text-muted)'
            }}
          >
            <PlusIcon size={11} weight="bold" />
          </button>
        )}

        {/* Collapse toggle */}
        <button
          onClick={toggleSidebar}
          title="Collapse sidebar (⌘\)"
          className="ml-auto flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center transition-colors hover:bg-[var(--bg-hover)]"
          style={{ color: 'var(--text-muted)' }}
        >
          <SidebarSimpleIcon size={13} weight="duotone" />
        </button>
      </div>

      {/* ── Brand / identity ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        <div
          className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0"
          style={{ background: 'var(--mysteria)', border: '1px solid var(--border-accent)' }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path d="M17.5 1L7.5 13h5l-1 10 10-12h-5l1-10z"
              fill="var(--accent)" stroke="var(--accent)" strokeWidth="0.5" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-[var(--text-primary)] truncate" style={{ letterSpacing: '-0.02em' }}>
            {accounts.find(a => a.id === activeAccountId)?.name ?? 'Superhuman'}
          </div>
          <div className="text-[10px] text-[var(--text-muted)] truncate leading-tight">
            {accounts.find(a => a.id === activeAccountId)?.email ?? ''}
          </div>
        </div>
      </div>

      {/* ── Compose ───────────────────────────────────────────────────────── */}
      <div className="px-3 pt-3 pb-1">
        <button
          onClick={() => openCompose()}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-100"
          style={{ background: 'var(--accent-faint)', border: '1px solid var(--border-accent)', color: 'var(--accent)' }}
        >
          <PlusIcon size={14} weight="bold" />
          <span>Compose</span>
          <kbd className="ml-auto">C</kbd>
        </button>
      </div>

      {/* ── Nav ───────────────────────────────────────────────────────────── */}
      <nav className="px-2 py-2 flex-1">
        {navItems.map(item => {
          const active = activeState.activeFolder === item.folder
          return (
            <button
              key={item.folder}
              onClick={() => setActiveFolder(item.folder)}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm transition-all duration-100 group mb-0.5"
              style={{
                background: active ? 'var(--bg-active)' : 'transparent',
                color:      active ? 'var(--accent)' : 'var(--text-secondary)',
                fontWeight: active ? 600 : 400,
              }}
            >
              <span style={{ color: active ? 'var(--accent)' : 'var(--text-muted)' }}>{item.icon}</span>
              <span className="flex-1 text-left">{item.label}</span>
              {item.unreadCount != null && item.unreadCount > 0 && (
                <span
                  className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                  style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
                >
                  {item.unreadCount > 99 ? '99+' : item.unreadCount}
                </span>
              )}
              {item.shortcut && !item.unreadCount && (
                <span className="opacity-0 group-hover:opacity-100 transition-opacity">
                  <kbd>{item.shortcut}</kbd>
                </span>
              )}
            </button>
          )
        })}

        <div className="my-2 border-t" style={{ borderColor: 'var(--border-subtle)' }} />

        <div className="flex items-center justify-between px-2.5 py-1.5 group">
          <div className="flex items-center gap-2">
            <TagIcon size={13} weight="duotone" style={{ color: 'var(--text-muted)' }} />
            <span className="text-xs text-[var(--text-muted)] uppercase tracking-widest font-semibold">Labels</span>
          </div>
          <button
            onClick={() => openLabelManager()}
            title="Manage labels & rules"
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded transition-all hover:bg-[var(--bg-hover)]"
            style={{ color: 'var(--text-muted)' }}
          >
            <PlusIcon size={11} weight="bold" />
          </button>
        </div>

        {labels.length === 0 ? (
          <button
            onClick={() => openLabelManager()}
            className="text-xs text-[var(--text-disabled)] px-2.5 py-1 hover:text-[var(--text-muted)] transition-colors"
          >
            No labels yet — create one
          </button>
        ) : (
          labels.map(l => {
            const active = isLabelActive(l.id)
            return (
	              <div
	                key={l.id}
	                role="button"
	                tabIndex={0}
	                data-no-drag="true"
	                className="relative w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-sm transition-all duration-100 mb-0.5 group/label cursor-pointer"
	                onClick={() => setActiveFolder({ kind: 'label', id: l.id })}
	                onKeyDown={e => {
	                  if (e.key === 'Enter') setActiveFolder({ kind: 'label', id: l.id })
	                  if (e.key === 'F2') handleLabelRename(l.id, l.name)
	                  if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowUp') moveLabel(l.id, 'up')
	                  if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowDown') moveLabel(l.id, 'down')
	                }}
	                onDoubleClick={() => openLabelManager(l.id)}
                onContextMenu={e => {
                  e.preventDefault()
                  e.stopPropagation()
                  setCtxMenu({ x: e.clientX, y: e.clientY, labelId: l.id })
                }}
                style={{
                  background: active ? 'var(--bg-active)' : 'transparent',
                  color:      active ? 'var(--text-primary)' : 'var(--text-secondary)',
                }}
              >
                <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: l.color }} />
                <span className="flex-1 text-left truncate">{l.name}</span>
                {/* Hover actions — visible on label hover only */}
                <div className="opacity-0 group-hover/label:opacity-100 flex items-center gap-0.5 transition-opacity">
	                  <button
	                    onClick={e => { e.stopPropagation(); openLabelManager(l.id) }}
                    title="Edit rules"
                    className="p-0.5 rounded hover:bg-[var(--bg-overlay)]"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <GearSixIcon size={11} weight="duotone" />
	                  </button>
	                  <button
	                    onClick={e => { e.stopPropagation(); handleLabelRename(l.id, l.name) }}
	                    title="Rename label"
	                    className="p-0.5 rounded hover:bg-[var(--bg-overlay)]"
	                    style={{ color: 'var(--text-muted)' }}
	                  >
	                    <span style={{ width: 11, display: 'inline-block', textAlign: 'center', fontSize: 11 }}>R</span>
	                  </button>
	                  <button
                    onClick={e => { e.stopPropagation(); handleLabelDelete(l.id, l.name) }}
                    title="Delete label"
                    className="p-0.5 rounded hover:bg-[var(--bg-overlay)]"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <TrashIcon size={11} />
                  </button>
                </div>
              </div>
            )
          })
        )}
      </nav>

      {/* Right-click context menu */}
      {ctxMenu && (() => {
        const lbl = labels.find(l => l.id === ctxMenu.labelId)
        if (!lbl) return null
        return (
	              <div
	            data-no-drag="true"
	            className="fixed z-[80] rounded-lg overflow-hidden text-sm"
            style={{
              left:        Math.min(ctxMenu.x, window.innerWidth - 200),
              top:         Math.min(ctxMenu.y, window.innerHeight - 160),
              minWidth:    180,
              background:  'var(--bg-overlay)',
              border:      '1px solid var(--border-strong)',
              boxShadow:   '0 12px 32px rgba(0,0,0,0.5)',
            }}
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => { setCtxMenu(null); openLabelManager(lbl.id) }}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-active)] transition-colors text-[var(--text-primary)]"
            >
              <GearSixIcon size={12} weight="duotone" />
              Edit rules
            </button>
	            <button
	              onClick={() => { setCtxMenu(null); handleLabelRename(lbl.id, lbl.name) }}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-active)] transition-colors text-[var(--text-primary)]"
            >
              <span style={{ width: 12, display: 'inline-block', textAlign: 'center' }}>✎</span>
	              Rename
	            </button>
	            <button
	              onClick={() => { setCtxMenu(null); moveLabel(lbl.id, 'up') }}
	              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-active)] transition-colors text-[var(--text-primary)]"
	            >
	              <span style={{ width: 12, display: 'inline-block', textAlign: 'center' }}>↑</span>
	              Move up
	            </button>
	            <button
	              onClick={() => { setCtxMenu(null); moveLabel(lbl.id, 'down') }}
	              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-active)] transition-colors text-[var(--text-primary)]"
	            >
	              <span style={{ width: 12, display: 'inline-block', textAlign: 'center' }}>↓</span>
	              Move down
	            </button>
            <div style={{ borderTop: '1px solid var(--border-subtle)' }} />
            <button
              onClick={() => { setCtxMenu(null); handleLabelDelete(lbl.id, lbl.name) }}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-active)] transition-colors"
              style={{ color: '#ff7a8b' }}
            >
              <TrashIcon size={12} />
              Delete label
            </button>
          </div>
        )
      })()}

      {/* ── Settings ──────────────────────────────────────────────────────── */}
      <div className="p-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
        <button
          onClick={() => openLabelManager('__settings__')}
          className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm transition-colors duration-100 hover:bg-[var(--bg-hover)]"
          style={{ color: 'var(--text-muted)' }}
        >
          <GearSixIcon size={15} weight="duotone" />
          <span>Settings</span>
        </button>
      </div>

      {/* Resize handle */}
      <div className="sidebar-resize-handle" onMouseDown={startResize} />
    </aside>
  )
}
