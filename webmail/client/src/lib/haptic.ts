/**
 * lib/haptic.ts — Thin wrapper around navigator.vibrate for mobile haptic
 * feedback. Used by swipe / long-press / pull-to-refresh handlers so user
 * actions feel responsive on phones.
 *
 * Desktop, iOS Safari, and any browser without the Vibration API simply
 * no-op — the helpers never throw. Browsers that have the API but are
 * suspended (user gesture not yet observed) silently ignore the call.
 *
 * Patterns:
 *   tap()     — single 10ms buzz, used for "action committed" feedback
 *               (swipe crossed the threshold; long-press fired; etc.)
 *   double()  — two short buzzes, used for harsher/destructive confirms
 *   off()     — cancel an in-progress pattern (used when a gesture is
 *               aborted before commit)
 */

function supported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'
}

export function tap(): void {
  if (!supported()) return
  try { navigator.vibrate(10) } catch { /* no-op */ }
}

export function double(): void {
  if (!supported()) return
  try { navigator.vibrate([10, 40, 10]) } catch { /* no-op */ }
}

export function off(): void {
  if (!supported()) return
  try { navigator.vibrate(0) } catch { /* no-op */ }
}
