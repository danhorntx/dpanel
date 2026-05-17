import { useEffect, useState, useRef, useCallback } from 'react'
import { tap } from '@/lib/haptic'

/**
 * usePullToRefresh — attach native-feeling pull-to-refresh to a scrollable
 * container. Touch-only. The container is expected to be the ELEMENT WITH
 * THE OVERFLOW (the one that scrolls), not its parent.
 *
 * Behavior:
 *   - Pull starts when scrollTop === 0 and the user drags down on touch.
 *   - The reported `offset` grows with the drag (clamped to maxPull).
 *   - On release: if offset >= threshold, onRefresh is invoked + a haptic
 *     fires. Otherwise it snaps back to 0.
 *   - `refreshing` reflects whether the consumer's onRefresh is in flight,
 *     letting the caller leave the indicator visible until the work
 *     finishes.
 *
 * Why not just listen via JSX `onTouchMove`? React attaches passive touch
 * listeners by default since v17, so calling event.preventDefault() inside
 * a passive listener is silently ignored — which is exactly what we need to
 * cancel the browser's own scroll behavior when pulling at the top. We
 * register the listener manually via addEventListener({ passive: false })
 * so preventDefault actually works.
 */
interface Options {
  /** Pixels of pull required to commit on release. Default 70. */
  threshold?: number
  /** Hard ceiling on how far the user can pull. Default 120. */
  maxPull?: number
  /** Async callback fired on commit. Indicator stays up until it resolves. */
  onRefresh: () => Promise<unknown> | unknown
}

export function usePullToRefresh<T extends HTMLElement>(opts: Options) {
  const threshold = opts.threshold ?? 70
  const maxPull   = opts.maxPull   ?? 120
  const ref       = useRef<T | null>(null)
  const [offset, setOffset]         = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  const startY        = useRef<number | null>(null)
  const lastDelta     = useRef<number>(0)
  const refreshingRef = useRef(false)
  useEffect(() => { refreshingRef.current = refreshing }, [refreshing])

  // Keep latest onRefresh in a ref so the touchmove handler closure stays
  // stable across re-renders.
  const onRefreshRef = useRef(opts.onRefresh)
  useEffect(() => { onRefreshRef.current = opts.onRefresh }, [opts.onRefresh])

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const onTouchStart = (e: TouchEvent) => {
      if (refreshingRef.current) return
      if (el.scrollTop > 0)        return
      const t = e.touches[0]
      if (!t) return
      startY.current = t.clientY
      lastDelta.current = 0
    }
    const onTouchMove = (e: TouchEvent) => {
      if (startY.current == null) return
      if (refreshingRef.current)  return
      const t = e.touches[0]
      if (!t) return
      const delta = t.clientY - startY.current
      // Only react to downward pulls. Upward swipes are normal scroll.
      if (delta <= 0) {
        if (offset !== 0) setOffset(0)
        return
      }
      // If we're not at the top of the list, abandon the gesture so normal
      // scroll can take over (e.g. user dragged down quickly, scrolled).
      if (el.scrollTop > 0) {
        startY.current = null
        if (offset !== 0) setOffset(0)
        return
      }
      // Resistance curve: gets harder to pull as you go further. Feels
      // closer to native than a 1:1 linear map.
      const damped = Math.min(maxPull, Math.pow(delta, 0.85))
      lastDelta.current = damped
      setOffset(damped)
      // Prevent the browser scroll-bounce above the list while we're in
      // the pull gesture. Only after we know we're consuming the drag.
      e.preventDefault()
    }
    const onTouchEnd = async () => {
      if (startY.current == null) return
      const committed = lastDelta.current >= threshold
      startY.current = null
      if (!committed) {
        setOffset(0)
        return
      }
      tap()
      setRefreshing(true)
      // Keep indicator parked at the threshold while the refresh runs.
      setOffset(threshold)
      try { await onRefreshRef.current() } catch { /* ignore — caller handles */ }
      setRefreshing(false)
      setOffset(0)
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove',  onTouchMove,  { passive: false })
    el.addEventListener('touchend',   onTouchEnd,   { passive: true })
    el.addEventListener('touchcancel', onTouchEnd,  { passive: true })
    return () => {
      el.removeEventListener('touchstart',  onTouchStart)
      el.removeEventListener('touchmove',   onTouchMove)
      el.removeEventListener('touchend',    onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
    }
    // Intentionally not listing `offset` — re-attaching the handlers on
    // every offset change would invalidate the ongoing gesture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threshold, maxPull])

  const onPullRefSet = useCallback((node: T | null) => { ref.current = node }, [])
  return { ref: onPullRefSet, offset, refreshing, threshold }
}
