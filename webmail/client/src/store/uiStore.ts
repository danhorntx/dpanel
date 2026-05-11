import { create } from 'zustand'
import type { ToastMessage, AppView } from '@/types/email'
import { generateId } from '@/lib/utils'

// ─── Persistent settings (localStorage) ──────────────────────────────────────

interface PersistedSettings {
  composeFullScreen: boolean
  replyFullScreen:   boolean
  automaticallyLoadImages: boolean
  emailPreviewTheme: 'light' | 'dark'
  sidebarWidth:      number   // user's preferred width when expanded
  sidebarCollapsed:  boolean
}

const SIDEBAR_MIN          = 180
const SIDEBAR_MAX          = 400
const SIDEBAR_DEFAULT      = 220
const SIDEBAR_COLLAPSED_PX = 56
// If the user drags below this, snap to collapsed mode automatically
const SIDEBAR_COLLAPSE_AT  = 140

export const SIDEBAR_LIMITS = {
  MIN:          SIDEBAR_MIN,
  MAX:          SIDEBAR_MAX,
  DEFAULT:      SIDEBAR_DEFAULT,
  COLLAPSED_PX: SIDEBAR_COLLAPSED_PX,
  COLLAPSE_AT:  SIDEBAR_COLLAPSE_AT,
}

const SETTINGS_KEY = 'duperhuman:settings:v1'

function loadSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return defaultSettings()
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>
    // Default any missing keys (handles forward-compat for new toggles)
    return { ...defaultSettings(), ...parsed }
  } catch { return defaultSettings() }
}

function defaultSettings(): PersistedSettings {
  return {
    composeFullScreen: true,
    replyFullScreen:   true,
    automaticallyLoadImages: false,
    emailPreviewTheme: 'light',
    sidebarWidth:      SIDEBAR_DEFAULT,
    sidebarCollapsed:  false,
  }
}

function saveSettings(s: PersistedSettings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)) } catch { /* ignore */ }
}

interface UiStore {
  // ─ Panels
  commandPaletteOpen: boolean
  shortcutsOverlayOpen: boolean
  composeOpen: boolean
  snoozeModalOpen: boolean
  labelDialogOpen: boolean
  searchMode: boolean
  keyHint: string | null

  // ─ Top-level view
  view: AppView
  searchQuery: string
  managingLabelId: string | null

  // ─ Toast / notification queue
  toasts: ToastMessage[]

  // ─ Compose state
  composeReplyToId: string | null
  composeForwardId: string | null
  composeDraftId: string | null
  composeReplyAll: boolean

  // ─ Persisted user preferences
  settings: PersistedSettings

  // ─ Actions
  openCommandPalette: () => void
  closeCommandPalette: () => void
  toggleCommandPalette: () => void

  openShortcuts: () => void
  closeShortcuts: () => void

  openCompose: (opts?: { replyToId?: string; forwardId?: string; draftId?: string; replyAll?: boolean }) => void
  closeCompose: () => void

  openSnoozeModal: () => void
  closeSnoozeModal: () => void

  openLabelDialog: () => void
  closeLabelDialog: () => void

  setSearchMode: (on: boolean) => void
  setKeyHint: (hint: string | null) => void

  openSearchView:  (query: string) => void
  openLabelManager:(labelId?: string | null) => void
  openMailView:    () => void

  setSetting: <K extends keyof PersistedSettings>(key: K, value: PersistedSettings[K]) => void

  // Sidebar resize / collapse helpers (write-through to persisted settings)
  setSidebarWidth:     (px: number) => void
  toggleSidebar:       () => void
  setSidebarCollapsed: (collapsed: boolean) => void

  toast: (text: string, opts?: { action?: ToastMessage['action']; duration?: number }) => void
  dismissToast: (id: string) => void
}

export const useUiStore = create<UiStore>((set, get) => ({
  commandPaletteOpen: false,
  shortcutsOverlayOpen: false,
  composeOpen: false,
  snoozeModalOpen: false,
  labelDialogOpen: false,
  searchMode: false,
  keyHint: null,

  view: 'mail',
  searchQuery: '',
  managingLabelId: null,

  toasts: [],
  composeReplyToId: null,
  composeForwardId: null,
  composeDraftId: null,
  composeReplyAll: false,

  settings: loadSettings(),

  openCommandPalette: () => set({ commandPaletteOpen: true }),
  closeCommandPalette: () => set({ commandPaletteOpen: false }),
  toggleCommandPalette: () => set(s => ({ commandPaletteOpen: !s.commandPaletteOpen })),

  openShortcuts: () => set({ shortcutsOverlayOpen: true }),
  closeShortcuts: () => set({ shortcutsOverlayOpen: false }),

	  openCompose: (opts) =>
    set({
      composeOpen: true,
      composeReplyToId: opts?.replyToId ?? null,
      composeForwardId: opts?.forwardId ?? null,
      composeDraftId: opts?.draftId ?? null,
      composeReplyAll: opts?.replyAll ?? false,
    }),
  closeCompose: () =>
    set({ composeOpen: false, composeReplyToId: null, composeForwardId: null, composeDraftId: null, composeReplyAll: false }),

  openSnoozeModal: () => set({ snoozeModalOpen: true }),
  closeSnoozeModal: () => set({ snoozeModalOpen: false }),

  openLabelDialog:  () => set({ labelDialogOpen: true }),
  closeLabelDialog: () => set({ labelDialogOpen: false }),

  setSearchMode: (on) => set({ searchMode: on }),
  setKeyHint: (hint) => set({ keyHint: hint }),

  openSearchView:   (query) => set({ view: 'search', searchQuery: query, commandPaletteOpen: false }),
  openLabelManager: (labelId = null) => set({ view: 'label-manager', managingLabelId: labelId, commandPaletteOpen: false }),
  openMailView:     () => set({ view: 'mail', searchQuery: '', managingLabelId: null }),

  setSetting: (key, value) =>
    set(s => {
      const next = { ...s.settings, [key]: value }
      saveSettings(next)
      return { settings: next }
    }),

  setSidebarWidth: (px) =>
    set(s => {
      const clamped = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(px)))
      const next = { ...s.settings, sidebarWidth: clamped, sidebarCollapsed: false }
      saveSettings(next)
      return { settings: next }
    }),

  toggleSidebar: () =>
    set(s => {
      const next = { ...s.settings, sidebarCollapsed: !s.settings.sidebarCollapsed }
      saveSettings(next)
      return { settings: next }
    }),

  setSidebarCollapsed: (collapsed) =>
    set(s => {
      const next = { ...s.settings, sidebarCollapsed: collapsed }
      saveSettings(next)
      return { settings: next }
    }),

  toast: (text, opts) => {
    const id = generateId()
    const msg: ToastMessage = {
      id,
      text,
      action: opts?.action,
      duration: opts?.duration ?? 4000,
    }
    set(s => ({ toasts: [msg, ...s.toasts].slice(0, 3) }))
    setTimeout(() => get().dismissToast(id), msg.duration)
  },

  dismissToast: (id) =>
    set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
}))
