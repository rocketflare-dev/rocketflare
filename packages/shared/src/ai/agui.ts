/**
 * AG-UI (https://docs.ag-ui.com) is the wire protocol for BOTH the chat stream
 * (`POST /api/chat/conversations/:id/messages`, `POST /api/agui/run`) and the read-time projection
 * of an agent run (`GET /api/agents/runs/:id/agui`). The schemas come from `@ag-ui/core`, so the
 * server and the UI validate against the protocol's own definitions rather than a mirror of them.
 *
 * Two rules hold the contract together:
 *
 * - **The kit emits a SUBSET.** {@link kitAguiEventSchema} is a discriminated union over exactly the
 *   events the kit produces, not `@ag-ui/core`'s full set. It documents the subset, keeps the
 *   browser's parse cost to what it needs, and leaves room for the server to lead — the UI drops a
 *   frame it cannot parse rather than failing the reply.
 * - **Every kit-specific semantic is a CUSTOM event** under the `kit.` namespace
 *   ({@link KIT_CUSTOM_EVENTS}). A third-party AG-UI client ignores them for free; an app adds its
 *   own under its own prefix and never `kit.`.
 *
 * The `@ag-ui/core` version is pinned exactly: its schemas ARE the wire format, so a bump is a
 * protocol bump. `apps/web/tests/config/agui-contract.test.ts` round-trips every emitted event
 * through the installed schemas, which is what turns the pin into a gate.
 */
import {
  CustomEventSchema,
  EventType,
  MessagesSnapshotEventSchema,
  RunAgentInputSchema,
  RunErrorEventSchema,
  RunFinishedEventSchema,
  RunStartedEventSchema,
  StateSnapshotEventSchema,
  StepFinishedEventSchema,
  StepStartedEventSchema,
  TextMessageContentEventSchema,
  TextMessageEndEventSchema,
  TextMessageStartEventSchema,
  ToolCallArgsEventSchema,
  ToolCallEndEventSchema,
  ToolCallResultEventSchema,
  ToolCallStartEventSchema,
} from '@ag-ui/core'
import { z } from 'zod'
import { MAX_MESSAGE_LENGTH, tokenUsageSchema } from './chat'
import { aiProviderSchema } from './config'
import { documentCardSchema } from './embeddings'

export { EventType as AguiEventType }

/**
 * Exactly the AG-UI events the kit emits, across the chat stream and the agent-run projection.
 * Never widen this to `@ag-ui/core`'s full union: the point is a documented, testable subset.
 */
export const kitAguiEventSchema = z.discriminatedUnion('type', [
  RunStartedEventSchema,
  RunFinishedEventSchema,
  RunErrorEventSchema,
  StepStartedEventSchema,
  StepFinishedEventSchema,
  TextMessageStartEventSchema,
  TextMessageContentEventSchema,
  TextMessageEndEventSchema,
  ToolCallStartEventSchema,
  ToolCallArgsEventSchema,
  ToolCallEndEventSchema,
  ToolCallResultEventSchema,
  StateSnapshotEventSchema,
  MessagesSnapshotEventSchema,
  CustomEventSchema,
])
export type KitAguiEvent = z.infer<typeof kitAguiEventSchema>

/** The AG-UI event types the kit emits — the union's discriminants, as a checkable list. */
export const KIT_AGUI_EVENT_TYPES = [
  EventType.RUN_STARTED,
  EventType.RUN_FINISHED,
  EventType.RUN_ERROR,
  EventType.STEP_STARTED,
  EventType.STEP_FINISHED,
  EventType.TEXT_MESSAGE_START,
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.TEXT_MESSAGE_END,
  EventType.TOOL_CALL_START,
  EventType.TOOL_CALL_ARGS,
  EventType.TOOL_CALL_END,
  EventType.TOOL_CALL_RESULT,
  EventType.STATE_SNAPSHOT,
  EventType.MESSAGES_SNAPSHOT,
  EventType.CUSTOM,
] as const

// ---- The kit's CUSTOM namespace ---------------------------------------------------------------

/**
 * Every kit semantic AG-UI has no event for. The name is the contract; the payload is validated by
 * {@link kitCustomPayloadSchema}. An app adding its own events picks its own prefix.
 */
export const KIT_CUSTOM_EVENTS = {
  /**
   * The ids for this turn, first thing after `RUN_STARTED`: `RUN_STARTED` has nowhere to put them
   * and `RUN_FINISHED.result` arrives far too late — the UI swaps its optimistic bubble's id the
   * moment the turn starts.
   */
  chatIds: 'kit.chat.ids',
  /** Token usage for the whole run, emitted just before the terminal event and mirrored into it. */
  usage: 'kit.usage',
  /** An agent-run step's label/detail, which `STEP_STARTED.stepName` alone cannot carry. */
  agentStep: 'kit.agent.step',
  /** An agent-run attempt failed and the Workflow will retry it; the run is NOT terminal. */
  agentRetry: 'kit.agent.retry',
  /** Something the reader should know about this run that is not an error (see `KIT_NOTICE_CODES`). */
  notice: 'kit.notice',
  /**
   * A knowledge document a tool call in this run touched, as a card (D18). Emitted after the
   * `TOOL_CALL_RESULT` it was derived from, one event per document.
   *
   * It is a kit CUSTOM event rather than "let the UI parse `TOOL_CALL_RESULT`" on purpose: that
   * result is `search-knowledge.ts`'s internal JSON, which that file explicitly reserves the right
   * to retune for context budgets — a prompt change would silently break a React component. This
   * is kit-owned, versioned, zod-validated, and ignored for free by a third-party client.
   */
  document: 'kit.document',
} as const

export type KitCustomEventName = (typeof KIT_CUSTOM_EVENTS)[keyof typeof KIT_CUSTOM_EVENTS]

/**
 * Notices the kit raises — things a reader should know that are NOT failures.
 *
 * - `workers_ai_no_token_streaming`: tools are on and the provider is `workers_ai`, which has no
 *   documented tool-call event stream, so the reply arrives in bursts per model turn.
 * - `history_summarised`: the thread outgrew its context budget; the trimmed prefix is present as a
 *   summary.
 * - `history_truncated`: the same, but no summary covers the trimmed prefix YET — compaction is a
 *   background job, so the turn that first crosses the budget answers without it.
 */
export const KIT_NOTICE_CODES = [
  'workers_ai_no_token_streaming',
  'history_summarised',
  'history_truncated',
] as const
export const kitNoticeCodeSchema = z.enum(KIT_NOTICE_CODES)
export type KitNoticeCode = z.infer<typeof kitNoticeCodeSchema>

export const kitChatIdsSchema = z.object({
  conversationId: z.string().uuid(),
  userMessageId: z.string().uuid(),
  /** The id the assistant message is persisted under, whatever `messageId`s the text segments use. */
  assistantMessageId: z.string().uuid(),
  provider: aiProviderSchema,
  model: z.string(),
})
export type KitChatIds = z.infer<typeof kitChatIdsSchema>

export const kitUsageSchema = z.object({ usage: tokenUsageSchema })

export const kitAgentStepSchema = z.object({
  key: z.string(),
  label: z.string(),
  status: z.enum(['running', 'done', 'error']),
  detail: z.string().optional(),
})

export const kitAgentRetrySchema = z.object({
  message: z.string(),
  attempt: z.number().int().positive().optional(),
})

/** One document a tool call surfaced. The card is built from the tool's JSON, never a query. */
export const kitDocumentSchema = z.object({ card: documentCardSchema })

export const kitNoticeSchema = z.object({
  code: kitNoticeCodeSchema,
  message: z.string().optional(),
})

/** `CUSTOM.value` keyed by `CUSTOM.name` — the mapping a consumer needs to read the namespace. */
export const kitCustomPayloadSchema = {
  [KIT_CUSTOM_EVENTS.chatIds]: kitChatIdsSchema,
  [KIT_CUSTOM_EVENTS.usage]: kitUsageSchema,
  [KIT_CUSTOM_EVENTS.agentStep]: kitAgentStepSchema,
  [KIT_CUSTOM_EVENTS.agentRetry]: kitAgentRetrySchema,
  [KIT_CUSTOM_EVENTS.notice]: kitNoticeSchema,
  [KIT_CUSTOM_EVENTS.document]: kitDocumentSchema,
} as const

/**
 * Read one kit CUSTOM event, or `undefined` when the name is not ours or the payload does not
 * match. Never throws: an unknown `kit.*` from a newer server is a frame this build ignores.
 */
export function parseKitCustom<N extends KitCustomEventName>(
  name: N,
  event: KitAguiEvent
): z.infer<(typeof kitCustomPayloadSchema)[N]> | undefined {
  if (event.type !== EventType.CUSTOM || event.name !== name) return undefined
  const parsed = kitCustomPayloadSchema[name].safeParse(event.value)
  return parsed.success ? (parsed.data as z.infer<(typeof kitCustomPayloadSchema)[N]>) : undefined
}

// ---- `RUN_FINISHED.result` for a chat turn ----------------------------------------------------

/** What `RUN_FINISHED.result` carries when the run was a chat turn — the persisted row, restated. */
export const chatRunResultSchema = z.object({
  conversationId: z.string().uuid(),
  /** The persisted assistant message id (`kit.chat.ids.assistantMessageId`). */
  messageId: z.string().uuid(),
  usage: tokenUsageSchema,
  stopReason: z.string(),
})
export type ChatRunResult = z.infer<typeof chatRunResultSchema>

/** `GET /api/agents/runs/:id/agui` — the run's durable events, projected. */
export const agentRunAguiResponseSchema = z.object({ events: z.array(kitAguiEventSchema) })
export type AgentRunAguiResponse = z.infer<typeof agentRunAguiResponseSchema>

// ---- `POST /api/agui/run` input ---------------------------------------------------------------

/**
 * `RunAgentInput` as this server accepts it structurally: a `threadId` this server can use as a
 * conversation primary key, and at least one message.
 */
export const kitRunAgentInputSchema = RunAgentInputSchema.extend({
  threadId: z.string().uuid(),
  messages: z.array(RunAgentInputSchema.shape.messages.element).min(1),
})
export type KitRunAgentInput = z.infer<typeof kitRunAgentInputSchema>

/**
 * The reconciliation rule in one function: **the server is the transcript, the client supplies
 * only the tail**. The LAST message is the new user turn; every earlier one is ignored, because
 * the history the model sees comes from the database. Client-side tools are refused rather than
 * ignored — a client waiting for a call that can never come is worse than a 400.
 *
 * Returns the turn's text, or the `ERROR_CODES` value the route answers with. Shared so the route
 * and its tests agree on one implementation.
 */
export function readRunAgentTail(input: KitRunAgentInput):
  | { ok: true; id: string; content: string }
  | {
      ok: false
      code:
        | 'agui_client_tools_unsupported'
        | 'agui_last_message_not_user'
        | 'agui_unsupported_content'
    } {
  if (input.tools.length > 0) return { ok: false, code: 'agui_client_tools_unsupported' }
  const last = input.messages[input.messages.length - 1]
  if (!last || last.role !== 'user') return { ok: false, code: 'agui_last_message_not_user' }
  if (typeof last.content !== 'string') return { ok: false, code: 'agui_unsupported_content' }
  const content = last.content.trim()
  if (!content || content.length > MAX_MESSAGE_LENGTH)
    return { ok: false, code: 'agui_unsupported_content' }
  return { ok: true, id: last.id, content }
}
