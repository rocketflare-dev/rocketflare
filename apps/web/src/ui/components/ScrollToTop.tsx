import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'

/**
 * Scroll to the top on forward navigation, restore the saved position on back/forward.
 * Hash and query changes on the same pathname do not scroll.
 */
export default function ScrollToTop() {
  const { pathname } = useLocation()
  const prevPathnameRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    const prevPathname = prevPathnameRef.current
    prevPathnameRef.current = pathname

    if (!prevPathname || prevPathname === pathname) return

    const saved = sessionStorage.getItem(`scroll-${pathname}`)
    const historyState = window.history.state as { idx?: number } | null
    const isBackForward = historyState?.idx !== undefined && saved !== null

    if (isBackForward && saved) {
      const scrollY = Number.parseInt(saved, 10)
      setTimeout(() => window.scrollTo(0, scrollY), 0)
    } else {
      sessionStorage.setItem(`scroll-${prevPathname}`, String(window.scrollY))
      window.scrollTo(0, 0)
    }
  }, [pathname])

  return null
}
