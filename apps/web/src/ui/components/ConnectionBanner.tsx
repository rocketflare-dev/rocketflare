/**
 * Degraded-realtime banner (D8): shown once the socket has been away from `open` for longer than
 * `DEGRADED_AFTER_MS` while signed in with a tenant. Lists stay correct (the DB is the truth and
 * every mutation invalidates), they just stop refreshing live — so the copy says exactly that.
 */
import { useEffect, useState } from 'react'
import { useWebSocketStore } from '@/ui/stores/websocketStore'

export const DEGRADED_AFTER_MS = 5000

function useNow(active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [active, everyMs])
  return now
}

export function ConnectionBanner({ className = '' }: { className?: string }) {
  const status = useWebSocketStore(s => s.status)
  const disconnectedAt = useWebSocketStore(s => s.disconnectedAt)
  const attempt = useWebSocketStore(s => s.attempt)
  const degraded = status !== 'open' && disconnectedAt !== null
  const now = useNow(degraded)
  if (!degraded || now - new Date(disconnectedAt).getTime() < DEGRADED_AFTER_MS) return null

  return (
    <div role="status" className={`alert alert-warning alert-soft py-2 text-sm ${className}`}>
      <span>
        Live updates are reconnecting{attempt > 1 ? ` (attempt ${attempt})` : ''}. Data is still
        saved; lists refresh when the connection returns.
      </span>
    </div>
  )
}

export default ConnectionBanner
