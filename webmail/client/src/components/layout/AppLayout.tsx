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
import { useUiStore }      from '@/store/uiStore'
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
        <Sidebar onAddAccount={isDpanelMode() ? undefined : () => setShowAddAccount(true)} />

        <div className="main-area flex-col">
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
