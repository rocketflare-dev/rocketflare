/**
 * The run timeline, as two pure stages and a handful of selectors (issue #17).
 *
 * `buildTimeline(events)` folds the durable `agent_run_events` rows into ROWS a person reads — a
 * `tool.start`/`tool.end` pair is ONE row, a `step` row is updated in place by its `done` — and
 * `groupTimeline(rows)` folds those rows into the GROUPS the page renders: a stage, and everything
 * that happened inside it.
 *
 * Nothing here touches React, the clock or the network, which is what lets the whole thing be
 * tested as data (`tests/config/run-timeline.test.ts`).
 *
 * Three properties are load-bearing and each was a bug in the reducer this replaces:
 *
 * - **`tool.end` must not overwrite `at`.** The old reducer did, destroying the call's start time,
 *   which is exactly why per-call duration was impossible. `at` stays the start; `endedAt` and
 *   `durationMs` are added.
 * - **It must be idempotent under duplicated events.** A row can now reach the page twice (a poll
 *   and a refetch overlapping, a resumed stream replaying a group), and the FIFO of open tool calls
 *   would double-push. Every event is therefore deduplicated by `event.id` before anything else.
 * - **An unclosed step is a real state.** A `running` step with no `done` is shown spinning rather
 *   than swallowed, and a DIFFERENT step key implicitly closes the open group.
 */
import {
  type AgentRunEventType,
  type AgentStepEventData,
  agentErrorEventDataSchema,
  agentStatusEventDataSchema,
  agentStepEventDataSchema,
  agentTextEventDataSchema,
  agentToolEndEventDataSchema,
  agentToolStartEventDataSchema,
} from '@rocketflare/shared/ai/agents'
import type { AgentArtifact } from '@rocketflare/shared/ai/artifacts'
import { agentArtifactEventDataSchema } from '@rocketflare/shared/ai/artifacts'
import type { AgentRunInterrupt } from '@rocketflare/shared/ai/interrupts'
import {
  agentInterruptEventDataSchema,
  agentInterruptResolvedEventDataSchema,
  steeringNoteDataSchema,
} from '@rocketflare/shared/ai/interrupts'

/**
 * What the timeline needs from one durable row. `AgentRunEvent` satisfies it structurally; the
 * narrower type is here so the model never reaches for `runId`, which it has no use for.
 */
export interface TimelineEvent {
  id: string
  seq: number
  type: AgentRunEventType | string
  /** Optional, because `z.unknown()` infers as optional — an absent `data` is a row we cannot read. */
  data?: unknown
  at: Date
}

export interface ToolRow {
  kind: 'tool'
  id: string
  seq: number
  name: string
  /** The model's own call id where the runtime recorded one — how a parallel pair is matched. */
  toolCallId?: string
  input?: unknown
  result?: unknown
  isError: boolean
  /** False while the call has not returned yet (the row spins). */
  done: boolean
  /** The START of the call. Never rewritten by the answer — that is what `endedAt` is for. */
  at: Date
  endedAt?: Date
  durationMs?: number
}

export type TimelineRow =
  | {
      kind: 'step'
      id: string
      seq: number
      step: AgentStepEventData
      at: Date
      /** When the `done`/`error` row landed, and WHERE in the stream it landed. */
      endedAt?: Date
      /**
       * The `seq` of the closing row. Load-bearing for grouping: a `done` is merged INTO the row
       * its `running` announced, so without it the position at which the stage finished is lost and
       * a settled run's trailing rows get swallowed by the last stage.
       */
      endedSeq?: number
    }
  | ToolRow
  | { kind: 'text'; id: string; seq: number; text: string; at: Date }
  | {
      kind: 'status'
      id: string
      seq: number
      status: string
      attempt?: number
      reason?: string
      at: Date
    }
  | {
      kind: 'error'
      id: string
      seq: number
      message: string
      willRetry: boolean
      details?: unknown
      at: Date
    }
  | {
      kind: 'interrupt'
      id: string
      seq: number
      interruptId: string
      interruptKey: string
      interruptKind: string
      message: string | null
      at: Date
    }
  | {
      kind: 'interrupt.resolved'
      id: string
      seq: number
      interruptId: string
      status: string
      resolvedByUserId: string | null
      at: Date
    }
  | {
      kind: 'steering'
      id: string
      seq: number
      text: string
      authorUserId: string | null
      authorName?: string
      at: Date
    }
  | {
      kind: 'artifact'
      id: string
      seq: number
      artifactId: string
      title: string
      artifactKind: string
      at: Date
    }
  | { kind: 'unknown'; id: string; seq: number; type: string; data: unknown; at: Date }

/** Rows that arrived before the first stage announced itself. */
export const PREAMBLE_KEY = '__preamble__'
/**
 * Rows that arrived after the last stage closed. A settled run's trailing `status`, `error` and
 * `interrupt` rows live here, and they must NOT be swallowed by the stage that happened to be last.
 */
export const TAIL_KEY = '__tail__'

export interface TimelineGroup {
  /** The step key, or one of the two synthetic keys above. */
  key: string
  /** `null` for the synthetic groups. */
  step: AgentStepEventData | null
  status: 'running' | 'done' | 'error'
  rows: TimelineRow[]
  /** The step row itself, when there is one — so the group header can carry its id. */
  headerId: string
  at: Date
  endedAt?: Date
  durationMs?: number
  toolCount: number
}

/**
 * The payload an agent emits beside the tool name. The kit's agents send `{ input }` on the call
 * and `{ result }` on the answer; anything else is shown as-is. Unwrapping the known key keeps the
 * details panel from reading `{"input": {"input": {…}}}`.
 */
function toolPayload(rest: Record<string, unknown>, key: 'input' | 'result'): unknown {
  const keys = Object.keys(rest)
  if (keys.length === 1 && keys[0] === key) return rest[key]
  return keys.length > 0 ? rest : undefined
}

const unknownRow = (event: TimelineEvent): TimelineRow => ({
  kind: 'unknown',
  id: event.id,
  seq: event.seq,
  type: String(event.type),
  data: event.data,
  at: event.at,
})

/**
 * Durable rows → timeline rows, in `seq` order.
 *
 * **Deduplicated by `event.id` first**: once a stream and a fetch can both feed this, the same row
 * arrives twice and the open-call FIFO below would pair the second start with the first answer.
 */
export function buildTimeline(events: readonly TimelineEvent[]): TimelineRow[] {
  const unique = new Map<string, TimelineEvent>()
  for (const event of events) if (!unique.has(event.id)) unique.set(event.id, event)
  const ordered = [...unique.values()].sort((a, b) => a.seq - b.seq)

  const rows: TimelineRow[] = []
  const stepIndex = new Map<string, number>()
  /** Call key (the model's id, else the tool name) → indices of calls still awaiting an answer. */
  const openTools = new Map<string, number[]>()

  for (const event of ordered) {
    switch (event.type) {
      case 'step': {
        const parsed = agentStepEventDataSchema.safeParse(event.data)
        if (!parsed.success) {
          rows.push(unknownRow(event))
          break
        }
        const settled = parsed.data.status !== 'running'
        const existing = stepIndex.get(parsed.data.key)
        if (existing !== undefined) {
          const previous = rows[existing]
          rows[existing] = {
            kind: 'step',
            id: rows[existing].id,
            seq: rows[existing].seq,
            step: parsed.data,
            // The stage STARTED when its `running` row was written; the `done` is its end.
            at: previous.at,
            ...(settled ? { endedAt: event.at, endedSeq: event.seq } : {}),
          }
        } else {
          stepIndex.set(parsed.data.key, rows.length)
          rows.push({
            kind: 'step',
            id: event.id,
            seq: event.seq,
            step: parsed.data,
            at: event.at,
            ...(settled ? { endedAt: event.at, endedSeq: event.seq } : {}),
          })
        }
        break
      }
      case 'tool.start': {
        const parsed = agentToolStartEventDataSchema.safeParse(event.data)
        const {
          name: rawName,
          toolCallId,
          ...rest
        } = parsed.success ? parsed.data : { name: 'tool', toolCallId: undefined }
        const name = rawName || 'tool'
        // Pair on the MODEL's call id where the runtime recorded one (two calls to the same tool in
        // one turn are otherwise indistinguishable), on the name for rows written before it did.
        const key = toolCallId ?? name
        const pending = openTools.get(key) ?? []
        pending.push(rows.length)
        openTools.set(key, pending)
        rows.push({
          kind: 'tool',
          id: event.id,
          seq: event.seq,
          name,
          ...(toolCallId ? { toolCallId } : {}),
          input: toolPayload(rest, 'input'),
          isError: false,
          done: false,
          at: event.at,
        })
        break
      }
      case 'tool.end': {
        const parsed = agentToolEndEventDataSchema.safeParse(event.data)
        const {
          name: rawName,
          isError,
          toolCallId,
          ...rest
        } = parsed.success
          ? parsed.data
          : { name: 'tool', isError: undefined, toolCallId: undefined }
        const name = rawName || 'tool'
        const result = toolPayload(rest, 'result')
        const index = openTools.get(toolCallId ?? name)?.shift()
        const call = index !== undefined ? rows[index] : undefined
        if (call?.kind === 'tool' && index !== undefined) {
          rows[index] = {
            ...call,
            result,
            isError: Boolean(isError),
            done: true,
            // `at` is the START. Overwriting it — what the old reducer did — is what made a
            // per-call duration impossible to compute.
            endedAt: event.at,
            durationMs: Math.max(0, event.at.getTime() - call.at.getTime()),
          }
          break
        }
        // An answer with no call (a truncated log): still worth a row of its own.
        rows.push({
          kind: 'tool',
          id: event.id,
          seq: event.seq,
          name,
          result,
          isError: Boolean(isError),
          done: true,
          at: event.at,
          endedAt: event.at,
        })
        break
      }
      case 'text': {
        const parsed = agentTextEventDataSchema.safeParse(event.data)
        rows.push(
          parsed.success
            ? { kind: 'text', id: event.id, seq: event.seq, text: parsed.data.text, at: event.at }
            : unknownRow(event)
        )
        break
      }
      case 'status': {
        const parsed = agentStatusEventDataSchema.safeParse(event.data)
        if (parsed.success) {
          rows.push({
            kind: 'status',
            id: event.id,
            seq: event.seq,
            status: parsed.data.status,
            ...(parsed.data.attempt !== undefined ? { attempt: parsed.data.attempt } : {}),
            ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
            at: event.at,
          })
        }
        break
      }
      case 'error': {
        const parsed = agentErrorEventDataSchema.safeParse(event.data)
        rows.push({
          kind: 'error',
          id: event.id,
          seq: event.seq,
          message: parsed.success ? parsed.data.message : 'The run reported an error',
          willRetry: parsed.success ? Boolean(parsed.data.willRetry) : false,
          ...(parsed.success && parsed.data.details !== undefined
            ? { details: parsed.data.details }
            : {}),
          at: event.at,
        })
        break
      }
      case 'interrupt': {
        const parsed = agentInterruptEventDataSchema.safeParse(event.data)
        rows.push(
          parsed.success
            ? {
                kind: 'interrupt',
                id: event.id,
                seq: event.seq,
                interruptId: parsed.data.interruptId,
                interruptKey: parsed.data.key,
                interruptKind: parsed.data.kind,
                message: parsed.data.message,
                at: event.at,
              }
            : unknownRow(event)
        )
        break
      }
      case 'interrupt.resolved': {
        const parsed = agentInterruptResolvedEventDataSchema.safeParse(event.data)
        rows.push(
          parsed.success
            ? {
                kind: 'interrupt.resolved',
                id: event.id,
                seq: event.seq,
                interruptId: parsed.data.interruptId,
                status: parsed.data.status,
                resolvedByUserId: parsed.data.resolvedByUserId,
                at: event.at,
              }
            : unknownRow(event)
        )
        break
      }
      case 'steering': {
        const parsed = steeringNoteDataSchema.safeParse(event.data)
        rows.push(
          parsed.success
            ? {
                kind: 'steering',
                id: event.id,
                seq: event.seq,
                text: parsed.data.text,
                authorUserId: parsed.data.authorUserId,
                ...(parsed.data.authorName ? { authorName: parsed.data.authorName } : {}),
                at: event.at,
              }
            : unknownRow(event)
        )
        break
      }
      case 'artifact': {
        const parsed = agentArtifactEventDataSchema.safeParse(event.data)
        rows.push(
          parsed.success
            ? {
                kind: 'artifact',
                id: event.id,
                seq: event.seq,
                artifactId: parsed.data.artifactId,
                title: parsed.data.title,
                artifactKind: parsed.data.kind,
                at: event.at,
              }
            : unknownRow(event)
        )
        break
      }
      default:
        rows.push(unknownRow(event))
        break
    }
  }
  return rows
}

/**
 * Rows → groups. **The grouping rule, stated so it is testable:** a `running` step OPENS a group;
 * every non-step row after it attaches to it; a matching `done`/`error` step CLOSES it; a
 * DIFFERENT step key implicitly closes the open one (an agent that forgot its `done` still reads
 * as progress, spinning). Rows before the first step go to {@link PREAMBLE_KEY}, rows after the
 * last closed step to {@link TAIL_KEY}.
 */
export function groupTimeline(rows: readonly TimelineRow[]): TimelineGroup[] {
  const groups: TimelineGroup[] = []
  /** The stage rows currently attach to, or null before the first one. */
  let open: TimelineGroup | null = null
  /** How far the open stage reaches: its closing row's `seq`, or Infinity while it is running. */
  let openUntil = 0
  /** The synthetic stretch currently accepting rows, so consecutive loose rows share one. */
  let loose: TimelineGroup | null = null
  let sawStep = false

  const attach = (row: TimelineRow) => {
    // `buildTimeline` merges a stage's `done` INTO the row its `running` wrote, so the stage's
    // ROW sits at the start and `endedSeq` is where it finished. A row past that point happened
    // after the stage closed and belongs to the tail, not inside it.
    if (open && row.seq <= openUntil) {
      open.rows.push(row)
      if (row.kind === 'tool') open.toolCount += 1
      return
    }
    if (open) {
      open = null
      loose = null
    }
    if (loose) {
      loose.rows.push(row)
      if (row.kind === 'tool') loose.toolCount += 1
      return
    }
    // `headerId` is the React key, so two `__tail__` stretches never collide.
    loose = {
      key: sawStep ? TAIL_KEY : PREAMBLE_KEY,
      step: null,
      status: 'done',
      rows: [row],
      headerId: row.id,
      at: row.at,
      toolCount: row.kind === 'tool' ? 1 : 0,
    }
    groups.push(loose)
  }

  for (const row of rows) {
    if (row.kind !== 'step') {
      attach(row)
      continue
    }
    sawStep = true
    loose = null
    const group: TimelineGroup = {
      key: row.step.key,
      step: row.step,
      status: row.step.status,
      rows: [],
      headerId: row.id,
      at: row.at,
      toolCount: 0,
      ...(row.endedAt
        ? {
            endedAt: row.endedAt,
            durationMs: Math.max(0, row.endedAt.getTime() - row.at.getTime()),
          }
        : {}),
    }
    groups.push(group)
    open = group
    // A stage that never reported a `done` is still open — an unclosed step is a real state, shown
    // spinning, and everything after it belongs to it until another stage starts.
    openUntil = row.endedSeq ?? Number.POSITIVE_INFINITY
  }
  return groups
}

// ---- Selectors ---------------------------------------------------------------------------------
//
// Everything the right pane shows that is not `run.output` is a selector over these same rows —
// never a second fetch.

/**
 * Artifacts in the order the run produced them. The TABLE is the store (decision 4), so the event
 * rows only supply the ORDER; an artifact with no event row still appears, at the end.
 */
export function selectArtifacts(
  rows: readonly TimelineRow[],
  artifacts: readonly AgentArtifact[]
): AgentArtifact[] {
  const byId = new Map(artifacts.map(artifact => [artifact.id, artifact]))
  const ordered: AgentArtifact[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (row.kind !== 'artifact') continue
    const artifact = byId.get(row.artifactId)
    if (artifact && !seen.has(artifact.id)) {
      seen.add(artifact.id)
      ordered.push(artifact)
    }
  }
  for (const artifact of artifacts) if (!seen.has(artifact.id)) ordered.push(artifact)
  return ordered
}

/** The asks still waiting on a person, oldest first — what the action panel draws. */
export function selectPendingInterrupts(
  interrupts: readonly AgentRunInterrupt[]
): AgentRunInterrupt[] {
  return interrupts
    .filter(interrupt => interrupt.status === 'pending')
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
}

/**
 * What the rows genuinely know about the work a run did. **Deliberately not money:** `ai_usage`
 * carries no per-run attribution in this deployment, so the Usage tab says so in words rather than
 * rendering a `$0.00` nobody should believe.
 */
export interface RunWorkStats {
  steps: number
  toolCalls: number
  failedToolCalls: number
  textTurns: number
  errors: number
  retries: number
  asks: number
  steeringNotes: number
  artifacts: number
  /** Per-tool totals, busiest first. */
  tools: { name: string; calls: number; totalMs: number | null }[]
}

export function selectWorkStats(rows: readonly TimelineRow[]): RunWorkStats {
  const tools = new Map<string, { calls: number; totalMs: number | null }>()
  const stats: RunWorkStats = {
    steps: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    textTurns: 0,
    errors: 0,
    retries: 0,
    asks: 0,
    steeringNotes: 0,
    artifacts: 0,
    tools: [],
  }
  for (const row of rows) {
    switch (row.kind) {
      case 'step':
        stats.steps += 1
        break
      case 'tool': {
        stats.toolCalls += 1
        if (row.isError) stats.failedToolCalls += 1
        const entry = tools.get(row.name) ?? { calls: 0, totalMs: 0 }
        entry.calls += 1
        entry.totalMs =
          entry.totalMs === null || row.durationMs === undefined
            ? null
            : entry.totalMs + row.durationMs
        tools.set(row.name, entry)
        break
      }
      case 'text':
        stats.textTurns += 1
        break
      case 'error':
        stats.errors += 1
        if (row.willRetry) stats.retries += 1
        break
      case 'interrupt':
        stats.asks += 1
        break
      case 'steering':
        stats.steeringNotes += 1
        break
      case 'artifact':
        stats.artifacts += 1
        break
      default:
        break
    }
  }
  stats.tools = [...tools.entries()]
    .map(([name, entry]) => ({ name, calls: entry.calls, totalMs: entry.totalMs }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
  return stats
}

/**
 * Which groups start expanded, **by `headerId`**: anything still running or errored, the loose
 * stretches (they hold the trailing status and error rows a settled run ends on), and the last.
 * A reader's own toggles are XORed over this by the component, so a new event never yanks open a
 * group they deliberately closed — and `headerId` rather than `key` because two `__tail__`
 * stretches are two different groups.
 */
export function defaultExpanded(groups: readonly TimelineGroup[]): Set<string> {
  const ids = new Set<string>()
  for (const group of groups) {
    if (group.status !== 'done' || group.step === null) ids.add(group.headerId)
  }
  const last = groups.at(-1)
  if (last) ids.add(last.headerId)
  return ids
}

/** Longest run a page renders whole. Beyond it the head is folded behind one button. */
export const TIMELINE_WINDOW_GROUPS = 40

/**
 * **Window, do not virtualise.** Row heights vary wildly — markdown, document-card strips, `<pre>`
 * — so a virtualiser needs measurement, and measurement fights both auto-scroll and collapsing.
 * The last {@link TIMELINE_WINDOW_GROUPS} groups render; the rest are one "show earlier" button.
 * If runs ever get truly huge the answer is server-side pagination of `events` by `seq`.
 */
export function windowGroups(
  groups: readonly TimelineGroup[],
  showAll: boolean,
  limit = TIMELINE_WINDOW_GROUPS
): { visible: TimelineGroup[]; hiddenGroups: number; hiddenRows: number } {
  if (showAll || groups.length <= limit) {
    return { visible: [...groups], hiddenGroups: 0, hiddenRows: 0 }
  }
  const cut = groups.length - limit
  const hidden = groups.slice(0, cut)
  return {
    visible: groups.slice(cut),
    hiddenGroups: cut,
    hiddenRows: hidden.reduce((n, group) => n + group.rows.length + (group.step ? 1 : 0), 0),
  }
}

/** `submit_summary` → `Submit summary`. */
export function humaniseToolName(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
