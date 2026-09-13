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
import { AguiEventType, KIT_CUSTOM_EVENTS, type KitAguiEvent } from '@rocketflare/shared/ai/agui'
import { documentCardsFromToolResult } from '@rocketflare/shared/ai/embeddings'
import { kitCustom } from '../ai/agui'

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
 */
export function projectRunToAgui(run: AgentRun, events: AgentRunEvent[]): KitAguiEvent[] {
  const out: KitAguiEvent[] = [{ type: AguiEventType.RUN_STARTED, threadId: run.id, runId: run.id }]
  /** Open `tool.start`s by tool name, so a `tool.end` finds the call it answers. */
  const openToolCalls = new Map<string, string>()
  let lastMessageId = run.id
  let lastError: string | undefined

  for (const event of events) {
    const data = asRecord(event.data)
    switch (event.type) {
      case 'status':
        // `running` is the synthetic RUN_STARTED above; the terminal ones are handled from the
        // run row below, which is the authority on how it actually ended.
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
          {
            type: AguiEventType.TEXT_MESSAGE_START,
            messageId: event.id,
            role: 'assistant',
          },
          { type: AguiEventType.TEXT_MESSAGE_CONTENT, messageId: event.id, delta: text },
          { type: AguiEventType.TEXT_MESSAGE_END, messageId: event.id }
        )
        break
      }
      case 'tool.start': {
        const { name: toolName, ...rest } = data
        const name = asString(toolName) ?? 'tool'
        openToolCalls.set(name, event.id)
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
        const toolCallId = openToolCalls.get(name) ?? event.id
        openToolCalls.delete(name)
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
  }

  // An active run has no terminal event: the client polls (or waits for the nudge) and re-reads.
  if (isRunActive(run.status)) return out

  if (run.status === 'succeeded') {
    out.push({
      type: AguiEventType.RUN_FINISHED,
      threadId: run.id,
      runId: run.id,
      result: run.output ?? null,
    })
    return out
  }
  out.push({
    type: AguiEventType.RUN_ERROR,
    message:
      run.status === 'cancelled'
        ? 'The run was cancelled'
        : (run.error ?? lastError ?? 'The run failed'),
    code: run.status === 'cancelled' ? 'agent_run_cancelled' : 'agent_run_failed',
  })
  return out
}
