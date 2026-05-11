import type { PublicConfig } from './api'

// Lazy module-level cache, written once by App.tsx after the public-config
// fetch resolves. Components that need to branch on mode (e.g. hide the
// "Add Account" button in DPanel multi-tenant mode) read it synchronously.

let cached: PublicConfig | null = null

export function setClientConfig(c: PublicConfig): void {
  cached = c
}

export function getClientConfig(): PublicConfig {
  return cached ?? { mode: 'normal', gmailEnabled: false }
}

export function isDpanelMode(): boolean {
  return cached?.mode === 'dpanel'
}
