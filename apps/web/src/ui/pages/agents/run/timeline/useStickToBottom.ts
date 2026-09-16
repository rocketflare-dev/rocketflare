/**
 * Keep a growing list pinned to the bottom — but only when the reader is already there, and only
 * when a NEW ROW arrived.
 *
 * The second condition is the one that matters. Keying auto-scroll on the container's HEIGHT yanks
 * the reader down every time they expand an old group, which is exactly when they least want to
 * move. So the effect watches the last row's id, and `atBottom` comes from an
 * `IntersectionObserver` on a sentinel rather than from arithmetic on `scrollTop` — no listener, no
 * layout thrash, and it is correct while the container is being resized.
 *
 * jsdom has no `IntersectionObserver`; without one the hook degrades to "always at the bottom",
 * which is the behaviour a page with nothing to scroll should have anyway.
 */
import { type MutableRefObject, useEffect, useRef, useState } from 'react'

/** jsdom implements neither `IntersectionObserver` nor `scrollIntoView`; both are cosmetic here. */
function scrollIntoView(node: HTMLElement | null, behavior: ScrollBehavior) {
  node?.scrollIntoView?.({ behavior, block: 'end' })
}

export interface StickToBottom {
  /** Put this on an empty element after the last row. */
  sentinelRef: MutableRefObject<HTMLDivElement | null>
  atBottom: boolean
  /** How many rows arrived while the reader was away — the "Jump to latest · 4 new" pill. */
  unseen: number
  scrollToBottom: () => void
}

export function useStickToBottom(lastRowId: string | undefined, rowCount: number): StickToBottom {
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [unseen, setUnseen] = useState(0)
  const seenCount = useRef(rowCount)

  useEffect(() => {
    const node = sentinelRef.current
    if (!node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      entries => setAtBottom(entries.some(entry => entry.isIntersecting)),
      { rootMargin: '0px 0px 64px 0px' }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (lastRowId === undefined) return
    if (atBottom) {
      seenCount.current = rowCount
      setUnseen(0)
      scrollIntoView(sentinelRef.current, 'auto')
      return
    }
    setUnseen(Math.max(0, rowCount - seenCount.current))
    // `lastRowId` and not the count: a collapsed group changes the height, never the last id.
  }, [lastRowId, atBottom, rowCount])

  return {
    sentinelRef,
    atBottom,
    unseen,
    scrollToBottom: () => {
      seenCount.current = rowCount
      setUnseen(0)
      scrollIntoView(sentinelRef.current, 'smooth')
    },
  }
}
