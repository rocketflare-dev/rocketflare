/**
 * `GET /api/agents/runs/:id/agui/stream` — a run's timeline, live (issue #7).
 *
 * A **polling** stream: the body tails `agent_run_events` on one open connection, projects each
 * new row through {@link createRunProjector} and frames it as spec AG-UI with `seq` as the cursor.
 * Measured against what it replaces — every 3 s, `getRun` + `reconcileRun` (a Workflow
 * `instance.status()` subrequest) + `listEvents` returning *every row, unbounded* — it is cheaper
 * per unit of wall clock at six times the resolution: one bounded, indexed
 * `WHERE (tenant_id, run_id) AND seq > $cursor LIMIT 200` that usually returns nothing, plus the
 * run row, on a connection already open.
 *
 * Four rules, each of which is a bug if broken:
 *
 * 1. **`id:` goes on the LAST frame of a row's group, and on no other frame in it.** One row is
 *    not one AG-UI event — a `text` row is `START → CONTENT → END`. Put the id on the first frame
 *    and a drop mid-group leaves the browser's `Last-Event-ID` already past the row, so the resume
 *    starts after it and the client holds a text message that never closes, forever, with no
 *    error. Replaying a whole group is free: every id in it is derived from the row id, so a
 *    replayed group is byte-identical.
 * 2. **No `RUN_ERROR` for the stream's own failure** (decision 6). `chat-turn.ts` emits one
 *    because there the stream *is* the run; here the run is a durable Workflow in another isolate
 *    and is almost certainly fine. Closing with no terminal event means "reconnect", uniformly —
 *    for a redeploy, an idle cap, a duration cap, a transport error and a client abort.
 * 3. **`reconcileRun` runs exactly once, at open, never in the loop.** It is a Workflow subrequest
 *    per call; a 10-minute stream would spend ~1 200 of them on a question the tail already
 *    answers. The route does it before the first frame; this file never touches the binding.
 * 4. **Protobuf has no cursor and no comments.** The AG-UI binary transport has no SSE framing, so
 *    a protobuf client resumes by `?afterSeq=` only — and a `: ping` comment frame written into a
 *    binary stream is not a valid protobuf frame and poisons everything after it.
 *
 * A **parked** run needs no code here: `finish` already returns
 * `RUN_FINISHED { outcome: { type: 'interrupt' } }` for `awaiting_input`, so the generic terminal
 * branch fires and the connection closes. A run parked for seven days therefore holds no
 * connection, no query and no invocation, and the page re-opens on the existing nudge when the
 * answer lands.
 */
import type { AgentRunEvent } from '@rocketflare/shared/ai/agents'
import {
  isRunActive,
  RUN_STREAM_HEARTBEAT_MS,
  RUN_STREAM_IDLE_AFTER_TICKS,
  RUN_STREAM_IDLE_CAP_MS,
  RUN_STREAM_IDLE_MS,
  RUN_STREAM_MAX_MS,
  RUN_STREAM_POLL_MS,
  RUN_STREAM_SLOW_AFTER_TICKS,
  RUN_STREAM_SLOW_MS,
  RUN_STREAM_TAIL_LIMIT,
} from '@rocketflare/shared/ai/agents'
import type { KitAguiEvent } from '@rocketflare/shared/ai/agui'
import { and, asc, eq, gt } from 'drizzle-orm'
import { stream } from 'hono/streaming'
import type { Database } from '../../../db/client'
import { type AgentRunEventRow, type AgentRunRow, agentRunEvents } from '../../../db/schema'
import type { AppContext } from '../../types'
import { streamDatabase, withAuthAndDb } from '../../utils/routes/route-helpers'
import { createAguiEncoder } from '../ai/agui'
import { createRunProjector, type RunProjectionContext } from './agui-projection'
import { listArtifacts, toAgentArtifact } from './artifacts'
import { listInterrupts, toAgentRunInterrupt } from './interrupts'
import { getRun, toAgentRun, toAgentRunEvent } from './runs'

/** The clock and the wait, injected so the tests are not timer-bound. */
export interface RunStreamDeps {
  now: () => number
  sleep: (ms: number) => Promise<void>
}

const REAL_DEPS: RunStreamDeps = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

/** Where the bytes go. `aborted` is polled between ticks, so a closed tab stops the loop. */
export interface RunStreamSink {
  write(chunk: Uint8Array | string): Promise<void>
  readonly aborted: boolean
}

export interface RunStreamParams {
  /** The stream's OWN client — never the request's, which is closed with the Response. */
  db: Database
  tenantId: string
  /** The run as it was at open, already reconciled. Re-read each tick from `db`. */
  run: AgentRunRow
  /** Rows at or below this `seq` are already with the client. 0 also asks for the head. */
  afterSeq: number
  /** The request's `Accept`, for transport negotiation. */
  accept?: string
}

/** Rows after `cursor`, oldest first, bounded. The one query a quiet tick makes. */
export async function tailRunEvents(
  db: Database,
  tenantId: string,
  runId: string,
  cursor: number,
  limit: number = RUN_STREAM_TAIL_LIMIT
): Promise<AgentRunEventRow[]> {
  return db
    .select()
    .from(agentRunEvents)
    .where(
      and(
        eq(agentRunEvents.tenantId, tenantId),
        eq(agentRunEvents.runId, runId),
        gt(agentRunEvents.seq, cursor)
      )
    )
    .orderBy(asc(agentRunEvents.seq))
    .limit(limit)
}

/**
 * How long to wait before the next tail. Bursty output is why this is adaptive: fast matters just
 * after a row, not during a two-minute model call — and the slowest tick is still below the 3 s
 * poll it replaces, so the stream's worst case beats the poll's best. Any row resets it.
 */
export function runStreamTickMs(emptyTicks: number): number {
  if (emptyTicks >= RUN_STREAM_IDLE_AFTER_TICKS) return RUN_STREAM_IDLE_MS
  if (emptyTicks >= RUN_STREAM_SLOW_AFTER_TICKS) return RUN_STREAM_SLOW_MS
  return RUN_STREAM_POLL_MS
}

/** Why the loop stopped — logged, never sent: the client only ever sees the absence of a terminal. */
export type RunStreamOutcome =
  | 'terminal'
  | 'aborted'
  | 'idle_cap'
  | 'duration_cap'
  | 'settled_without_terminal'

/**
 * The loop, as a plain function over a sink: no hono, no ExecutionContext, no real timers. The
 * route wraps it; the tests drive it directly (`.claude/rules/testing.md`).
 */
export async function runStreamBody(
  params: RunStreamParams,
  sink: RunStreamSink,
  deps: Partial<RunStreamDeps> = {}
): Promise<RunStreamOutcome> {
  const { now, sleep } = { ...REAL_DEPS, ...deps }
  const { db, tenantId } = params
  const runId = params.run.id
  const encoder = createAguiEncoder(params.accept)
  const projector = createRunProjector(toAgentRun(params.run))

  /**
   * Write one row's frames, with the cursor on the last one that survives the transport. A group
   * whose every frame the transport drops (`TOOL_CALL_RESULT` over protobuf) writes nothing and
   * advances no cursor, which is correct: the client's resume point stays where it can be replayed.
   */
  const writeGroup = async (events: KitAguiEvent[], seq: number | null): Promise<void> => {
    const frames: Uint8Array[] = []
    for (const event of events) {
      const bytes = encoder.encode(event)
      if (bytes) frames.push(bytes)
    }
    for (let i = 0; i < frames.length; i++) {
      const last = i === frames.length - 1
      if (last && seq !== null && !encoder.binary) await sink.write(`id: ${seq}\n`)
      await sink.write(frames[i] as Uint8Array)
    }
  }

  let cursor = params.afterSeq
  let current = params.run
  let emptyTicks = 0
  let lastRowAt = now()
  let lastHeartbeat = now()
  const deadline = now() + RUN_STREAM_MAX_MS

  // The head belongs to a stream starting from the beginning; a resume must not replay it, or the
  // client gets a second `RUN_STARTED` for a run it is already rendering.
  if (cursor === 0) await writeGroup(projector.head(), 0)

  while (true) {
    if (sink.aborted) return 'aborted'

    // Two statements, one round trip (postgres.js pipelines them on the one connection). The run
    // row is how a settle or a park is noticed: a finished run stops writing events, so waiting
    // for a row that will never come is waiting forever.
    const [rows, latest] = await Promise.all([
      tailRunEvents(db, tenantId, runId, cursor),
      getRun(db, tenantId, runId),
    ])
    if (latest) current = latest

    if (rows.length > 0) {
      const context = await loadContext(db, tenantId, runId, rows, current.status)
      for (const row of rows) {
        const event: AgentRunEvent = toAgentRunEvent(row)
        await writeGroup(projector.push(event, context), row.seq)
        cursor = row.seq
      }
      emptyTicks = 0
      lastRowAt = now()
      lastHeartbeat = now()
    } else {
      emptyTicks += 1
    }

    const terminalContext =
      current.status === 'awaiting_input'
        ? { interrupts: (await listInterrupts(db, tenantId, runId)).map(toAgentRunInterrupt) }
        : {}
    const terminal = projector.finish(toAgentRun(current), terminalContext)
    if (terminal.length > 0) {
      // No cursor on a terminal frame: it is derived from the run row rather than from a `seq`,
      // and a reconnect that replays the last row must produce it again.
      await writeGroup(terminal, null)
      return 'terminal'
    }
    // A settled run with no terminal event cannot happen through `finish`; if it ever does, stop
    // rather than tail a log nobody will add to.
    if (!isRunActive(current.status)) return 'settled_without_terminal'

    // A full page means there is almost certainly more waiting: loop without sleeping.
    if (rows.length >= RUN_STREAM_TAIL_LIMIT) continue

    const at = now()
    if (at >= deadline) return 'duration_cap'
    if (at - lastRowAt >= RUN_STREAM_IDLE_CAP_MS) return 'idle_cap'
    if (at - lastHeartbeat >= RUN_STREAM_HEARTBEAT_MS) {
      // SSE only. A comment frame is how the connection stays off an idle proxy's timeout; the
      // binary transport has no such thing and would be corrupted by one.
      if (!encoder.binary) await sink.write(': ping\n\n')
      lastHeartbeat = at
    }
    await sleep(runStreamTickMs(emptyTicks))
  }
}

/**
 * The side tables a batch of rows needs, fetched only when a row that reads them arrived. An
 * `interrupt` row carries an id; the ASK itself (its `spec`, its status, its answer) lives in
 * `agent_run_interrupts`, and the same holds for an artifact.
 */
async function loadContext(
  db: Database,
  tenantId: string,
  runId: string,
  rows: AgentRunEventRow[],
  status: AgentRunRow['status']
): Promise<RunProjectionContext> {
  const needsInterrupts =
    status === 'awaiting_input' ||
    rows.some(row => row.type === 'interrupt' || row.type === 'interrupt.resolved')
  const needsArtifacts = rows.some(row => row.type === 'artifact')
  const [interrupts, artifacts] = await Promise.all([
    needsInterrupts ? listInterrupts(db, tenantId, runId) : Promise.resolve([]),
    needsArtifacts ? listArtifacts(db, tenantId, runId) : Promise.resolve([]),
  ])
  return {
    interrupts: interrupts.map(toAgentRunInterrupt),
    artifacts: artifacts.map(toAgentArtifact),
  }
}

/**
 * The route's half: negotiate the transport, open the stream's own database client and run the
 * loop. Everything that can fail as JSON — auth, the ability, the uuid, the 404 for an invisible
 * run, `reconcileRun`, a garbage cursor — has already happened in the route, above this call.
 */
export function streamRunAgui(c: AppContext, run: AgentRunRow, afterSeq: number): Response {
  const { tenantId, logger } = withAuthAndDb(c)
  const encoder = createAguiEncoder(c.req.header('Accept'))
  c.header('Content-Type', encoder.contentType)
  if (!encoder.binary) {
    // `stream()` sets none of these, and a buffering proxy swallows the whole point of the route.
    c.header('Cache-Control', 'no-cache')
    c.header('Connection', 'keep-alive')
    c.header('X-Accel-Buffering', 'no')
  }

  return stream(c, async s => {
    const handle = streamDatabase(c)
    let aborted = false
    s.onAbort(() => {
      aborted = true
    })
    const sink: RunStreamSink = {
      write: async chunk => {
        await s.write(chunk)
      },
      get aborted() {
        return aborted
      },
    }
    try {
      const outcome = await runStreamBody(
        { db: handle.db, tenantId, run, afterSeq, accept: c.req.header('Accept') },
        sink
      )
      logger.debug({ runId: run.id, outcome }, 'run-stream: closed')
    } catch (err) {
      // Decision 6: a read-stream failure is not a run failure. Log it and close; the absence of a
      // terminal event is already the client's instruction to reconnect.
      logger.warn({ err, runId: run.id }, 'run-stream: body failed')
    } finally {
      await handle.close()
    }
  })
}
