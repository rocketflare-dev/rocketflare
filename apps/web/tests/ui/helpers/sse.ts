/**
 * Fake `text/event-stream` responses for the chat tests: frames are encoded exactly as the server's
 * AG-UI encoder writes them — `data: <json>\n\n`, **no `event:` line** — and enqueued through a
 * `ReadableStream`, optionally split at arbitrary byte offsets to exercise reassembly.
 */

import { AguiEventType, KIT_CUSTOM_EVENTS, type KitAguiEvent } from '@rocketflare/shared/ai/agui'
import { documentCardsFromToolResult } from '@rocketflare/shared/ai/embeddings'

export function encodeSseFrame(event: KitAguiEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

export interface AguiRunOptions {
  conversationId: string
  userMessageId: string
  assistantMessageId: string
  text?: string[]
  /** Tool calls, in order, each rendered as START → ARGS → END → RESULT. */
  tools?: { id: string; name: string; input?: unknown; result?: string }[]
  usage?: { inputTokens: number; outputTokens: number }
  /** Leave the run open (no `RUN_FINISHED`) — what a cancelled run looks like. */
  unterminated?: true
}

/** A whole chat turn as the server emits it, for a test that cares about the reply, not the wire. */
export function aguiRun(options: AguiRunOptions): KitAguiEvent[] {
  const { conversationId, userMessageId, assistantMessageId } = options
  const usage = options.usage ?? { inputTokens: 12, outputTokens: 5 }
  const events: KitAguiEvent[] = [
    { type: AguiEventType.RUN_STARTED, threadId: conversationId, runId: 'run-1' },
    {
      type: AguiEventType.CUSTOM,
      name: KIT_CUSTOM_EVENTS.chatIds,
      value: {
        conversationId,
        userMessageId,
        assistantMessageId,
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
      },
    },
    {
      type: AguiEventType.STATE_SNAPSHOT,
      snapshot: { conversationId, provider: 'anthropic', model: 'claude-sonnet-4-5', tools: [] },
    },
  ]
  for (const tool of options.tools ?? []) {
    events.push(
      {
        type: AguiEventType.TOOL_CALL_START,
        toolCallId: tool.id,
        toolCallName: tool.name,
        parentMessageId: assistantMessageId,
      },
      {
        type: AguiEventType.TOOL_CALL_ARGS,
        toolCallId: tool.id,
        delta: JSON.stringify(tool.input ?? {}),
      },
      { type: AguiEventType.TOOL_CALL_END, toolCallId: tool.id },
      {
        type: AguiEventType.TOOL_CALL_RESULT,
        messageId: `${tool.id}-result`,
        toolCallId: tool.id,
        content: tool.result ?? '{}',
        role: 'tool',
      }
    )
    // Mirror the server: `CUSTOM kit.document` follows the result it was derived from, through the
    // same pure mapper, so a UI test asserting cards is asserting the real framing (D18).
    for (const card of documentCardsFromToolResult(tool.name, tool.result ?? '{}')) {
      events.push({
        type: AguiEventType.CUSTOM,
        name: KIT_CUSTOM_EVENTS.document,
        value: { card },
      })
    }
  }
  const deltas = options.text ?? []
  if (deltas.length) {
    events.push({
      type: AguiEventType.TEXT_MESSAGE_START,
      messageId: assistantMessageId,
      role: 'assistant',
    })
    for (const delta of deltas) {
      events.push({
        type: AguiEventType.TEXT_MESSAGE_CONTENT,
        messageId: assistantMessageId,
        delta,
      })
    }
    events.push({ type: AguiEventType.TEXT_MESSAGE_END, messageId: assistantMessageId })
  }
  if (options.unterminated) return events
  events.push(
    { type: AguiEventType.CUSTOM, name: KIT_CUSTOM_EVENTS.usage, value: { usage } },
    {
      type: AguiEventType.RUN_FINISHED,
      threadId: conversationId,
      runId: 'run-1',
      result: {
        conversationId,
        messageId: assistantMessageId,
        usage,
        stopReason: 'end_turn',
      },
    }
  )
  return events
}

/** A `Response` whose body streams the given text chunks in order. */
export function streamResponse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    ...init,
  })
}

/** One chunk per frame — the common case. */
export function sseResponse(events: KitAguiEvent[]): Response {
  return streamResponse(events.map(encodeSseFrame))
}

/** A `Response` whose body NEVER closes until `abort()` is called — for the Stop button. */
export function hangingSseResponse(events: KitAguiEvent[]) {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      for (const event of events) c.enqueue(encoder.encode(encodeSseFrame(event)))
    },
    cancel() {
      controller = null
    },
  })
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
    push(event: KitAguiEvent) {
      controller?.enqueue(encoder.encode(encodeSseFrame(event)))
    },
    close() {
      controller?.close()
      controller = null
    },
  }
}
