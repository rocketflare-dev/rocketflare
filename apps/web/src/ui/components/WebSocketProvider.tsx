/**
 * Realtime bridge (D8, 06 §b): connects the singleton `websocketClient` once `useAuth()` is
 * authenticated AND has a tenant, reconnects when the tenant changes, disconnects on sign-out.
 * Every event becomes query invalidations through `invalidationsFor` (`@rocketflare/shared/realtime`) —
 * the client re-queries, it never applies a payload as state — and a `notification.created` shows
 * a toast. Components subscribe to query state, never to the socket.
 */
import { invalidationsFor, type RealtimeEvent } from '@rocketflare/shared/realtime'
import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect } from 'react'
import { useAuth } from '@/ui/hooks/useAuth'
import { websocketClient } from '@/ui/lib/websocketClient'
import { showToast } from './shared/Toast'

function notificationTitle(event: RealtimeEvent): string {
  const payload = event.payload as { title?: unknown } | undefined
  return typeof payload?.title === 'string' && payload.title ? payload.title : 'New notification'
}

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const { status, tenant } = useAuth()
  const queryClient = useQueryClient()
  const tenantId = status === 'authenticated' ? (tenant?.id ?? null) : null

  useEffect(() => {
    if (!tenantId) {
      websocketClient.disconnect()
      return
    }
    websocketClient.connect(tenantId)
    // Sign-out / tenant loss disconnects via the branch above; a tenant switch reconnects in place.
  }, [tenantId])

  useEffect(
    () =>
      websocketClient.onEvent(event => {
        for (const queryKey of invalidationsFor(event)) {
          void queryClient.invalidateQueries({ queryKey })
        }
        if (event.type === 'notification.created') showToast(notificationTitle(event), 'info')
      }),
    [queryClient]
  )

  return <>{children}</>
}
