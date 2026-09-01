/**
 * The one zustand store (D8): websocket connection state and the last event seen. TanStack Query
 * owns server state — this store never holds rows. `WebSocketStatus` and `ConnectionBanner` read
 * `status`/`disconnectedAt`; feature hooks may watch `lastEvent` for a specific `type`. Written only
 * by `lib/websocketClient.ts`.
 */
import type { RealtimeEvent } from '@rocketflare/shared/realtime'
import { create } from 'zustand'

export type WebSocketStatus = 'connecting' | 'open' | 'closed'

export interface WebSocketState {
  status: WebSocketStatus
  /** Set on open; cleared on close. */
  connectedAt: string | null
  /** When the socket last left `open` (or first failed to open); null while open or never tried. */
  disconnectedAt: string | null
  /** Reconnect attempts since the last successful open. */
  attempt: number
  lastEvent: RealtimeEvent | null
  setStatus: (status: WebSocketStatus, attempt?: number) => void
  setLastEvent: (event: RealtimeEvent) => void
  reset: () => void
}

const initial = {
  status: 'closed' as WebSocketStatus,
  connectedAt: null,
  disconnectedAt: null,
  attempt: 0,
  lastEvent: null,
}

export const useWebSocketStore = create<WebSocketState>(set => ({
  ...initial,
  setStatus: (status, attempt) =>
    set(state => {
      const now = new Date().toISOString()
      if (status === 'open') return { status, attempt: 0, connectedAt: now, disconnectedAt: null }
      return {
        status,
        attempt: attempt ?? state.attempt,
        connectedAt: null,
        // Keep the FIRST drop time so the banner measures the whole outage, not the last retry.
        disconnectedAt: state.disconnectedAt ?? now,
      }
    }),
  setLastEvent: event => set({ lastEvent: event }),
  reset: () => set({ ...initial }),
}))
