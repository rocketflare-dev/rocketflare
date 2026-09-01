/**
 * `NotificationsHub` Durable Object (D5, D8): one instance per tenant (`idFromName(tenantId)`),
 * exported from `src/worker.ts`. Hibernation API — sockets are accepted with `tenant:`/`user:`
 * tags, per-socket metadata lives in the attachment, and `setWebSocketAutoResponse` answers
 * `{"type":"ping"}` without waking the object. Stateless: no `ctx.storage`, so migrations are free.
 *
 * `fetch()` handles ONLY the WebSocket upgrade forwarded by `routes/ws.ts`. It trusts the
 * `X-Tenant-Id` / `X-User-Id` / `X-Session-Id` headers because the object is reachable solely via
 * the `NOTIFICATIONS_HUB` binding — the route did cookie → session → membership before forwarding.
 * Publishing is RPC (`broadcast`, `broadcastToUser`, `broadcastToUsers`, `connectionCount`), never
 * fetch dispatch; `services/realtime.ts` is the only caller.
 */

import { DurableObject } from 'cloudflare:workers'
import type { RealtimeEvent } from '@gmgo/shared/realtime'
import type { AppBindings } from '../types'

/** Survives hibernation via `serializeAttachment`; the tags carry tenant and user. */
export interface HubAttachment {
  userId: string
  sessionId: string
  connectedAt: string
}

export interface BroadcastResult {
  delivered: number
}

export const HUB_HEADERS = {
  tenantId: 'X-Tenant-Id',
  userId: 'X-User-Id',
  sessionId: 'X-Session-Id',
} as const

const PING = JSON.stringify({ type: 'ping' })
const PONG = JSON.stringify({ type: 'pong' })

function badRequest(error: string): Response {
  return new Response(JSON.stringify({ error, statusCode: 400, code: 'bad_request' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  })
}

export class NotificationsHub extends DurableObject<AppBindings> {
  constructor(ctx: DurableObjectState, env: AppBindings) {
    super(ctx, env)
    // Keepalives are answered by the runtime; a hibernated object stays asleep.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG))
  }

  /** The upgrade forwarded by `GET /ws`. Anything else is a 400 — there is no other surface. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return badRequest('Expected a WebSocket upgrade')
    }
    const tenantId = request.headers.get(HUB_HEADERS.tenantId)
    const userId = request.headers.get(HUB_HEADERS.userId)
    const sessionId = request.headers.get(HUB_HEADERS.sessionId)
    if (!tenantId || !userId || !sessionId) {
      return badRequest('Missing hub identity headers')
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    // Tags are immutable after accept and indexed by the runtime — `getWebSockets(tag)` is O(match).
    this.ctx.acceptWebSocket(server, [`tenant:${tenantId}`, `user:${userId}`])
    const attachment: HubAttachment = { userId, sessionId, connectedAt: new Date().toISOString() }
    server.serializeAttachment(attachment)

    return new Response(null, { status: 101, webSocket: client })
  }

  // ---- RPC ---------------------------------------------------------------------------------

  /** Every socket in this tenant's hub. */
  async broadcast(event: RealtimeEvent): Promise<BroadcastResult> {
    return this.deliver(this.ctx.getWebSockets(), event)
  }

  async broadcastToUser(userId: string, event: RealtimeEvent): Promise<BroadcastResult> {
    return this.deliver(this.ctx.getWebSockets(`user:${userId}`), event)
  }

  async broadcastToUsers(userIds: string[], event: RealtimeEvent): Promise<BroadcastResult> {
    const sockets = new Set<WebSocket>()
    for (const userId of new Set(userIds)) {
      for (const ws of this.ctx.getWebSockets(`user:${userId}`)) sockets.add(ws)
    }
    return this.deliver([...sockets], event)
  }

  async connectionCount(): Promise<{ count: number }> {
    return { count: this.ctx.getWebSockets().length }
  }

  private deliver(sockets: WebSocket[], event: RealtimeEvent): BroadcastResult {
    const payload = JSON.stringify(event)
    let delivered = 0
    for (const ws of sockets) {
      try {
        ws.send(payload)
        delivered++
      } catch {
        // A socket the runtime has not yet reaped; closing it lets the client reconnect.
        try {
          ws.close(1011, 'send failed')
        } catch {
          // already closed
        }
      }
    }
    return { delivered }
  }

  // ---- Hibernation handlers ----------------------------------------------------------------

  /** Clients only ever send keepalives; `ping` is normally auto-answered before reaching here. */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    try {
      const data = JSON.parse(message) as { type?: unknown }
      if (data.type === 'ping') ws.send(PONG)
    } catch {
      // ignore malformed frames
    }
  }

  async webSocketClose(): Promise<void> {
    // The runtime drops the socket and its tags; nothing else is held per connection.
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'websocket error')
    } catch {
      // already closed
    }
  }
}
