// @vitest-isolate
// Stubs the `WebSocketRequestResponsePair` global, so this file needs its own module registry.
/**
 * `NotificationsHub` DO unit tests (D8, D15): the class under Node with a fake `DurableObjectState`
 * (tagged fake sockets with `send` spies). Covers the RPC surface — `broadcast`, `broadcastToUser`,
 * `broadcastToUsers`, `connectionCount` — plus `fetch`'s 400 guards and the keepalive fallback. The
 * 101 upgrade itself cannot run under Node (undici rejects status 101); `wrangler dev` proves it.
 */
import type { RealtimeEvent } from '@gmgo/shared/realtime'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { HUB_HEADERS, NotificationsHub } from '@/api/durable-objects/notifications-hub'
import { createTestEnv } from '../mocks/bindings'

interface FakeSocket {
  tags: string[]
  send: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  serializeAttachment: ReturnType<typeof vi.fn>
  attachment: unknown
}

function socket(tags: string[], sendImpl?: () => void): FakeSocket {
  const s: FakeSocket = {
    tags,
    send: vi.fn(sendImpl),
    close: vi.fn(),
    serializeAttachment: vi.fn(a => {
      s.attachment = a
    }),
    attachment: null,
  }
  return s
}

function fakeCtx(sockets: FakeSocket[]) {
  return {
    autoResponse: null as unknown,
    setWebSocketAutoResponse: vi.fn(function (this: { autoResponse: unknown }, pair: unknown) {
      this.autoResponse = pair
    }),
    acceptWebSocket: vi.fn((ws: FakeSocket, tags: string[]) => {
      ws.tags = tags
      sockets.push(ws)
    }),
    getWebSockets: vi.fn((tag?: string) =>
      tag ? sockets.filter(s => s.tags.includes(tag)) : [...sockets]
    ),
  }
}

function hub(sockets: FakeSocket[]) {
  const ctx = fakeCtx(sockets)
  const instance = new NotificationsHub(
    ctx as unknown as DurableObjectState,
    createTestEnv() as unknown as Cloudflare.Env
  )
  return { instance, ctx }
}

const event: RealtimeEvent = {
  type: 'member.changed',
  tenantId: 't1',
  at: '2026-09-01T00:00:00.000Z',
  payload: { id: 'u1' },
}

beforeAll(() => {
  vi.stubGlobal(
    'WebSocketRequestResponsePair',
    class {
      constructor(
        public request: string,
        public response: string
      ) {}
    }
  )
})
afterAll(() => vi.unstubAllGlobals())

describe('NotificationsHub', () => {
  it('registers a ping → pong auto-response in the constructor (hibernation-safe keepalive)', () => {
    const { ctx } = hub([])
    expect(ctx.setWebSocketAutoResponse).toHaveBeenCalledTimes(1)
    expect(ctx.autoResponse).toMatchObject({
      request: JSON.stringify({ type: 'ping' }),
      response: JSON.stringify({ type: 'pong' }),
    })
  })

  it('fetch: 400 unless it is a WebSocket upgrade with the three identity headers', async () => {
    const { instance } = hub([])
    const plain = await instance.fetch(new Request('https://hub/'))
    expect(plain.status).toBe(400)
    expect(await plain.json()).toMatchObject({ statusCode: 400, code: 'bad_request' })

    const partial = await instance.fetch(
      new Request('https://hub/', {
        headers: { Upgrade: 'websocket', [HUB_HEADERS.tenantId]: 't1', [HUB_HEADERS.userId]: 'u1' },
      })
    )
    expect(partial.status).toBe(400)
    expect(await partial.json()).toMatchObject({ error: 'Missing hub identity headers' })
  })

  it('broadcast sends the serialised event to every socket and counts deliveries', async () => {
    const a = socket(['tenant:t1', 'user:u1'])
    const b = socket(['tenant:t1', 'user:u2'])
    const { instance } = hub([a, b])
    await expect(instance.broadcast(event)).resolves.toEqual({ delivered: 2 })
    expect(a.send).toHaveBeenCalledWith(JSON.stringify(event))
    expect(JSON.parse(b.send.mock.calls[0]?.[0] as string)).toEqual(event)
  })

  it('broadcastToUser targets the user tag only', async () => {
    const a = socket(['tenant:t1', 'user:u1'])
    const a2 = socket(['tenant:t1', 'user:u1'])
    const b = socket(['tenant:t1', 'user:u2'])
    const { instance } = hub([a, a2, b])
    await expect(instance.broadcastToUser('u1', event)).resolves.toEqual({ delivered: 2 })
    expect(b.send).not.toHaveBeenCalled()
    await expect(instance.broadcastToUser('nobody', event)).resolves.toEqual({ delivered: 0 })
  })

  it('broadcastToUsers de-duplicates users and sockets', async () => {
    const a = socket(['tenant:t1', 'user:u1'])
    const b = socket(['tenant:t1', 'user:u2'])
    const c = socket(['tenant:t1', 'user:u3'])
    const { instance } = hub([a, b, c])
    await expect(instance.broadcastToUsers(['u1', 'u2', 'u1'], event)).resolves.toEqual({
      delivered: 2,
    })
    expect(a.send).toHaveBeenCalledTimes(1)
    expect(c.send).not.toHaveBeenCalled()
  })

  it('a socket whose send throws is closed with 1011 and not counted', async () => {
    const good = socket(['tenant:t1', 'user:u1'])
    const bad = socket(['tenant:t1', 'user:u2'], () => {
      throw new Error('gone')
    })
    const { instance } = hub([good, bad])
    await expect(instance.broadcast(event)).resolves.toEqual({ delivered: 1 })
    expect(bad.close).toHaveBeenCalledWith(1011, 'send failed')
  })

  it('connectionCount reports the live sockets', async () => {
    const { instance } = hub([socket(['tenant:t1']), socket(['tenant:t1'])])
    await expect(instance.connectionCount()).resolves.toEqual({ count: 2 })
  })

  it('webSocketMessage answers a ping and ignores everything else', async () => {
    const s = socket(['tenant:t1', 'user:u1'])
    const { instance } = hub([s])
    const ws = s as unknown as WebSocket
    await instance.webSocketMessage(ws, JSON.stringify({ type: 'ping' }))
    expect(s.send).toHaveBeenCalledWith(JSON.stringify({ type: 'pong' }))
    await instance.webSocketMessage(ws, 'not json')
    await instance.webSocketMessage(ws, JSON.stringify({ type: 'subscribe' }))
    await instance.webSocketMessage(ws, new ArrayBuffer(2))
    expect(s.send).toHaveBeenCalledTimes(1)
    await instance.webSocketError(ws)
    expect(s.close).toHaveBeenCalledWith(1011, 'websocket error')
  })
})
