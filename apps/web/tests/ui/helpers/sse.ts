/**
 * Fake `text/event-stream` responses for the chat tests (D17): frames are encoded exactly as
 * Hono's `streamSSE` writes them (`event: <type>\ndata: <json>\n\n`) and enqueued through a
 * `ReadableStream`, optionally split at arbitrary byte offsets to exercise reassembly.
 */
import type { ChatStreamEvent } from '@rocketflare/shared/ai/chat'

export function encodeSseFrame(event: ChatStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
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
export function sseResponse(events: ChatStreamEvent[]): Response {
  return streamResponse(events.map(encodeSseFrame))
}

/** A `Response` whose body NEVER closes until `abort()` is called — for the Stop button. */
export function hangingSseResponse(events: ChatStreamEvent[]) {
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
    push(event: ChatStreamEvent) {
      controller?.enqueue(encoder.encode(encodeSseFrame(event)))
    },
    close() {
      controller?.close()
      controller = null
    },
  }
}
