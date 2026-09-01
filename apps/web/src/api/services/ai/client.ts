/**
 * Provider adapters (D17) behind the `ChatClient` / `EmbeddingsClient` seam in `types.ts`.
 *   - `anthropic` / `anthropic_compatible` → `@anthropic-ai/sdk` (fetch-based, runs in Workers).
 *     Compatible vendors authenticate with `Authorization: Bearer` (the SDK's `authToken`), NOT
 *     `x-api-key` — passing the key as `apiKey` sends the wrong header and reads as a bad key.
 *   - `openai` / `openai_compatible` → a small fetch client for `/v1/chat/completions` (SSE) and
 *     `/v1/embeddings`. Base URLs include `/v1`.
 *   - `workers_ai` → `env.AI.run(model, { text })` (embeddings only, zero key).
 * Per-tenant request defaults (`service_tier`, `thinking`) are injected HERE, where the client is
 * built, so no call site can forget them; `reconcileThinking` keeps a thinking budget legal against
 * the request it lands in. `fetch` is injectable so tests drive the adapters without a network.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { TokenUsage } from '@gmgo/shared/ai/chat'
import { type AiProvider, EMBEDDING_DIM, THINKING_ANSWER_HEADROOM } from '@gmgo/shared/ai/config'
import { AiError, normalizeAiError } from './errors'
import { cachedSystem, withRollingCacheBreakpoints } from './kit'
import { DEFAULT_BASE_URLS } from './providers'
import type {
  AiEnv,
  ChatClient,
  ChatMessage,
  ChatParams,
  ChatResult,
  ContentBlock,
  EmbeddingsClient,
  RequestDefaults,
  StopReason,
  WorkersAiBinding,
} from './types'

export type FetchLike = typeof fetch

export interface ChatClientOptions {
  provider: AiProvider
  apiKey?: string | null
  baseUrl?: string | null
  defaults?: RequestDefaults
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: FetchLike
}

export interface EmbeddingsClientOptions {
  provider: AiProvider
  model: string
  apiKey?: string | null
  baseUrl?: string | null
  /** The `AI` binding, for `workers_ai`. */
  ai?: AiEnv['AI']
  fetch?: FetchLike
}

/** `tool_choice` values that FORCE a tool call and are therefore incompatible with extended thinking. */
const FORCED_TOOL_CHOICES = new Set(['tool', 'any'])

/**
 * Make an enabled thinking budget legal against the request it lands in: (1) thinking may not be
 * enabled when `tool_choice` forces a tool — drop it; (2) `max_tokens` must clear the budget by a
 * usable margin — raise it (output is billed on tokens produced, a cap never reached costs nothing).
 */
export function reconcileThinking(body: Record<string, unknown>): Record<string, unknown> {
  const thinking = body.thinking as { type?: string; budget_tokens?: number } | undefined
  if (thinking?.type !== 'enabled' || typeof thinking.budget_tokens !== 'number') return body
  const choice = (body.tool_choice as { type?: string } | undefined)?.type ?? ''
  if (FORCED_TOOL_CHOICES.has(choice)) {
    const { thinking: _dropped, ...rest } = body
    return rest
  }
  const floor = thinking.budget_tokens + THINKING_ANSWER_HEADROOM
  if (typeof body.max_tokens === 'number' && body.max_tokens >= floor) return body
  return { ...body, max_tokens: floor }
}

/** The body params a config's defaults imply. Thinking is sent EXPLICITLY when the provider takes it. */
function anthropicDefaults(defaults: RequestDefaults | undefined): Record<string, unknown> {
  if (!defaults) return { thinking: { type: 'disabled' } }
  const out: Record<string, unknown> = {}
  if (defaults.serviceTier) out.service_tier = defaults.serviceTier
  const thinking = defaults.thinking
  out.thinking =
    thinking?.enabled && thinking.budgetTokens
      ? { type: 'enabled', budget_tokens: thinking.budgetTokens }
      : { type: 'disabled' }
  return out
}

export function createChatClient(opts: ChatClientOptions): ChatClient {
  switch (opts.provider) {
    case 'anthropic':
    case 'anthropic_compatible':
      return createAnthropicChatClient(opts)
    case 'openai':
    case 'openai_compatible':
      return createOpenAiChatClient(opts)
    default:
      throw new AiError('invalid_request', opts.provider, `${opts.provider} has no chat adapter`)
  }
}

export function createEmbeddingsClient(opts: EmbeddingsClientOptions): EmbeddingsClient {
  switch (opts.provider) {
    case 'workers_ai':
      return createWorkersAiEmbeddings(opts)
    case 'openai':
    case 'openai_compatible':
      return createOpenAiEmbeddings(opts)
    default:
      throw new AiError(
        'invalid_request',
        opts.provider,
        `${opts.provider} has no embeddings adapter`
      )
  }
}

// ---- Anthropic -----------------------------------------------------------------------------------

function toAnthropicContent(content: string | ContentBlock[]): Anthropic.MessageParam['content'] {
  if (typeof content === 'string') return content
  return content.map((block): Anthropic.ContentBlockParam => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text }
      case 'tool_use':
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} }
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: block.toolUseId,
          content: block.content,
          ...(block.isError ? { is_error: true } : {}),
        }
      default:
        throw new Error(`Unknown content block: ${JSON.stringify(block)}`)
    }
  })
}

function fromAnthropicContent(content: Anthropic.ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = []
  for (const block of content) {
    if (block.type === 'text') out.push({ type: 'text', text: block.text })
    else if (block.type === 'tool_use')
      out.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
    // thinking / redacted_thinking / server tool blocks are dropped from the transcript.
  }
  return out
}

function fromAnthropicUsage(usage: Anthropic.Usage | undefined): TokenUsage {
  const out: TokenUsage = {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
  }
  if (usage?.cache_read_input_tokens != null) out.cacheReadTokens = usage.cache_read_input_tokens
  if (usage?.cache_creation_input_tokens != null)
    out.cacheWriteTokens = usage.cache_creation_input_tokens
  return out
}

function fromAnthropicStop(reason: Anthropic.Message['stop_reason']): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'stop_sequence':
      return reason
    default:
      return 'unknown'
  }
}

function toAnthropicToolChoice(choice: ChatParams['toolChoice']): Anthropic.ToolChoice | undefined {
  if (!choice) return undefined
  switch (choice.type) {
    case 'auto':
      return { type: 'auto' }
    case 'any':
      return { type: 'any' }
    case 'none':
      return { type: 'none' }
    case 'tool':
      return { type: 'tool', name: choice.name }
  }
}

function anthropicBody(
  params: ChatParams,
  defaults: RequestDefaults | undefined
): Anthropic.MessageCreateParams {
  const cache = params.cache ?? true
  const messages: Anthropic.MessageParam[] = params.messages.map(m => ({
    role: m.role,
    content: toAnthropicContent(m.content),
  }))
  const body: Record<string, unknown> = {
    ...anthropicDefaults(defaults),
    model: params.model,
    max_tokens: params.maxTokens,
    messages: cache ? withRollingCacheBreakpoints(messages) : messages,
  }
  if (params.system !== undefined) body.system = cachedSystem(params.system, cache)
  if (params.tools?.length) {
    body.tools = params.tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }))
    const choice = toAnthropicToolChoice(params.toolChoice)
    if (choice) body.tool_choice = choice
  }
  if (params.temperature !== undefined) body.temperature = params.temperature
  return reconcileThinking(body) as unknown as Anthropic.MessageCreateParams
}

function fromAnthropicMessage(message: Anthropic.Message): ChatResult {
  return {
    content: fromAnthropicContent(message.content),
    stopReason: fromAnthropicStop(message.stop_reason),
    usage: fromAnthropicUsage(message.usage),
    model: message.model,
  }
}

function createAnthropicChatClient(opts: ChatClientOptions): ChatClient {
  const provider = opts.provider
  if (!opts.apiKey) throw new AiError('auth', provider, 'An API key is required')
  if (provider === 'anthropic_compatible' && !opts.baseUrl) {
    throw new AiError(
      'invalid_request',
      provider,
      'A base URL is required for an Anthropic-compatible provider'
    )
  }
  // `apiKey: null` stops the SDK reading a platform env var and sending both headers.
  const sdk =
    provider === 'anthropic'
      ? new Anthropic({
          apiKey: opts.apiKey,
          baseURL: opts.baseUrl || undefined,
          fetch: opts.fetch,
          maxRetries: 2,
        })
      : new Anthropic({
          apiKey: null,
          authToken: opts.apiKey,
          baseURL: opts.baseUrl as string,
          fetch: opts.fetch,
          maxRetries: 2,
        })

  return {
    provider,
    async complete(params) {
      try {
        const message = await sdk.messages.create(
          { ...anthropicBody(params, opts.defaults), stream: false },
          { signal: params.signal }
        )
        return fromAnthropicMessage(message)
      } catch (err) {
        throw normalizeAiError(err, provider)
      }
    },
    async *stream(params) {
      try {
        const stream = sdk.messages.stream(anthropicBody(params, opts.defaults), {
          signal: params.signal,
        })
        const pendingTools = new Map<number, { id: string; name: string; json: string }>()
        for await (const event of stream) {
          if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
            pendingTools.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              json: '',
            })
          } else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') yield { type: 'text', text: event.delta.text }
            else if (event.delta.type === 'input_json_delta') {
              const pending = pendingTools.get(event.index)
              if (pending) pending.json += event.delta.partial_json
            }
          } else if (event.type === 'content_block_stop') {
            const pending = pendingTools.get(event.index)
            if (pending) {
              pendingTools.delete(event.index)
              yield {
                type: 'tool_use',
                id: pending.id,
                name: pending.name,
                input: safeJson(pending.json),
              }
            }
          }
        }
        const result = fromAnthropicMessage(await stream.finalMessage())
        yield { type: 'usage', usage: result.usage }
        yield { type: 'end', result }
      } catch (err) {
        throw normalizeAiError(err, provider)
      }
    },
    async countTokens(params) {
      try {
        const body = anthropicBody({ ...params, maxTokens: 1 }, undefined)
        const { input_tokens } = await sdk.messages.countTokens({
          model: body.model,
          messages: body.messages,
          ...(body.system ? { system: body.system } : {}),
          ...(body.tools
            ? { tools: body.tools as Anthropic.MessageCountTokensParams['tools'] }
            : {}),
        })
        return input_tokens
      } catch (err) {
        throw normalizeAiError(err, provider)
      }
    },
  }
}

function safeJson(text: string): unknown {
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { _raw: text }
  }
}

// ---- OpenAI-compatible chat ------------------------------------------------------------------------

interface OpenAiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: OpenAiToolCall[]
  tool_call_id?: string
}

interface OpenAiUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

interface OpenAiChoice {
  index: number
  finish_reason: string | null
  message?: OpenAiMessage
  delta?: Partial<OpenAiMessage> & {
    tool_calls?: Array<
      Partial<OpenAiToolCall> & { index: number; function?: Partial<OpenAiToolCall['function']> }
    >
  }
}

interface OpenAiCompletion {
  model?: string
  choices: OpenAiChoice[]
  usage?: OpenAiUsage
}

function systemText(system: ChatParams['system']): string | undefined {
  if (system === undefined) return undefined
  if (typeof system === 'string') return system
  return system.volatile?.trim() ? `${system.stable}\n\n${system.volatile}` : system.stable
}

/** Our block-shaped transcript → OpenAI's flat message list (tool results become `role: tool` turns). */
function toOpenAiMessages(params: ChatParams): OpenAiMessage[] {
  const out: OpenAiMessage[] = []
  const system = systemText(params.system)
  if (system) out.push({ role: 'system', content: system })
  for (const m of params.messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
      continue
    }
    if (m.role === 'assistant') {
      const text = m.content
        .filter(b => b.type === 'text')
        .map(b => (b as { text: string }).text)
        .join('')
      const calls = m.content
        .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        .map<OpenAiToolCall>(b => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }))
      out.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      })
      continue
    }
    const texts: string[] = []
    for (const block of m.content) {
      if (block.type === 'text') texts.push(block.text)
      else if (block.type === 'tool_result')
        out.push({ role: 'tool', tool_call_id: block.toolUseId, content: block.content })
    }
    if (texts.length) out.push({ role: 'user', content: texts.join('\n') })
  }
  return out
}

function openAiBody(params: ChatParams, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    messages: toOpenAiMessages(params),
    max_tokens: params.maxTokens,
    stream,
  }
  if (stream) body.stream_options = { include_usage: true }
  if (params.temperature !== undefined) body.temperature = params.temperature
  if (params.tools?.length) {
    body.tools = params.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }))
    const choice = params.toolChoice
    if (choice?.type === 'tool')
      body.tool_choice = { type: 'function', function: { name: choice.name } }
    else if (choice?.type === 'any') body.tool_choice = 'required'
    else if (choice?.type === 'none') body.tool_choice = 'none'
    else if (choice) body.tool_choice = 'auto'
  }
  return body
}

function fromOpenAiUsage(usage: OpenAiUsage | undefined): TokenUsage {
  const out: TokenUsage = {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
  }
  const cached = usage?.prompt_tokens_details?.cached_tokens
  if (typeof cached === 'number') out.cacheReadTokens = cached
  return out
}

function fromOpenAiFinish(reason: string | null | undefined, hadTools: boolean): StopReason {
  if (reason === 'tool_calls' || (reason === 'stop' && hadTools)) return 'tool_use'
  if (reason === 'stop') return 'end_turn'
  if (reason === 'length') return 'max_tokens'
  return reason ? 'unknown' : 'end_turn'
}

function parseArguments(args: string): unknown {
  return safeJson(args)
}

class OpenAiHttpError extends Error {
  constructor(
    public readonly status: number,
    body: string
  ) {
    super(`${status} ${body}`)
    this.name = 'OpenAiHttpError'
  }
}

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  apiKey: string,
  body: unknown,
  signal?: AbortSignal
): Promise<Response> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok)
    throw new OpenAiHttpError(res.status, (await res.text().catch(() => '')).slice(0, 500))
  return res
}

/** Yield the `data:` payloads of an SSE body, stopping at `[DONE]`. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n')
        if (data === '[DONE]') return
        if (data) yield data
        boundary = buffer.indexOf('\n\n')
      }
    }
    const tail = buffer.trim()
    if (tail.startsWith('data:')) {
      const data = tail.slice(5).trim()
      if (data && data !== '[DONE]') yield data
    }
  } finally {
    reader.releaseLock()
  }
}

function createOpenAiChatClient(opts: ChatClientOptions): ChatClient {
  const provider = opts.provider
  if (!opts.apiKey) throw new AiError('auth', provider, 'An API key is required')
  const base = (opts.baseUrl || DEFAULT_BASE_URLS[provider] || '').replace(/\/+$/, '')
  if (!base)
    throw new AiError(
      'invalid_request',
      provider,
      'A base URL is required for an OpenAI-compatible provider'
    )
  const apiKey = opts.apiKey
  const fetchImpl = opts.fetch ?? fetch
  const url = `${base}/chat/completions`

  return {
    provider,
    async complete(params) {
      try {
        const res = await postJson(fetchImpl, url, apiKey, openAiBody(params, false), params.signal)
        const json = (await res.json()) as OpenAiCompletion
        const choice = json.choices?.[0]
        const content: ContentBlock[] = []
        if (choice?.message?.content) content.push({ type: 'text', text: choice.message.content })
        for (const call of choice?.message?.tool_calls ?? []) {
          content.push({
            type: 'tool_use',
            id: call.id,
            name: call.function.name,
            input: parseArguments(call.function.arguments),
          })
        }
        return {
          content,
          stopReason: fromOpenAiFinish(
            choice?.finish_reason,
            Boolean(choice?.message?.tool_calls?.length)
          ),
          usage: fromOpenAiUsage(json.usage),
          model: json.model ?? params.model,
        }
      } catch (err) {
        throw normalizeAiError(err, provider)
      }
    },
    async *stream(params) {
      try {
        const res = await postJson(fetchImpl, url, apiKey, openAiBody(params, true), params.signal)
        if (!res.body) throw new AiError('unavailable', provider, 'Empty response body')
        let text = ''
        let model = params.model
        let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
        let finish: string | null = null
        const calls = new Map<number, { id: string; name: string; args: string }>()
        for await (const data of sseData(res.body)) {
          const chunk = safeJson(data) as OpenAiCompletion & { error?: { message?: string } }
          if (chunk.error)
            throw new AiError('unknown', provider, chunk.error.message ?? 'Provider error')
          if (chunk.model) model = chunk.model
          if (chunk.usage) usage = fromOpenAiUsage(chunk.usage)
          const choice = chunk.choices?.[0]
          if (!choice) continue
          if (choice.finish_reason) finish = choice.finish_reason
          const delta = choice.delta
          if (delta?.content) {
            text += delta.content
            yield { type: 'text', text: delta.content }
          }
          for (const tc of delta?.tool_calls ?? []) {
            const entry = calls.get(tc.index) ?? { id: '', name: '', args: '' }
            if (tc.id) entry.id = tc.id
            if (tc.function?.name) entry.name = tc.function.name
            if (tc.function?.arguments) entry.args += tc.function.arguments
            calls.set(tc.index, entry)
          }
        }
        const content: ContentBlock[] = []
        if (text) content.push({ type: 'text', text })
        for (const call of [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c)) {
          const block: ContentBlock = {
            type: 'tool_use',
            id: call.id || crypto.randomUUID(),
            name: call.name,
            input: parseArguments(call.args),
          }
          content.push(block)
          yield block
        }
        const result: ChatResult = {
          content,
          stopReason: fromOpenAiFinish(finish, calls.size > 0),
          usage,
          model,
        }
        yield { type: 'usage', usage }
        yield { type: 'end', result }
      } catch (err) {
        throw normalizeAiError(err, provider)
      }
    },
  }
}

// ---- Embeddings ----------------------------------------------------------------------------------

function createOpenAiEmbeddings(opts: EmbeddingsClientOptions): EmbeddingsClient {
  const provider = opts.provider
  if (!opts.apiKey) throw new AiError('auth', provider, 'An API key is required')
  const base = (opts.baseUrl || DEFAULT_BASE_URLS[provider] || '').replace(/\/+$/, '')
  if (!base)
    throw new AiError(
      'invalid_request',
      provider,
      'A base URL is required for an OpenAI-compatible provider'
    )
  const apiKey = opts.apiKey
  const fetchImpl = opts.fetch ?? fetch
  return {
    provider,
    model: opts.model,
    dimension: EMBEDDING_DIM,
    async embed(texts) {
      if (texts.length === 0) return []
      try {
        const res = await postJson(fetchImpl, `${base}/embeddings`, apiKey, {
          model: opts.model,
          input: texts,
          dimensions: EMBEDDING_DIM,
        })
        const json = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> }
        return json.data.sort((a, b) => a.index - b.index).map(d => d.embedding)
      } catch (err) {
        throw normalizeAiError(err, provider)
      }
    },
  }
}

function createWorkersAiEmbeddings(opts: EmbeddingsClientOptions): EmbeddingsClient {
  const ai = opts.ai as WorkersAiBinding | undefined
  if (!ai) throw new AiError('unavailable', 'workers_ai', 'The AI binding is not configured')
  return {
    provider: 'workers_ai',
    model: opts.model,
    dimension: EMBEDDING_DIM,
    async embed(texts) {
      if (texts.length === 0) return []
      try {
        const out = (await ai.run(opts.model, { text: texts })) as { data?: number[][] }
        const data = out?.data
        if (!Array.isArray(data))
          throw new AiError('unknown', 'workers_ai', 'Unexpected Workers AI response shape')
        return data
      } catch (err) {
        throw normalizeAiError(err, 'workers_ai')
      }
    },
  }
}

/** Re-exported so consumers wiring messages by hand have one import. */
export type { ChatMessage }
