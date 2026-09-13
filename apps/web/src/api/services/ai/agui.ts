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
 * **The protobuf schema of `@ag-ui/proto@0.0.59` is narrower than the event set**: it has no
 * message for `TOOL_CALL_RESULT`, and its encoder answers an EMPTY frame for one rather than
 * failing — which no client can decode. So {@link createAguiEncoder} drops an event the negotiated
 * transport cannot carry: a fidelity loss of the protobuf transport, pinned by a round-trip in
 * `tests/config/agui-contract.test.ts` so the day upstream gains the message, the list shrinks
 * deliberately.
 */

import { EventEncoder } from '@ag-ui/encoder'
import type { KitAguiEvent, KitCustomEventName } from '@rocketflare/shared/ai/agui'
import { AguiEventType } from '@rocketflare/shared/ai/agui'

/** AG-UI events `@ag-ui/proto@0.0.59` has no message for; they are dropped on the protobuf wire. */
export const PROTO_UNSUPPORTED_EVENTS: readonly KitAguiEvent['type'][] = [
  AguiEventType.TOOL_CALL_RESULT,
]

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

/** Build one kit CUSTOM event. The `kit.` namespace is the kit's; an app picks its own prefix. */
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
