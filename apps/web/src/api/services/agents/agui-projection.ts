/**
 * An agent run, read back as AG-UI. A **projection, not a rewrite**: `agent_run_events` stays
 * exactly as it is — the durable record, written inside Workflow steps where every write is
 * awaited and ordered by `seq` — and this maps it at read time. Nothing in the runtime knows AG-UI
 * exists.
 *
 * `threadId` is the run id: an agent run is not a conversation, so it is its own thread of one run.
 *
 * Three deliberate choices:
 *
 * - **A settled `cancelled` run projects as `RUN_ERROR` with code `agent_run_cancelled`.** The
 *   streaming convention — "closed with no terminal event means cancelled" — cannot apply to a
 *   finite array, where the absence of a terminal event is how an ACTIVE run is represented.
 * - **No `kit.usage`.** `ai_usage` rows are not attributable to a run (there is no run column), so
 *   a projection over `(run, events)` has no honest number to report. The Usage page is the ledger.
 * - **An errored tool result keeps its JSON.** `ToolCallResultEvent` has no error flag in
 *   `@ag-ui/core@0.0.59`; add `kit.tool.error` to the CUSTOM union only if a screen needs the red
 *   state.
 */
import type { AgentRun, AgentRunEvent } from '@rocketflare/shared/ai/agents'
import { isRunActive } from '@rocketflare/shared/ai/agents'
import {
  AguiEventType,
  KIT_CUSTOM_EVENTS,
  type KitAguiEvent,
  toAguiInterrupt,
} from '@rocketflare/shared/ai/agui'
import type { AgentArtifact } from '@rocketflare/shared/ai/artifacts'
import { documentCardsFromToolResult } from '@rocketflare/shared/ai/embeddings'
import type { AgentRunInterrupt } from '@rocketflare/shared/ai/interrupts'
import {
  agentInterruptResolvedEventDataSchema,
  steeringNoteDataSchema,
} from '@rocketflare/shared/ai/interrupts'
import { kitCustom } from '../ai/agui'

/**
 * The rows a run's timeline needs that are NOT in `agent_run_events`. The log records WHERE an ask
 * or an artifact appeared; the TABLES record what it is and what became of it — an interrupt gains
 * a status and an answer after its row was written, and an artifact is upserted in place. So the
 * projection takes both, and stays a pure function of rows.
 */
export interface RunProjectionContext {
  /** Every ask this run has made, in any status. Pending ones become `RUN_FINISHED.outcome`. */
  interrupts?: AgentRunInterrupt[]
  artifacts?: AgentArtifact[]
}

/**
 * What the kit's agent runs can do, in AG-UI's own capability vocabulary. Declared on every run's
 * `STATE_SNAPSHOT` so a third-party client knows — before it renders anything — that an approve
 * button on this server does something. `feedback` is true since D33: a thumbs up/down on the run's
 * output is `POST /api/feedback` (`target: 'agent_run'`), and it lands in the run's trace.
 */
export const AGENT_RUN_CAPABILITIES = {
  humanInTheLoop: {
    supported: true,
    approvals: true,
    interrupts: true,
    interventions: true,
    feedback: true,
    approveWithEdits: true,
  },
} as const

/** The `data` of a `step` row (validated loosely: an older row must project, not throw). */
interface StepData {
  key?: unknown
  label?: unknown
  status?: unknown
  detail?: unknown
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined

/**
 * Map a run and its durable events to the AG-UI sequence a client would have seen live. Pure: no
 * database, no clock, no randomness — the event row ids ARE the AG-UI message and tool-call ids,
 * so two projections of the same run are byte-identical.
 *
 * A fold over {@link createRunProjector}, which is the same mapping made resumable for the live
 * stream. Keeping ONE implementation is the point: a finite read and a tail of the same log must
 * never disagree about what a run looked like (`agui-projection.test.ts` pins the equivalence).
 */
export function projectRunToAgui(
  run: AgentRun,
  events: AgentRunEvent[],
  context: RunProjectionContext = {}
): KitAguiEvent[] {
  const projector = createRunProjector(run)
  return [
    ...projector.head(),
    ...events.flatMap(event => projector.push(event, context)),
    ...projector.finish(run, context),
  ]
}

/**
 * The same projection, one row at a time, for `GET /runs/:id/agui/stream` (decision 5).
 *
 * Re-projecting the whole array per tick is cheap in CPU and expensive in everything else: it
 * forces the stream to hold or re-read the entire log every tick, which is exactly the O(events)
 * behaviour the stream exists to remove. So the projector keeps the little state a fold needs —
 * open tool calls, the last message id, the last error — and hands back only the frames one row
 * produced.
 *
 * **`finish` takes the run as an argument rather than reading the closure.** In a stream the row
 * changes underneath you: the run this projector opened on was `running` and the one it must write
 * a terminal event for is `succeeded`, `awaiting_input` or `failed`.
 */
export interface RunProjector {
  /** `RUN_STARTED` + `STATE_SNAPSHOT`. Emitted only by a stream starting from the beginning. */
  head(): KitAguiEvent[]
  /** The frames for ONE durable row — zero, one, or a whole `START → CONTENT → END` group. */
  push(event: AgentRunEvent, context?: RunProjectionContext): KitAguiEvent[]
  /** The terminal event for the run AS IT IS NOW, or `[]` while it is still active. */
  finish(run: AgentRun, context?: RunProjectionContext): KitAguiEvent[]
}

export function createRunProjector(run: AgentRun): RunProjector {
  /** Open `tool.start`s by the model's call id (falling back to the tool name). */
  const openToolCalls = new Map<string, string>()
  let lastMessageId = run.id
  let lastError: string | undefined

  return {
    head: () => [
      { type: AguiEventType.RUN_STARTED, threadId: run.id, runId: run.id },
      {
        type: AguiEventType.STATE_SNAPSHOT,
        snapshot: {
          runId: run.id,
          agentKey: run.agentKey,
          status: run.status,
          capabilities: AGENT_RUN_CAPABILITIES,
        },
      },
    ],

    push(event, context = {}) {
      const out: KitAguiEvent[] = []
      const data = asRecord(event.data)
      switch (event.type) {
        case 'status':
          // `running` is the synthetic RUN_STARTED in `head`; the terminal ones come from the run
          // row in `finish`, which is the authority on how it actually ended.
          break
        case 'step': {
          const step = data as StepData
          const name = asString(step.key) ?? 'step'
          const status = asString(step.status) ?? 'running'
          out.push({
            type: status === 'running' ? AguiEventType.STEP_STARTED : AguiEventType.STEP_FINISHED,
            stepName: name,
          })
          // `stepName` is a bare string; the label and detail a person reads need a home.
          out.push(
            kitCustom(KIT_CUSTOM_EVENTS.agentStep, {
              key: name,
              label: asString(step.label) ?? name,
              status: status === 'done' || status === 'error' ? status : 'running',
              ...(asString(step.detail) ? { detail: asString(step.detail) } : {}),
            })
          )
          break
        }
        case 'text': {
          const text = asString(data.text)
          if (!text) break
          lastMessageId = event.id
          out.push(
            { type: AguiEventType.TEXT_MESSAGE_START, messageId: event.id, role: 'assistant' },
            { type: AguiEventType.TEXT_MESSAGE_CONTENT, messageId: event.id, delta: text },
            { type: AguiEventType.TEXT_MESSAGE_END, messageId: event.id }
          )
          break
        }
        case 'tool.start': {
          const { name: toolName, toolCallId: modelCallId, ...rest } = data
          const name = asString(toolName) ?? 'tool'
          // Pair on the MODEL's call id where the runtime recorded one, and on the tool name only
          // as a fallback for rows written before it did. Name-only pairing is wrong the day two
          // calls to the same tool run in one turn — the second start overwrites the first and
          // both results are attributed to the second call.
          openToolCalls.set(asString(modelCallId) ?? name, event.id)
          out.push(
            {
              type: AguiEventType.TOOL_CALL_START,
              toolCallId: event.id,
              toolCallName: name,
              parentMessageId: lastMessageId,
            },
            {
              type: AguiEventType.TOOL_CALL_ARGS,
              toolCallId: event.id,
              delta: JSON.stringify(rest.input ?? rest),
            },
            { type: AguiEventType.TOOL_CALL_END, toolCallId: event.id }
          )
          break
        }
        case 'tool.end': {
          const name = asString(data.name) ?? 'tool'
          const key = asString(data.toolCallId) ?? name
          // The EMITTED id stays `event.id` of the start row: "the event row ids ARE the AG-UI
          // ids" is the invariant that makes two projections of one run byte-identical.
          const toolCallId = openToolCalls.get(key) ?? event.id
          openToolCalls.delete(key)
          out.push({
            type: AguiEventType.TOOL_CALL_RESULT,
            messageId: event.id,
            toolCallId,
            content: JSON.stringify(data),
            role: 'tool',
          })
          // The same mapper the live chat uses, over the SUMMARISED result stored in the row — so a
          // run reads back with the cards a chat would have shown, and the runtime still knows
          // nothing about AG-UI (D18).
          for (const card of documentCardsFromToolResult(name, data.result)) {
            out.push(kitCustom(KIT_CUSTOM_EVENTS.document, { card }))
          }
          break
        }
        case 'interrupt': {
          // The row travels WHOLE — the panel needs `spec` to draw the question — so the thin event
          // row is only the position in the timeline and the table is the state. An ask the caller
          // did not pass is simply not projected: inventing one from the log would show a question
          // whose status nobody knows.
          const id = asString(data.interruptId) ?? ''
          const interrupt = (context.interrupts ?? []).find(row => row.id === id)
          if (interrupt) out.push(kitCustom(KIT_CUSTOM_EVENTS.agentInterrupt, { interrupt }))
          break
        }
        case 'interrupt.resolved': {
          const parsed = agentInterruptResolvedEventDataSchema.safeParse(data)
          if (parsed.success) {
            out.push(kitCustom(KIT_CUSTOM_EVENTS.agentInterruptResolved, parsed.data))
          }
          break
        }
        case 'steering': {
          const parsed = steeringNoteDataSchema.safeParse(data)
          if (parsed.success) {
            out.push(
              kitCustom(KIT_CUSTOM_EVENTS.agentSteering, {
                note: { ...parsed.data, eventId: event.id, at: event.at },
              })
            )
          }
          break
        }
        case 'artifact': {
          const id = asString(data.artifactId) ?? ''
          const artifact = (context.artifacts ?? []).find(row => row.id === id)
          if (artifact) out.push(kitCustom(KIT_CUSTOM_EVENTS.agentArtifact, { artifact }))
          break
        }
        case 'error': {
          const message = asString(data.message) ?? 'The run failed'
          lastError = message
          // A retry is not terminal: the Workflow step will run again.
          if (data.willRetry === true) {
            out.push(
              kitCustom(KIT_CUSTOM_EVENTS.agentRetry, {
                message,
                ...(typeof data.attempt === 'number' && data.attempt > 0
                  ? { attempt: data.attempt }
                  : {}),
              })
            )
          }
          break
        }
      }
      return out
    },

    finish(current, context = {}) {
      // A parked run is the ONE active state with a terminal event, and it is the spec's own
      // delivery (`RunFinishedInterruptOutcome`) rather than anything kit-shaped — which is what
      // lets a third-party client answer a kit run with zero kit-specific code.
      if (current.status === 'awaiting_input') {
        const pending = (context.interrupts ?? []).filter(row => row.status === 'pending')
        // No pending row is NOT impossible (T6): it is the window between the resolve route's
        // write and the `resumeRun` that follows it. Treated as active — a terminal event here
        // would tell a client the run had stopped on a question that has already been answered.
        if (pending.length === 0) return []
        return [
          {
            type: AguiEventType.RUN_FINISHED,
            threadId: current.id,
            runId: current.id,
            outcome: { type: 'interrupt', interrupts: pending.map(toAguiInterrupt) },
          },
        ]
      }

      // Any other active run has no terminal event: the client keeps reading (or reconnects).
      if (isRunActive(current.status)) return []

      if (current.status === 'succeeded') {
        return [
          {
            type: AguiEventType.RUN_FINISHED,
            threadId: current.id,
            runId: current.id,
            result: current.output ?? null,
          },
        ]
      }
      return [
        {
          type: AguiEventType.RUN_ERROR,
          message:
            current.status === 'cancelled'
              ? 'The run was cancelled'
              : (current.error ?? lastError ?? 'The run failed'),
          code: current.status === 'cancelled' ? 'agent_run_cancelled' : 'agent_run_failed',
        },
      ]
    },
  }
}
