/**
 * AI test doubles (D17): `FakeChatClient` implements `ChatClient` from a script of turns — text,
 * tool calls, usage — records every call, and streams text in word-sized deltas so SSE assertions
 * see more than one frame. `sseFrames()` parses a `streamSSE` body back into `ChatStreamEvent`s.
 */
import {
  type ChatStreamEvent,
  chatStreamEventSchema,
  type TokenUsage,
} from '@rocketflare/shared/ai/chat'
import type { AiProvider } from '@rocketflare/shared/ai/config'
import type {
  ChatClient,
  ChatDelta,
  ChatParams,
  ChatResult,
  ContentBlock,
  StopReason,
} from '@/api/services/ai/types'

export interface FakeTurn {
  text?: string
  toolUses?: Array<{ id?: string; name: string; input: unknown }>
  usage?: TokenUsage
  stopReason?: StopReason
  model?: string
  /** Throw this instead of answering. */
  error?: Error
}

export type FakeScript = FakeTurn[] | ((params: ChatParams, index: number) => FakeTurn)

export class FakeChatClient implements ChatClient {
  readonly calls: ChatParams[] = []
  constructor(
    private readonly script: FakeScript,
    readonly provider: AiProvider = 'anthropic'
  ) {}

  private next(params: ChatParams): ChatResult {
    const index = this.calls.length
    this.calls.push(params)
    const turn =
      typeof this.script === 'function'
        ? this.script(params, index)
        : (this.script[index] ?? this.script[this.script.length - 1] ?? {})
    if (turn.error) throw turn.error
    const content: ContentBlock[] = []
    if (turn.text) content.push({ type: 'text', text: turn.text })
    for (const [i, t] of (turn.toolUses ?? []).entries()) {
      content.push({
        type: 'tool_use',
        id: t.id ?? `toolu_${index}_${i}`,
        name: t.name,
        input: t.input,
      })
    }
    return {
      content,
      stopReason: turn.stopReason ?? (turn.toolUses?.length ? 'tool_use' : 'end_turn'),
      usage: turn.usage ?? { inputTokens: 10, outputTokens: 5 },
      model: turn.model ?? params.model,
    }
  }

  async complete(params: ChatParams): Promise<ChatResult> {
    return this.next(params)
  }

  async *stream(params: ChatParams): AsyncIterable<ChatDelta> {
    const result = this.next(params)
    for (const block of result.content) {
      if (block.type === 'text') {
        for (const piece of block.text.match(/\S+\s*/g) ?? []) yield { type: 'text', text: piece }
      } else if (block.type === 'tool_use') {
        yield block
      }
    }
    yield { type: 'usage', usage: result.usage }
    yield { type: 'end', result }
  }
}

/** Parse a `streamSSE` response body into the typed frames it carried. */
export async function sseFrames(res: Response): Promise<ChatStreamEvent[]> {
  const text = await res.text()
  return text
    .split('\n\n')
    .map(frame =>
      frame
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n')
    )
    .filter(Boolean)
    .map(data => chatStreamEventSchema.parse(JSON.parse(data)))
}

/** Build a `Response` whose body is `chunks` joined as an SSE stream — for fetch-injected clients. */
export function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    ...init,
  })
}
