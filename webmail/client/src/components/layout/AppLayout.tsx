import { lazy, Suspense, useState, useEffect } from 'react'
import { Sidebar }         from './Sidebar'
import { TopBar }          from './TopBar'
import { EmailList }       from '@/components/email/EmailList'
import { InboxSplitBar }   from '@/components/email/InboxSplitBar'
import { EmailThread }     from '@/components/email/EmailThread'
import { ShortcutsOverlay } from '@/components/overlays/ShortcutsOverlay'
import { SnoozeModal }     from '@/components/overlays/SnoozeModal'
import { ToastStack }      from '@/components/ui/Toast'
import { AddAccountModal } from '@/components/account/AddAccountModal'
import { LabelDialog }     from '@/components/labels/LabelDialog'
import { EmailRowMenu }    from '@/components/email/EmailRowMenu'
import { useUiStore }      from '@/store/uiStore'
import { useEmailStore }   from '@/store/emailStore'
import { isDpanelMode }    from '@/lib/clientConfig'

const CommandPalette = lazy(() => import('@/components/command/CommandPalette').then(m => ({ default: m.CommandPalette })))
const ComposeWindow = lazy(() => import('@/components/email/EmailCompose').then(m => ({ default: m.ComposeWindow })))
const SearchView = lazy(() => import('@/components/search/SearchView').then(m => ({ default: m.SearchView })))
const LabelManager = lazy(() => import('@/components/labels/LabelManager').then(m => ({ default: m.LabelManager })))

export function AppLayout() {
  const [showAddAccount, setShowAddAccount] = useState(false)
	  const view       = useUiStore(s => s.view)
	  const openMail   = useUiStore(s => s.openMailView)
  const keyHint    = useUiStore(s => s.keyHint)

  // Mobile drawer state. Desktop ignores these via CSS (display:none on the
  // backdrop, no .mobile-open class effect outside the breakpoint).
  const mobileNavOpen  = useUiStore(s => s.mobileNavOpen)
  const closeMobileNav = useUiStore(s => s.closeMobileNav)

  // Drive the single-pane mobile layout: when an email is selected, the
  // thread pane wins; otherwise the list does. Desktop ignores this — the
  // [data-thread-open] selector only matches inside the mobile media query.
  const threadOpen = useEmailStore(s => {
    const id = s.activeAccountId
    if (!id) return false
    return !!s.accountStates[id]?.selectedId
  })

  // Esc returns to mail view from any sub-view
  useEffect(() => {
    if (view === 'mail') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') openMail()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, openMail])

  return (
    <>
      <div className="app-shell">
        {/* Mobile-only sidebar backdrop. Click to close the drawer.
            Hidden on desktop via the CSS rule that scopes .show to the
            mobile media query. */}
        <div
          className={`mobile-sidebar-backdrop${mobileNavOpen ? ' show' : ''}`}
          onClick={closeMobileNav}
          aria-hidden={!mobileNavOpen}
        />
        <Sidebar onAddAccount={isDpanelMode() ? undefined : () => setShowAddAccount(true)} />

        <div className="main-area flex-col" data-thread-open={threadOpen ? 'true' : 'false'}>
          {view === 'mail' && (
            <>
              <TopBar />
              <div className="flex flex-1 overflow-hidden">
	                <div className="email-list-pane">
                  <InboxSplitBar />
	                  <EmailList />
	                </div>
                <div className="email-thread-pane">
                  <EmailThread />
                </div>
              </div>
            </>
          )}
	          <Suspense fallback={null}>
	            {view === 'search'        && <SearchView />}
	            {view === 'label-manager' && <LabelManager />}
	          </Suspense>
        </div>
      </div>

      {/* Global overlays */}
	      <Suspense fallback={null}>
	        <CommandPalette />
	        <ComposeWindow />
	      </Suspense>
      <ShortcutsOverlay />
      <SnoozeModal />
      <LabelDialog />
      <EmailRowMenu />
	      <ToastStack />
      {keyHint && (
        <div className="key-hint-popover" aria-live="polite">
          <kbd>{keyHint.toUpperCase()}</kbd>
          <span>waiting for next key</span>
        </div>
      )}

	      {showAddAccount && !isDpanelMode() && (
        <AddAccountModal onClose={() => setShowAddAccount(false)} />
      )}
    </>
  )
}
