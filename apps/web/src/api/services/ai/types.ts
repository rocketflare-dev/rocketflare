/**
 * The provider seam (D17): a small, provider-neutral chat/embeddings interface that every consumer
 * (chat route, `kit.ts` loops, Phase 3b agents) codes against. Adapters in `client.ts` map it onto
 * the Anthropic Messages API (`anthropic`, `anthropic_compatible`) and OpenAI chat completions
 * (`openai`, `openai_compatible`). Content is block-shaped — text, tool_use, tool_result — because
 * that is what a tool loop needs to round-trip; a plain string is accepted as shorthand.
 */
import type { TokenUsage } from '@rocketflare/shared/ai/chat'
import type { AiProvider, ThinkingSetting } from '@rocketflare/shared/ai/config'

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

/**
 * A system prompt, optionally split at the prompt-cache breakpoint: `stable` is cached, `volatile`
 * (per-turn context) is appended AFTER the breakpoint so one byte of drift never invalidates the
 * cached prefix. A plain string is entirely stable. Only Anthropic honours the split; the OpenAI
 * adapter concatenates.
 */
export type SystemPrompt = string | { stable: string; volatile?: string }

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema (object) for the tool input — `zodToJsonSchema` in `kit.ts` builds it from zod. */
  inputSchema: Record<string, unknown>
}

export type ToolChoice =
  | { type: 'auto' }
  | { type: 'none' }
  | { type: 'any' }
  | { type: 'tool'; name: string }

export interface ChatParams {
  model: string
  system?: SystemPrompt
  messages: ChatMessage[]
  maxTokens: number
  tools?: ToolDefinition[]
  toolChoice?: ToolChoice
  temperature?: number
  signal?: AbortSignal
  /** Anthropic prompt caching breakpoints on system + last two messages (default true). */
  cache?: boolean
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'unknown'

export interface ChatResult {
  content: ContentBlock[]
  stopReason: StopReason
  usage: TokenUsage
  model: string
}

/** What `stream()` yields. Tool calls arrive whole once their input JSON is complete. */
export type ChatDelta =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'end'; result: ChatResult }

export interface ChatClient {
  readonly provider: AiProvider
  stream(params: ChatParams): AsyncIterable<ChatDelta>
  complete(params: ChatParams): Promise<ChatResult>
  /** Anthropic only today; absent means "estimate yourself". */
  countTokens?(params: Pick<ChatParams, 'model' | 'system' | 'messages' | 'tools'>): Promise<number>
}

export interface EmbeddingsClient {
  readonly provider: AiProvider
  readonly model: string
  /** Every vector `embed` returns has this many components (D18: 1024). */
  readonly dimension: number
  embed(texts: string[]): Promise<number[][]>
}

/** Per-tenant request-body defaults injected where the client is BUILT (never at call sites). */
export interface RequestDefaults {
  serviceTier?: string | null
  thinking?: ThinkingSetting
}

/** One file handed to Workers AI Markdown Conversion. */
export interface MarkdownDocumentInput {
  name: string
  blob: Blob
}

/** What `AI.toMarkdown` answers for one file — the platform's `ConversionResponse`, declared here so shared code never sees the global. */
export type MarkdownConversion =
  | { name: string; mimeType: string; format: 'markdown' | 'text'; tokens: number; data: string }
  | { name: string; mimeType: string; format: 'error'; error: string }

/**
 * The narrow slice of the `AI` binding the kit needs (`Ai` in production, `RecordingAi` in tests):
 * `run` for the embeddings/chat adapters, `toMarkdown` for document conversion (D18 uploads).
 */
export interface WorkersAiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>
  toMarkdown?(document: MarkdownDocumentInput): Promise<MarkdownConversion>
}

/** The bindings the resolver may read. Optional: a Worker without `[ai]` still chats. */
export interface AiEnv {
  AI?: WorkersAiBinding | Ai
}

/** The conversion slice of the binding, or null when the Worker has no `[ai]` (or a stub without it). */
export function markdownConverterOf(
  env: AiEnv
): ((document: MarkdownDocumentInput) => Promise<MarkdownConversion>) | null {
  const ai = env.AI as WorkersAiBinding | undefined
  if (!ai || typeof ai.toMarkdown !== 'function') return null
  return document =>
    (ai.toMarkdown as NonNullable<WorkersAiBinding['toMarkdown']>).call(ai, document)
}

/** Sum two usage reports (multi-turn loops report the total). */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const out: TokenUsage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  }
  if (a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined) {
    out.cacheReadTokens = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0)
  }
  if (a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined) {
    out.cacheWriteTokens = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0)
  }
  return out
}

export const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 }

/** The concatenated text blocks of a result. */
export function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map(b => b.text)
    .join('')
}

export function toolUsesOf(content: ContentBlock[]) {
  return content.filter(
    (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use'
  )
}
