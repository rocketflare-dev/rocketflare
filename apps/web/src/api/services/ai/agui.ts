/**
 * The AG-UI transport, and the small pure pieces `@ag-ui/encoder` does not cover. The contract
 * itself lives in `@rocketflare/shared/ai/agui`; `@ag-ui/encoder` / `@ag-ui/proto` are dependencies
 * of `apps/web` ONLY, so protobuf never reaches the browser.
 *
 * **Content negotiation is the encoder's.** `EventEncoder.encodeBinary()` returns SSE bytes when
 * protobuf is not accepted and a length-prefixed protobuf frame when it is, so one write path
 * serves both transports. Spec-compliant AG-UI SSE is `data: <json>\n\n` with **no `event:` line** —
 * the type lives inside the JSON — which is why this uses hono's generic `stream()` rather than
 * `streamSSE()` (whose `writeSSE` imposes its own framing and content type).
 *
 * **The protobuf schema can lag the event set**: an `@ag-ui/proto` with no message for an event
 * answers an EMPTY frame for it rather than failing — which no client can decode. So
 * {@link createAguiEncoder} drops an event the negotiated transport cannot carry, listed in
 * {@link PROTO_UNSUPPORTED_EVENTS} and pinned by a round-trip in `tests/config/agui-contract.test.ts`.
 * The pinned `@ag-ui/proto` carries every event the kit emits, so the list is empty.
 */

import { EventEncoder } from '@ag-ui/encoder'
import type { KitAguiEvent, KitCustomEventName } from '@rocketflare/shared/ai/agui'
import { AguiEventType, KIT_CUSTOM_EVENTS } from '@rocketflare/shared/ai/agui'
import { documentCardsFromToolResult } from '@rocketflare/shared/ai/embeddings'

/** AG-UI events the installed `@ag-ui/proto` has no message for; dropped on the protobuf wire. */
export const PROTO_UNSUPPORTED_EVENTS: readonly KitAguiEvent['type'][] = []

export interface AguiEncoder {
  /** What to answer `Content-Type` with — `text/event-stream` or the AG-UI protobuf media type. */
  contentType: string
  /** `true` when the client negotiated protobuf (the SSE-only response headers are then wrong). */
  binary: boolean
  /** The bytes for one event, or `null` when this transport cannot carry it. */
  encode(event: KitAguiEvent): Uint8Array | null
}

/** Negotiate the transport from an `Accept` header; anything unrecognised falls back to SSE. */
export function createAguiEncoder(accept: string | undefined): AguiEncoder {
  const encoder = new EventEncoder({ accept })
  const contentType = encoder.getContentType()
  const binary = contentType !== 'text/event-stream'
  return {
    contentType,
    binary,
    encode(event) {
      if (binary && PROTO_UNSUPPORTED_EVENTS.includes(event.type)) return null
      return encoder.encodeBinary(event)
    },
  }
}

/** Build one `kit.` CUSTOM event. The `kit.` namespace is reserved for core; an app picks its own prefix. */
export function kitCustom(name: KitCustomEventName, value: unknown): KitAguiEvent {
  return { type: AguiEventType.CUSTOM, name, value }
}

export type EmitAgui = (event: KitAguiEvent) => Promise<void>

export interface AguiTextSegmenter {
  /** Stream one chunk of assistant text, opening a text message if none is open. */
  delta(text: string): Promise<void>
  /** Close the open text message, if any. Idempotent. */
  close(): Promise<void>
  /**
   * The message id a tool call this turn belongs to: the segment just written, or the run's
   * persisted assistant message id before any text has been streamed.
   */
  parentMessageId(): string
}

/**
 * Open and close `TEXT_MESSAGE_*` around streamed text, one message per model turn.
 *
 * A tool-calling reply produces text on several turns, and reusing ONE `messageId` across several
 * START/END pairs is what strict AG-UI consumers choke on — so each turn gets a fresh uuid and the
 * caller closes the segment before the turn's tool calls. The persisted row keeps `fallbackId`,
 * announced up front in `kit.chat.ids` and repeated in `RUN_FINISHED.result`; the UI accumulates
 * deltas across the whole run regardless of which message they arrived on.
 */
export function aguiTextSegmenter(emit: EmitAgui, fallbackId: string): AguiTextSegmenter {
  let open: string | null = null
  let last = fallbackId
  return {
    async delta(text) {
      if (open === null) {
        open = crypto.randomUUID()
        last = open
        await emit({ type: AguiEventType.TEXT_MESSAGE_START, messageId: open, role: 'assistant' })
      }
      await emit({ type: AguiEventType.TEXT_MESSAGE_CONTENT, messageId: open, delta: text })
    },
    async close() {
      if (open === null) return
      const messageId = open
      open = null
      await emit({ type: AguiEventType.TEXT_MESSAGE_END, messageId })
    },
    parentMessageId: () => last,
  }
}

/** The `runStreamingChat` callbacks that turn a tool call into its AG-UI events. */
export interface AguiToolEvents {
  onToolStart(call: { toolUseId: string; name: string; input: unknown }): Promise<void>
  onToolEnd(call: { toolUseId: string; name: string; result: string }): Promise<void>
  /** Close every tool call left open by a failure, before `RUN_ERROR`. */
  closeOpen(): Promise<void>
}

/**
 * The tool half of a streamed chat turn, shared by the kit's chat (`chat-turn.ts`) and a plugin's
 * `streamChat` so the two cannot drift: `TOOL_CALL_START → ARGS → END` when the model calls a tool
 * (closing the turn's text first — one text message per model turn), then `TOOL_CALL_RESULT` with
 * the tool's own JSON and a `kit.document` card per knowledge document it named.
 */
export function aguiToolEvents(emit: EmitAgui, text: AguiTextSegmenter): AguiToolEvents {
  const open = new Set<string>()
  return {
    async onToolStart(call) {
      // A turn's text ends where its tool calls begin: one text message per model turn.
      await text.close()
      open.add(call.toolUseId)
      await emit({
        type: AguiEventType.TOOL_CALL_START,
        toolCallId: call.toolUseId,
        toolCallName: call.name,
        parentMessageId: text.parentMessageId(),
      })
      // The provider adapters surface a tool input whole, so the args are one chunk.
      await emit({
        type: AguiEventType.TOOL_CALL_ARGS,
        toolCallId: call.toolUseId,
        delta: JSON.stringify(call.input ?? {}),
      })
      await emit({ type: AguiEventType.TOOL_CALL_END, toolCallId: call.toolUseId })
      open.delete(call.toolUseId)
    },
    async onToolEnd(call) {
      // The tool's own JSON, unmodified: the AG-UI-native representation a third-party client
      // renders. `ToolCallResultEvent` has no error flag (AG-UI 1.0).
      await emit({
        type: AguiEventType.TOOL_CALL_RESULT,
        messageId: crypto.randomUUID(),
        toolCallId: call.toolUseId,
        content: call.result,
        role: 'tool',
      })
      // …then the documents it named, as cards. A `kit.` CUSTOM event rather than "let the UI
      // parse the result": that JSON is the knowledge tool's internal shape, retuned whenever its
      // context budget changes, and a React component must not be coupled to it. The mapper is
      // pure and never queries, so it cannot widen scope.
      for (const card of documentCardsFromToolResult(call.name, call.result)) {
        await emit(kitCustom(KIT_CUSTOM_EVENTS.document, { card }))
      }
    },
    async closeOpen() {
      for (const toolCallId of open) {
        await emit({ type: AguiEventType.TOOL_CALL_END, toolCallId })
      }
      open.clear()
    },
  }
}
