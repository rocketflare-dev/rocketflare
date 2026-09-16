/**
 * Live run progress (issue #7): the run's AG-UI timeline, filling in ~500 ms instead of 3-second
 * poll lumps.
 *
 * **Additive by construction.** The run page is built against the poll path; this hook is the
 * upgrade, and deleting it must leave a working page. That is why it owns one cache entry of its
 * own and nothing else.
 *
 * The cache rule, flatly: **the stream is the only writer of `['agent-run-agui', id]`**, appends
 * to it with `setQueryData`, and never touches the run row. A terminal frame invalidates
 * `queryKeys.agentRuns.all` ONCE so the row and the list catch up. Nothing else — in particular a
 * terminal status is never synthesised client-side, which is how a UI comes to claim success for a
 * run the server later marks failed.
 *
 * The query is the snapshot and the fallback in one: it fetches `GET /runs/:id/agui` on mount (so
 * the page renders the backlog immediately and the stream resumes from its `lastSeq` instead of
 * replaying the whole run), and after {@link RUN_STREAM_FALLBACK_ATTEMPTS} connections that
 * delivered nothing it gains a `RUN_POLL_MS` `refetchInterval` — which is exactly today's
 * behaviour against a different URL.
 *
 * Reconnection lives here rather than in the transport, because "the stream closed with no
 * terminal event" means *reconnect* and only a component knows whether it still wants to be
 * connected. A closed stream is never an error to the user: a redeploy, the server's idle cap, its
 * 10-minute duration cap and a dropped connection are all the same event (decision 6).
 */
import {
  type AgentRunStatus,
  isRunActive,
  RUN_STREAM_FALLBACK_ATTEMPTS,
} from '@rocketflare/shared/ai/agents'
import {
  type AgentRunAguiResponse,
  agentRunAguiResponseSchema,
  type KitAguiEvent,
} from '@rocketflare/shared/ai/agui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'
import { streamRunAgui } from '@/ui/lib/runAguiStream'
import { RUN_POLL_MS } from './useAgents'

export interface UseRunStreamOptions {
  /**
   * Open a connection at all. Pass `isRunActive(run.status)`: a settled or parked run has nothing
   * left to stream, and the snapshot the query already holds is the whole answer.
   */
  enabled?: boolean
}

export interface UseRunStreamResult {
  /** Every AG-UI event the server has produced for this run, in order. */
  events: KitAguiEvent[]
  /** The snapshot has not arrived yet (the first `GET /runs/:id/agui`). */
  isLoading: boolean
  /** A connection is open right now. */
  connected: boolean
  /** The stream gave up; `['agent-run-agui', id]` is polling instead. Cosmetic — the data is the same. */
  fallback: boolean
  /** The newest `agent_run_events.seq` rendered — the resume cursor. */
  lastSeq: number
  /** A terminal AG-UI event arrived: the run settled, or parked on a question. */
  terminal: boolean
}

/** `true` when a run is worth holding a connection open for. */
export function streamEnabled(status: AgentRunStatus | undefined): boolean {
  // `awaiting_input` is active but NOT streamable: the server answers it with the interrupt
  // outcome and closes at once, so reconnecting would be a hot loop of one-frame connections.
  return Boolean(status && isRunActive(status) && status !== 'awaiting_input')
}

export function useRunStream(
  runId: string | undefined,
  { enabled = true }: UseRunStreamOptions = {}
): UseRunStreamResult {
  const queryClient = useQueryClient()
  const [connected, setConnected] = useState(false)
  const [fallback, setFallback] = useState(false)
  const cursor = useRef(0)

  const key = queryKeys.agentRunAgui.detail(runId ?? '')
  const query = useQuery({
    queryKey: key,
    queryFn: () =>
      api.get(`/api/agents/runs/${encodeURIComponent(runId ?? '')}/agui`, {
        schema: agentRunAguiResponseSchema,
      }),
    enabled: Boolean(runId),
    // The stream owns this entry once it is loaded; nothing may refetch it underneath.
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: fallback ? RUN_POLL_MS : false,
  })

  // The snapshot decides where the first connection resumes from. Kept in a ref so a growing list
  // never re-runs the effect below — a reconnect per event would be worse than no stream at all.
  const snapshotSeq = query.data?.lastSeq
  useEffect(() => {
    if (snapshotSeq !== undefined && snapshotSeq > cursor.current) cursor.current = snapshotSeq
  }, [snapshotSeq])

  const loaded = query.isSuccess
  useEffect(() => {
    if (!runId || !enabled || !loaded || fallback) return
    const abort = new AbortController()
    let stopped = false
    let empty = 0

    const target = queryKeys.agentRunAgui.detail(runId)
    const append = (event: KitAguiEvent, lastSeq: number) => {
      cursor.current = lastSeq
      queryClient.setQueryData<AgentRunAguiResponse>(target, prev => ({
        events: [...(prev?.events ?? []), event],
        lastSeq,
      }))
    }

    void (async () => {
      while (!stopped) {
        setConnected(true)
        let result: Awaited<ReturnType<typeof streamRunAgui>>
        try {
          result = await streamRunAgui({
            runId,
            afterSeq: cursor.current,
            onEvent: append,
            signal: abort.signal,
          })
        } catch {
          // A pre-stream 4xx (the run vanished, the cursor was refused) or a dropped connection.
          // Neither is worth a toast: stop connecting and let the poll fallback carry it.
          setConnected(false)
          if (!stopped) setFallback(true)
          return
        }
        setConnected(false)
        if (stopped || result.aborted) return
        if (result.terminal) {
          // The run settled or parked. The row and the list are now stale — this is the one
          // invalidation the stream ever performs, and it is deliberately not of its own key.
          void queryClient.invalidateQueries({ queryKey: queryKeys.agentRuns.all })
          return
        }
        empty = result.received === 0 ? empty + 1 : 0
        if (empty >= RUN_STREAM_FALLBACK_ATTEMPTS) {
          setFallback(true)
          return
        }
      }
    })()

    return () => {
      stopped = true
      abort.abort()
      setConnected(false)
    }
    // The cache key is rebuilt from `runId` inside, and `append` closes over refs only — so a
    // growing event list never re-runs this effect, which would reconnect on every frame.
  }, [runId, enabled, loaded, fallback, queryClient])

  const events = query.data?.events ?? []
  return {
    events,
    isLoading: query.isPending && Boolean(runId),
    connected,
    fallback,
    lastSeq: query.data?.lastSeq ?? 0,
    terminal: events.some(e => e.type === 'RUN_FINISHED' || e.type === 'RUN_ERROR'),
  }
}
