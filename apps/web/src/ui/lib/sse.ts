/**
 * Server-sent events over `fetch`. `EventSource` is GET-only and cannot carry the session cookie's
 * CSRF headers, so a streaming route is POSTed and its `text/event-stream` body is read by hand.
 *
 * This module is transport only and imports NO schema: the caller passes `parse`, so the shell
 * never drags a protocol's schemas into the main bundle (AG-UI arrives through the lazy chat
 * chunk). Spec-compliant AG-UI frames carry no `event:` line — the type is inside the JSON — so
 * `SseFrame.event` is parsed for completeness and nothing keys on it. A frame that fails `parse`
 * is dropped: a newer server may emit one this build does not know, and that is never a reason to
 * crash mid-reply.
 */

/** One raw SSE frame before JSON parsing. `event` defaults to `message` per the spec. */
export interface SseFrame {
  event: string
  data: string
  id?: string
}

/**
 * Parse one frame's lines. Multiple `data:` lines join with `\n`; a `:` comment line is ignored;
 * a single optional space after the colon is stripped (the spec allows exactly one).
 */
export function parseSseFrame(raw: string): SseFrame | null {
  let event = 'message'
  let id: string | undefined
  const data: string[] = []
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    else if (field === 'id') id = value
  }
  if (data.length === 0) return null
  return { event, data: data.join('\n'), id }
}

/**
 * Incremental frame splitter: feed decoded text in any chunking, get complete frames back. A
 * frame split across two network chunks (mid-`data:` line included) is reassembled; `\r\n`
 * separators are normalised.
 */
export class SseFrameBuffer {
  private buffer = ''

  push(text: string): SseFrame[] {
    this.buffer += text.replace(/\r\n/g, '\n')
    const frames: SseFrame[] = []
    let sep = this.buffer.indexOf('\n\n')
    while (sep !== -1) {
      const raw = this.buffer.slice(0, sep)
      this.buffer = this.buffer.slice(sep + 2)
      const frame = parseSseFrame(raw)
      if (frame) frames.push(frame)
      sep = this.buffer.indexOf('\n\n')
    }
    return frames
  }

  /** The stream closed: whatever is left is the last frame if it has a `data:` line. */
  flush(): SseFrame[] {
    const raw = this.buffer
    this.buffer = ''
    const frame = raw.trim() ? parseSseFrame(raw) : null
    return frame ? [frame] : []
  }
}

export interface ReadSseOptions {
  /** Aborting cancels the body reader; `readSse` then resolves normally (an abort is not an error). */
  signal?: AbortSignal
  /** A frame whose `data` did not parse — logged by the caller, never thrown. */
  onInvalid?: (frame: SseFrame, reason: string) => void
}

/** Turn one frame's JSON into an event, or explain why it is not one. */
export type SseFrameParser<T> = (
  json: unknown
) => { ok: true; event: T } | { ok: false; reason: string }

/** `true` for the DOMException `fetch`/`reader.read()` reject with when the signal fires. */
export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || (error as { code?: number }).code === 20)
  )
}

/**
 * Read a `text/event-stream` response to the end, calling `onEvent` for every frame `parse`
 * accepts. Resolves when the server closes the stream or the signal aborts; rejects only on a
 * transport error. The caller decides what a missing terminal event means.
 *
 * `onEvent` receives the raw {@link SseFrame} as a second argument, because a frame's `id` IS the
 * resume cursor for a route that has one (`GET /runs/:id/agui/stream` writes the event `seq`
 * there) and parsing it out only to discard it would put that cursor out of reach. Additive: a
 * caller that does not resume — `aguiStream.ts` — simply ignores it.
 */
export async function readSse<T>(
  response: Response,
  parse: SseFrameParser<T>,
  onEvent: (event: T, frame: SseFrame) => void,
  { signal, onInvalid }: ReadSseOptions = {}
): Promise<void> {
  if (!response.body) throw new Error('SSE response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const frames = new SseFrameBuffer()

  const dispatch = (frame: SseFrame) => {
    let json: unknown
    try {
      json = JSON.parse(frame.data)
    } catch {
      onInvalid?.(frame, 'data is not JSON')
      return
    }
    const parsed = parse(json)
    if (!parsed.ok) {
      onInvalid?.(frame, parsed.reason)
      return
    }
    onEvent(parsed.event, frame)
  }

  const onAbort = () => {
    reader.cancel().catch(() => {})
  }
  if (signal?.aborted) {
    onAbort()
    return
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      for (const frame of frames.push(decoder.decode(value, { stream: true }))) dispatch(frame)
    }
    for (const frame of frames.push(decoder.decode())) dispatch(frame)
    for (const frame of frames.flush()) dispatch(frame)
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) return
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}
