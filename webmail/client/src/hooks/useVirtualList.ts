import { useRef, useState, useCallback, useEffect, useMemo } from 'react'

interface VirtualListOptions {
  count: number
  itemHeight: number
  overscan?: number
}

interface VirtualItem {
  index: number
  start: number
  size: number
}

/**
 * Minimal virtual list hook — renders only visible rows + overscan.
 * No dependency on react-virtual for tighter control. Each row is a fixed height
 * (Superhuman's rows are uniform 56px), making this trivially fast.
 */
export function useVirtualList({ count, itemHeight, overscan = 5 }: VirtualListOptions) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [containerHeight, setContainerHeight] = useState(0)

  const measure = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setContainerHeight(el.clientHeight)
    setScrollTop(el.scrollTop)
  }, [])

  const setScrollRef = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node
    if (node) {
      setContainerHeight(node.clientHeight)
      setScrollTop(node.scrollTop)
    }
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => setScrollTop(el.scrollTop)
    const ro = new ResizeObserver(([entry]) => {
      setContainerHeight(entry.contentRect.height)
      setScrollTop(el.scrollTop)
    })
    ro.observe(el)
    el.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', measure)
    requestAnimationFrame(measure)
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', measure)
    }
  }, [count, measure])

  useEffect(() => {
    const maxScrollTop = Math.max(0, count * itemHeight - containerHeight)
    if (scrollTop > maxScrollTop) {
      const el = scrollRef.current
      if (el) el.scrollTop = maxScrollTop
      setScrollTop(maxScrollTop)
    }
  }, [containerHeight, count, itemHeight, scrollTop])

  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan)
  const endIndex = Math.min(
    count - 1,
    Math.ceil((scrollTop + containerHeight) / itemHeight) + overscan
  )

  const virtualItems: VirtualItem[] = useMemo(() => {
    const items: VirtualItem[] = []
    for (let i = startIndex; i <= endIndex; i++) {
      items.push({ index: i, start: i * itemHeight, size: itemHeight })
    }
    return items
  }, [endIndex, itemHeight, startIndex])

  const totalSize = count * itemHeight

  /** Scroll the focused item into view */
  const scrollToIndex = useCallback((index: number) => {
    const el = scrollRef.current
    if (!el) return
    const itemTop = index * itemHeight
    const itemBottom = itemTop + itemHeight
    if (itemTop < el.scrollTop) {
      el.scrollTop = itemTop
    } else if (itemBottom > el.scrollTop + el.clientHeight) {
      el.scrollTop = itemBottom - el.clientHeight
    }
  }, [itemHeight])

  return { scrollRef: setScrollRef, virtualItems, totalSize, scrollToIndex }
}
