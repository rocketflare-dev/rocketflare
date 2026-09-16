/**
 * Live run progress on the client (issue #7): the transport's cursor, the hook's cache rule, and
 * the one thing that quietly turns the whole feature back into a poll — a realtime nudge landing
 * on the key the stream is appending to.
 */
import { AguiEventType, type KitAguiEvent } from '@rocketflare/shared/ai/agui'
import { invalidationsFor, REALTIME_INVALIDATIONS } from '@rocketflare/shared/realtime'
import { QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamEnabled, useRunStream } from '@/ui/hooks/useRunStream'
import { queryKeys } from '@/ui/lib/query-keys'
import { streamRunAgui } from '@/ui/lib/runAguiStream'
import { createTestQueryClient } from './helpers/renderWithProviders'

const RUN_ID = '11111111-1111-4111-8111-111111111111'

const started: KitAguiEvent = { type: AguiEventType.RUN_STARTED, threadId: RUN_ID, runId: RUN_ID }
const textStart = (id: string): KitAguiEvent => ({
  type: AguiEventType.TEXT_MESSAGE_START,
  messageId: id,
  role: 'assistant',
})
const textContent = (id: string, delta: string): KitAguiEvent => ({
  type: AguiEventType.TEXT_MESSAGE_CONTENT,
  messageId: id,
  delta,
})
const textEnd = (id: string): KitAguiEvent => ({
  type: AguiEventType.TEXT_MESSAGE_END,
  messageId: id,
})

/** Frames exactly as the server writes them: `data:` only, `id:` on the last of a group. */
function frames(groups: { events: KitAguiEvent[]; seq?: number }[]): string {
  return groups
    .flatMap(({ events, seq }) =>
      events.map((event, i) => {
        const last = i === events.length - 1
        const idLine = last && seq !== undefined ? `id: ${seq}\n` : ''
        return `${idLine}data: ${JSON.stringify(event)}\n\n`
      })
    )
    .join('')
}

function sseBody(text: string): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(text))
        c.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('streamRunAgui (the transport)', () => {
  it('advances the cursor only on a frame that carries one — never mid-group', async () => {
    const body = frames([
      { events: [started], seq: 0 },
      { events: [textStart('m1'), textContent('m1', 'Hi'), textEnd('m1')], seq: 7 },
    ])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseBody(body))
    )
    const seen: number[] = []
    const result = await streamRunAgui({
      runId: RUN_ID,
      onEvent: (_e, lastSeq) => seen.push(lastSeq),
    })
    // The three frames of the group all report the cursor as it stood BEFORE the group closed,
    // then 7 on its last frame. A drop at any point resumes at 0 and replays the group whole.
    expect(seen).toEqual([0, 0, 0, 7])
    expect(result.lastSeq).toBe(7)
    expect(result.received).toBe(4)
    expect(result.terminal).toBe(false)
  })

  it('sends the cursor as ?afterSeq= rather than relying on Last-Event-ID', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => sseBody(''))
    vi.stubGlobal('fetch', fetchMock)
    await streamRunAgui({ runId: RUN_ID, afterSeq: 12, onEvent: () => {} })
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('afterSeq=12')
  })

  it('reports a terminal event, and a run that just closed is NOT one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody(
          frames([
            {
              events: [{ type: AguiEventType.RUN_FINISHED, threadId: RUN_ID, runId: RUN_ID }],
            },
          ])
        )
      )
    )
    expect((await streamRunAgui({ runId: RUN_ID, onEvent: () => {} })).terminal).toBe(true)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseBody(''))
    )
    const quiet = await streamRunAgui({ runId: RUN_ID, onEvent: () => {} })
    expect(quiet.terminal).toBe(false)
    expect(quiet.received).toBe(0)
  })

  it('throws the shared envelope for a pre-stream failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'Agent run not found', statusCode: 404 }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          })
      )
    )
    await expect(streamRunAgui({ runId: RUN_ID, onEvent: () => {} })).rejects.toThrow(
      'Agent run not found'
    )
  })
})

describe('streamEnabled', () => {
  it('opens for a run that still owes work and for nothing else', () => {
    expect(streamEnabled('queued')).toBe(true)
    expect(streamEnabled('running')).toBe(true)
    // Parked: the server answers with the interrupt outcome and closes at once, so reconnecting
    // would be a hot loop of one-frame connections. The nudge re-opens it when the answer lands.
    expect(streamEnabled('awaiting_input')).toBe(false)
    expect(streamEnabled('succeeded')).toBe(false)
    expect(streamEnabled('failed')).toBe(false)
    expect(streamEnabled('cancelled')).toBe(false)
    expect(streamEnabled(undefined)).toBe(false)
  })
})

describe("['agent-run-agui'] is deliberately not a nudge target", () => {
  it('is absent from the invalidation table and from every entity.changed root the runtime emits', () => {
    // The runtime nudges `entity: 'agent-run'` on EVERY durable row it writes. If the accumulated
    // AG-UI list lived under that root, each of those nudges would throw away what the stream just
    // built and re-fetch the whole run — the stream would be a more expensive poll.
    for (const roots of Object.values(REALTIME_INVALIDATIONS)) {
      for (const root of roots) expect(root[0]).not.toBe('agent-run-agui')
    }
    const nudge = invalidationsFor({
      type: 'entity.changed',
      tenantId: 't',
      at: new Date().toISOString(),
      payload: { entity: 'agent-run', id: RUN_ID },
    })
    expect(nudge).toEqual([queryKeys.agentRuns.all])
    expect(nudge).not.toContainEqual(queryKeys.agentRunAgui.all)
  })

  it('a run nudge leaves the streamed list untouched', () => {
    const queryClient = createTestQueryClient()
    const key = queryKeys.agentRunAgui.detail(RUN_ID)
    queryClient.setQueryData(key, { events: [started], lastSeq: 3 })
    for (const root of invalidationsFor({
      type: 'entity.changed',
      tenantId: 't',
      at: new Date().toISOString(),
      payload: { entity: 'agent-run', id: RUN_ID },
    })) {
      void queryClient.invalidateQueries({ queryKey: root })
    }
    expect(queryClient.getQueryData(key)).toEqual({ events: [started], lastSeq: 3 })
  })
})

describe('useRunStream', () => {
  const wrapper = (queryClient = createTestQueryClient()) => {
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    return { Wrapper, queryClient }
  }

  it('renders the snapshot, then appends what the stream delivers — one cache entry, one writer', async () => {
    const snapshot = { events: [started], lastSeq: 4 }
    const tail = frames([
      { events: [textStart('m1'), textContent('m1', 'Live'), textEnd('m1')], seq: 5 },
      { events: [{ type: AguiEventType.RUN_FINISHED, threadId: RUN_ID, runId: RUN_ID }] },
    ])
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/agui/stream')) return sseBody(tail)
      return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { Wrapper, queryClient } = wrapper()
    const { result } = renderHook(() => useRunStream(RUN_ID), { wrapper: Wrapper })

    await waitFor(() => expect(result.current.terminal).toBe(true))
    expect(result.current.events.map(e => e.type)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED',
    ])
    // It resumed from the snapshot's cursor rather than replaying the run.
    const streamCall = fetchMock.mock.calls.find(c => String(c[0]).includes('/agui/stream'))
    expect(String(streamCall?.[0])).toContain('afterSeq=4')
    // The run row family is invalidated exactly once, on the terminal frame; the list is not.
    expect(queryClient.getQueryData(queryKeys.agentRunAgui.detail(RUN_ID))).toMatchObject({
      lastSeq: 5,
    })
  })

  it('falls back to polling after three connections that delivered nothing', async () => {
    let streams = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/agui/stream')) {
          streams += 1
          return sseBody('')
        }
        return new Response(JSON.stringify({ events: [], lastSeq: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      })
    )
    const { Wrapper } = wrapper()
    const { result } = renderHook(() => useRunStream(RUN_ID), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.fallback).toBe(true))
    expect(streams).toBe(3)
  })

  it('opens nothing at all when disabled', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(JSON.stringify({ events: [], lastSeq: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    const { Wrapper } = wrapper()
    renderHook(() => useRunStream(RUN_ID, { enabled: false }), { wrapper: Wrapper })
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls.some(c => String(c[0]).includes('/agui/stream'))).toBe(false)
  })
})
