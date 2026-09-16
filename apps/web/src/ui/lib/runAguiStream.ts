/**
 * The AG-UI client for a LIVE agent run: GET `/api/agents/runs/:id/agui/stream` and read the run's
 * timeline as it fills (issue #7).
 *
 * A sibling of `aguiStream.ts`, and the differences are the whole design. That one POSTs a user
 * turn and OWNS the run it is streaming — so a body failure there is a `RUN_ERROR` and the run is
 * over. This one GETs a read-only tail of a Workflow executing in another isolate, so it owns
 * nothing: **the stream closing with no terminal event is not an error, it is "reconnect"**
 * (decision 6), uniformly for a redeploy, the server's idle cap, its 10-minute duration cap, a
 * transport error and the caller's own abort. Reconnecting is the HOOK's job — this module is
 * transport, resolves with what it saw, and never retries.
 *
 * `lastSeq` is the cursor: the server writes `agent_run_events.seq` into the SSE `id:` field of the
 * LAST frame of each row's group, so a resume from `lastSeq` replays whole groups and never lands
 * inside one. Hand it back as `?afterSeq=` — explicit, because `Last-Event-ID` is only honoured for
 * the sake of third-party `EventSource` clients and a stale browser value must never win.
 *
 * `@ag-ui/core` reaches the browser only through this module's import of
 * `@rocketflare/shared/ai/agui` — it must stay out of the eager shell (`.claude/rules/ui.md`).
 */
import { AguiEventType, type KitAguiEvent, kitAguiEventSchema } from '@rocketflare/shared/ai/agui'
import { ApiError, notifyUnauthorized, parseErrorBody } from './api-client'
import { isAbortError, readSse } from './sse'

export interface RunAguiStreamOptions {
  runId: string
  /** Rows at or below this `seq` are already rendered; 0 asks for the run from the beginning. */
  afterSeq?: number
  /** Every event, in order. `lastSeq` is the cursor AFTER this event (unchanged mid-group). */
  onEvent: (event: KitAguiEvent, lastSeq: number) => void
  signal?: AbortSignal
}

/** What one connection amounted to. The hook decides what to do about it. */
export interface RunAguiStreamResult {
  /** The newest `seq` this connection delivered, or the `afterSeq` it started from. */
  lastSeq: number
  /** How many events arrived — 0 is what the fallback counts (`RUN_STREAM_FALLBACK_ATTEMPTS`). */
  received: number
  /** `RUN_FINISHED` or `RUN_ERROR` arrived: the run has settled or parked, so do not reconnect. */
  terminal: boolean
  /** The caller's signal fired. Not a failure and never a toast. */
  aborted: boolean
}

const parseAguiFrame = (json: unknown) => {
  const parsed = kitAguiEventSchema.safeParse(json)
  return parsed.success
    ? ({ ok: true, event: parsed.data } as const)
    : ({ ok: false, reason: parsed.error.issues[0]?.message ?? 'unknown frame' } as const)
}

/**
 * Open one connection and read it to the end. Resolves when the server closes or the signal
 * aborts; rejects with `ApiError` for a pre-stream failure (403, 404, 400 on a bad cursor — all of
 * which the route answers as JSON before the first frame) and with the transport error for a
 * connection that dropped mid-read.
 */
export async function streamRunAgui({
  runId,
  afterSeq = 0,
  onEvent,
  signal,
}: RunAguiStreamOptions): Promise<RunAguiStreamResult> {
  const result: RunAguiStreamResult = {
    lastSeq: afterSeq,
    received: 0,
    terminal: false,
    aborted: false,
  }

  let response: Response
  try {
    response = await fetch(
      `/api/agents/runs/${encodeURIComponent(runId)}/agui/stream?afterSeq=${afterSeq}`,
      {
        credentials: 'include',
        headers: { Accept: 'text/event-stream', 'X-Requested-With': 'fetch' },
        signal,
      }
    )
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) return { ...result, aborted: true }
    throw error
  }

  if (!response.ok) {
    const body = await parseErrorBody(response)
    const error = new ApiError(body)
    if (body.statusCode === 401) notifyUnauthorized(error)
    throw error
  }

  await readSse(
    response,
    parseAguiFrame,
    (event, frame) => {
      // The cursor moves only on a frame that carries one — the last of a row's group. A mid-group
      // drop therefore resumes at the PREVIOUS row and replays the whole group, which is safe
      // because every id in it is derived from the row id.
      const seq = frame.id === undefined ? Number.NaN : Number(frame.id)
      if (Number.isInteger(seq) && seq >= result.lastSeq) result.lastSeq = seq
      result.received += 1
      if (event.type === AguiEventType.RUN_FINISHED || event.type === AguiEventType.RUN_ERROR) {
        result.terminal = true
      }
      onEvent(event, result.lastSeq)
    },
    { signal }
  )

  if (signal?.aborted) result.aborted = true
  return result
}
