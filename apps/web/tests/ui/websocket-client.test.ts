/**
 * `lib/websocketClient.ts` (D8): backoff schedule with full jitter, the deploy fast path
 * (close 1001/1012 → 100 ms), heartbeat, event fan-out, tenant switch and disconnect — driven
 * through an injected fake socket factory and fake timers, no React.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  computeBackoffDelay,
  FAST_RECONNECT_MS,
  HEARTBEAT_MS,
  isUpgradeClose,
  MAX_BACKOFF_MS,
  websocketClient,
  websocketUrl,
} from '@/ui/lib/websocketClient'
import { useWebSocketStore } from '@/ui/stores/websocketStore'

class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  closedWith: [number, string] | null = null
  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  message(data: unknown) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) })
  }
  serverClose(code: number, reason = '') {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
  send(data: string) {
    this.sent.push(data)
  }
  close(code: number, reason: string) {
    this.readyState = 3
    this.closedWith = [code, reason]
  }
}

const latest = () => FakeSocket.instances.at(-1) as FakeSocket
const status = () => useWebSocketStore.getState().status

describe('computeBackoffDelay', () => {
  it('doubles from 1 s and caps at 30 s (upper edge of the jitter window)', () => {
    const upper = [1, 2, 3, 4, 5, 6, 7, 20].map(n => computeBackoffDelay(n, () => 1))
    expect(upper).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, MAX_BACKOFF_MS])
  })

  it('full jitter: the lower edge is half the base', () => {
    expect(computeBackoffDelay(1, () => 0)).toBe(500)
    expect(computeBackoffDelay(4, () => 0)).toBe(4000)
    const d = computeBackoffDelay(3)
    expect(d).toBeGreaterThanOrEqual(2000)
    expect(d).toBeLessThanOrEqual(4000)
  })
})

describe('isUpgradeClose', () => {
  it('recognises the runtime codes and the upgrade reasons', () => {
    expect(isUpgradeClose(1012)).toBe(true)
    expect(isUpgradeClose(1001, '')).toBe(true)
    expect(isUpgradeClose(4000, 'Worker upgraded')).toBe(true)
    expect(isUpgradeClose(4000, 'new version deployed')).toBe(true)
    expect(isUpgradeClose(1006)).toBe(false)
    expect(isUpgradeClose(1000, 'bye')).toBe(false)
  })
})

describe('websocketUrl', () => {
  it('is same-origin, http → ws, with the tenant id encoded', () => {
    expect(websocketUrl('t 1', 'https://app.example')).toBe('wss://app.example/ws?tenantId=t%201')
    expect(websocketUrl('t1', 'http://localhost:3000')).toBe('ws://localhost:3000/ws?tenantId=t1')
  })
})

describe('websocketClient', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeSocket.instances = []
    websocketClient.setFactory(url => new FakeSocket(url) as unknown as WebSocket)
  })
  afterEach(() => {
    websocketClient.disconnect()
    websocketClient.setFactory(null)
    useWebSocketStore.getState().reset()
    vi.useRealTimers()
  })

  it('connects, reports open, and heartbeats with {"type":"ping"}', () => {
    websocketClient.connect('tenant-a')
    expect(FakeSocket.instances).toHaveLength(1)
    expect(latest().url).toContain('/ws?tenantId=tenant-a')
    expect(status()).toBe('connecting')
    latest().open()
    expect(status()).toBe('open')
    expect(useWebSocketStore.getState().connectedAt).not.toBeNull()
    vi.advanceTimersByTime(HEARTBEAT_MS)
    expect(latest().sent).toEqual([JSON.stringify({ type: 'ping' })])
    // Idempotent for the same tenant.
    websocketClient.connect('tenant-a')
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('fans events out to listeners and records lastEvent; pongs and junk are ignored', () => {
    const seen: unknown[] = []
    const off = websocketClient.onEvent(e => seen.push(e))
    websocketClient.connect('tenant-a')
    latest().open()
    const event = {
      type: 'notification.created',
      tenantId: 'tenant-a',
      at: '2026-09-01T00:00:00.000Z',
      payload: { title: 'Hi' },
    }
    latest().message(event)
    latest().message({ type: 'pong' })
    latest().message('{not json')
    latest().message({ type: 'bogus', tenantId: 'x', at: 'now' })
    expect(seen).toEqual([event])
    expect(useWebSocketStore.getState().lastEvent).toEqual(event)
    off()
    latest().message(event)
    expect(seen).toHaveLength(1)
  })

  it('reconnects with backoff after an abnormal close, resetting the attempt on open', () => {
    websocketClient.connect('tenant-a')
    latest().open()
    latest().serverClose(1006)
    expect(status()).toBe('closed')
    expect(useWebSocketStore.getState().attempt).toBe(1)
    expect(FakeSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(MAX_BACKOFF_MS) // ≥ the first window (500–1000 ms)
    expect(FakeSocket.instances).toHaveLength(2)
    latest().serverClose(1006)
    expect(useWebSocketStore.getState().attempt).toBe(2)
    vi.advanceTimersByTime(999) // below the second window's floor (1000 ms)
    expect(FakeSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(MAX_BACKOFF_MS)
    expect(FakeSocket.instances).toHaveLength(3)
    latest().open()
    expect(useWebSocketStore.getState().attempt).toBe(0)
    expect(status()).toBe('open')
  })

  it('fast path: a 1012 (worker upgraded) close reconnects in 100 ms without counting a failure', () => {
    websocketClient.connect('tenant-a')
    latest().open()
    latest().serverClose(1012, 'Worker upgraded')
    expect(useWebSocketStore.getState().attempt).toBe(0)
    vi.advanceTimersByTime(FAST_RECONNECT_MS - 1)
    expect(FakeSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(2)
    expect(latest().url).toContain('tenantId=tenant-a')
  })

  it('switching tenant closes the old socket cleanly and opens the new URL', () => {
    websocketClient.connect('tenant-a')
    const first = latest()
    first.open()
    websocketClient.connect('tenant-b')
    expect(first.closedWith).toEqual([1000, 'client disconnect'])
    expect(FakeSocket.instances).toHaveLength(2)
    expect(latest().url).toContain('tenantId=tenant-b')
    // A late close from the old socket must not schedule anything.
    first.onclose?.({ code: 1006, reason: '' })
    vi.advanceTimersByTime(MAX_BACKOFF_MS)
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('disconnect closes with 1000 and stops reconnecting', () => {
    websocketClient.connect('tenant-a')
    latest().open()
    websocketClient.disconnect()
    expect(latest().closedWith).toEqual([1000, 'client disconnect'])
    expect(status()).toBe('closed')
    vi.advanceTimersByTime(MAX_BACKOFF_MS * 2)
    expect(FakeSocket.instances).toHaveLength(1)
  })
})
