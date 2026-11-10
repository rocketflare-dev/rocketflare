/**
 * AI test doubles: `FakeChatClient` implements `ChatClient` from a script of turns — text,
 * tool calls, usage — records every call, and streams text in word-sized deltas so SSE assertions
 * see more than one frame. `aguiFrames()` parses an AG-UI stream body back into typed events, and
 * `aguiTypes` / `customEvents` let a test assert the SEQUENCE rather than a dozen literals.
 */
import {
  type KitAguiEvent,
  type KitCustomEventName,
  kitAguiEventSchema,
} from '@rocketflare/shared/ai/agui'
import type { TokenUsage } from '@rocketflare/shared/ai/chat'
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

/**
 * Parse an AG-UI SSE body into the typed events it carried. Spec AG-UI frames are `data:` only —
 * a test that finds an `event:` line here should fail, so `sseEventFields` exists to assert it.
 */
export async function aguiFrames(res: Response): Promise<KitAguiEvent[]> {
  return splitSseFrames(await res.text())
    .map(frame => frame.data)
    .filter(Boolean)
    .map(data => kitAguiEventSchema.parse(JSON.parse(data)))
}

/**
 * Every frame of an SSE body, split into its `event:` (if any), its `id:` (if any) and the joined
 * `data:` lines. A frame with no `data:` — a `: ping` comment — keeps its raw text, so a test can
 * assert that a binary transport wrote no comment frames at all.
 */
export function splitSseFrames(
  text: string
): { event: string | null; id: string | null; data: string; raw: string }[] {
  return text
    .split('\n\n')
    .filter(raw => raw.trim())
    .map(raw => {
      const lines = raw.split('\n')
      return {
        raw,
        id:
          lines
            .find(l => l.startsWith('id:'))
            ?.slice(3)
            .trim() ?? null,
        event:
          lines
            .find(l => l.startsWith('event:'))
            ?.slice(6)
            .trim() ?? null,
        data: lines
          .filter(l => l.startsWith('data:'))
          .map(l => l.slice(5).trim())
          .join('\n'),
      }
    })
}

/** The event types of a run, in order — what a sequence assertion actually cares about. */
export function aguiTypes(events: KitAguiEvent[]): string[] {
  return events.map(e => e.type)
}

/** The kit CUSTOM events of a run, `name` → `value`, in order. */
export function customEvents(events: KitAguiEvent[]): { name: string; value: unknown }[] {
  return events.flatMap(e => (e.type === 'CUSTOM' ? [{ name: e.name, value: e.value }] : []))
}

/** The value of the LAST kit CUSTOM event with this name, or undefined. */
export function customEvent(events: KitAguiEvent[], name: KitCustomEventName): unknown {
  return customEvents(events)
    .filter(e => e.name === name)
    .at(-1)?.value
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

/** One model turn of {@link scriptPlatformChat}: what the platform model answers. */
export interface PlatformChatTurn {
  text?: string
  toolCalls?: Array<{ id?: string; name: string; input: unknown }>
  usage?: { inputTokens: number; outputTokens: number }
}

/** What the platform model was asked, one entry per chat call. */
export interface PlatformChatCall {
  model: string
  messages: unknown[]
  tools: unknown[]
}

/**
 * Script the PLATFORM chat model — the `AI` binding's stub — so a request resolves a real chat
 * client through the real seam (`resolveChat` → `platformChat` → the Workers AI adapter) and no
 * module needs `vi.mock`. The way a plugin's test drives `streamChat` (or anything else that
 * resolves chat) with a deterministic model. Turns are answered in order and the last one repeats;
 * embeddings calls keep the stub's deterministic vectors. Returns the recorded chat calls.
 *
 * Needs `env.AI` (the default `createTestEnv()` has it) and no `ANTHROPIC_API_KEY` (the platform
 * prefers that key); a tenant `ai_configs` row would answer instead of the platform.
 */
export function scriptPlatformChat(
  env: { AI?: unknown },
  script: PlatformChatTurn[] | ((call: PlatformChatCall, index: number) => PlatformChatTurn)
): PlatformChatCall[] {
  const ai = env.AI as
    | { respond: (model: string, inputs: Record<string, unknown>) => unknown }
    | undefined
  if (!ai) throw new Error('scriptPlatformChat: the env has no AI binding')
  const calls: PlatformChatCall[] = []
  const fallback = ai.respond.bind(ai)
  ai.respond = (model, inputs) => {
    if (!Array.isArray(inputs.messages)) return fallback(model, inputs)
    const call: PlatformChatCall = {
      model,
      messages: inputs.messages,
      tools: Array.isArray(inputs.tools) ? inputs.tools : [],
    }
    const index = calls.length
    calls.push(call)
    const turn =
      typeof script === 'function'
        ? script(call, index)
        : (script[index] ?? script[script.length - 1] ?? {})
    const usage = turn.usage ?? { inputTokens: 10, outputTokens: 5 }
    return {
      response: turn.text ?? '',
      tool_calls: (turn.toolCalls ?? []).map((t, i) => ({
        id: t.id ?? `call_${index}_${i}`,
        name: t.name,
        arguments: t.input,
      })),
      usage: {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
      },
    }
  }
  return calls
}
