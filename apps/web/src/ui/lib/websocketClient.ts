/**
 * Singleton WebSocket client (D8), outside the React lifecycle. Same-origin `/ws?tenantId=` so the
 * Vite proxy forwards it in dev and the Worker serves it deployed. Reconnects with exponential
 * backoff + full jitter (1 s → 30 s cap) so a fleet of tabs recovering from one drop does not
 * stampede the hub; a close with code 1001/1012 or an "upgraded"/"new version" reason means the
 * Worker was redeployed (Durable Objects evict sockets on a new version) and reconnects in 100 ms
 * without counting as a failure. Sends `{"type":"ping"}` every 30 s — the DO answers without waking.
 *
 * State is pushed into `stores/websocketStore.ts`; events go to `onEvent` subscribers
 * (`WebSocketProvider` turns them into query invalidations). Components never touch this module.
 */
import { type RealtimeEvent, realtimeEventSchema } from '@gmgo/shared/realtime'
import { useWebSocketStore } from '../stores/websocketStore'

export const BASE_BACKOFF_MS = 1000
export const MAX_BACKOFF_MS = 30_000
export const FAST_RECONNECT_MS = 100
export const HEARTBEAT_MS = 30_000
/** Close codes the runtime uses when the Worker behind the socket was replaced. */
export const UPGRADE_CLOSE_CODES = new Set([1001, 1012])
/** `WebSocket.OPEN`, without depending on the global (tests inject a factory). */
const OPEN = 1

/** Full-jitter exponential backoff: uniform in `[base/2, base]`, `base = min(1s · 2^attempt, 30s)`. */
export function computeBackoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS)
  return Math.round(base / 2 + random() * (base / 2))
}

/** A deploy closed the socket: reconnect at once, the new version is already serving. */
export function isUpgradeClose(code: number, reason = ''): boolean {
  if (UPGRADE_CLOSE_CODES.has(code)) return true
  const text = reason.toLowerCase()
  return text.includes('upgraded') || text.includes('new version')
}

export function websocketUrl(tenantId: string, origin = window.location.origin): string {
  return `${origin.replace(/^http/, 'ws')}/ws?tenantId=${encodeURIComponent(tenantId)}`
}

export type EventListener = (event: RealtimeEvent) => void

/** Pluggable so tests inject a fake without touching `globalThis.WebSocket`. */
export type WebSocketFactory = (url: string) => WebSocket

class WebSocketClient {
  private ws: WebSocket | null = null
  private tenantId: string | null = null
  /** Increments on every connect/disconnect so stale socket callbacks are ignored. */
  private generation = 0
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private readonly listeners = new Set<EventListener>()
  private factory: WebSocketFactory = url => new WebSocket(url)

  /** Test seam. */
  setFactory(factory: WebSocketFactory | null): void {
    this.factory = factory ?? (url => new WebSocket(url))
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Idempotent for the same tenant; a different tenant tears the socket down and reconnects. */
  connect(tenantId: string): void {
    if (this.tenantId === tenantId && (this.ws || this.reconnectTimer)) return
    if (this.tenantId !== tenantId) this.teardown()
    this.tenantId = tenantId
    this.attempt = 0
    this.open()
  }

  disconnect(): void {
    this.teardown()
    this.tenantId = null
    useWebSocketStore.getState().setStatus('closed')
  }

  getAttempt(): number {
    return this.attempt
  }

  private teardown(): void {
    this.generation++
    this.clearTimers()
    if (this.ws) {
      const ws = this.ws
      this.ws = null
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      try {
        ws.close(1000, 'client disconnect')
      } catch {
        // already closed
      }
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.reconnectTimer = null
    this.heartbeatTimer = null
  }

  private open(): void {
    if (!this.tenantId) return
    const store = useWebSocketStore.getState()
    const generation = ++this.generation
    store.setStatus('connecting', this.attempt)

    let ws: WebSocket
    try {
      ws = this.factory(websocketUrl(this.tenantId))
    } catch {
      this.scheduleReconnect(false)
      return
    }
    this.ws = ws

    ws.onopen = () => {
      if (generation !== this.generation) return
      this.attempt = 0
      useWebSocketStore.getState().setStatus('open')
      this.heartbeatTimer = setInterval(() => {
        if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: 'ping' }))
      }, HEARTBEAT_MS)
    }

    ws.onmessage = ({ data }) => {
      if (generation !== this.generation || typeof data !== 'string') return
      let parsed: unknown
      try {
        parsed = JSON.parse(data)
      } catch {
        return
      }
      if ((parsed as { type?: unknown })?.type === 'pong') return
      const result = realtimeEventSchema.safeParse(parsed)
      if (!result.success) return
      const event = result.data
      if (event.type === 'ping') return
      useWebSocketStore.getState().setLastEvent(event)
      for (const listener of this.listeners) listener(event)
    }

    ws.onclose = event => {
      if (generation !== this.generation) return
      this.ws = null
      this.clearTimers()
      this.scheduleReconnect(isUpgradeClose(event.code, event.reason))
    }

    ws.onerror = () => {
      // The matching `close` event carries the reconnect; nothing to do here.
    }
  }

  private scheduleReconnect(upgraded: boolean): void {
    if (!this.tenantId) return
    const delay = upgraded ? FAST_RECONNECT_MS : computeBackoffDelay(++this.attempt)
    useWebSocketStore.getState().setStatus('closed', this.attempt)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, delay)
  }
}

export const websocketClient = new WebSocketClient()
