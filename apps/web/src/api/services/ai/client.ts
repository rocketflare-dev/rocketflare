/**
 * Provider adapters (D17) behind the `ChatClient` / `EmbeddingsClient` seam in `types.ts`.
 *   - `anthropic` / `anthropic_compatible` → `@anthropic-ai/sdk` (fetch-based, runs in Workers).
 *     Compatible vendors authenticate with `Authorization: Bearer` (the SDK's `authToken`), NOT
 *     `x-api-key` — passing the key as `apiKey` sends the wrong header and reads as a bad key.
 *   - `openai` / `openai_compatible` → a small fetch client for `/v1/chat/completions` (SSE) and
 *     `/v1/embeddings`. Base URLs include `/v1`.
 *   - `workers_ai` → `env.AI.run(model, …)`: `{ text }` for embeddings, `{ messages, tools, stream }`
 *     for chat (zero key; the binding proxies to the account, so every call is billed to it).
 *     Only the newer Workers AI models take `tool_choice` (`WORKERS_AI_TOOL_CHOICE_MODELS` in
 *     `providers.ts`, which is also the picker's list); for the rest a forced tool becomes a system
 *     instruction. Tool calls inside a stream are undocumented,
 *     so `stream()` with tools runs one non-streamed call and replays it as deltas.
 * Per-tenant request defaults (`service_tier`, `thinking`) are injected HERE, where the client is
 * built, so no call site can forget them; `reconcileThinking` keeps a thinking budget legal against
 * the request it lands in. `fetch` is injectable so tests drive the adapters without a network.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { TokenUsage } from '@rocketflare/shared/ai/chat'
import {
  type AiProvider,
  EMBEDDING_DIM,
  THINKING_ANSWER_HEADROOM,
} from '@rocketflare/shared/ai/config'
import { AiError, normalizeAiError } from './errors'
import { cachedSystem, withRollingCacheBreakpoints } from './kit'
import { DEFAULT_BASE_URLS, WORKERS_AI_TOOL_CHOICE_MODELS } from './providers'
import type {
  AiEnv,
  ChatClient,
  ChatDelta,
  ChatMessage,
  ChatParams,
  ChatResult,
  ContentBlock,
  EmbeddingsClient,
  RequestDefaults,
  StopReason,
  WorkersAiBinding,
} from './types'
import { textOf } from './types'

export type FetchLike = typeof fetch

export interface ChatClientOptions {
  provider: AiProvider
  apiKey?: string | null
  baseUrl?: string | null
  defaults?: RequestDefaults
  /** The `AI` binding, for `workers_ai`. */
  ai?: AiEnv['AI']
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: FetchLike
  /** `workers_ai` only: how long to wait for `env.AI.run` (it cannot be aborted). */
  timeoutMs?: number
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
    case 'workers_ai':
      return createWorkersAiChatClient(opts)
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

  // The kit sends `thinking: disabled` by default because some vendors' models (Fireworks' GLM/Kimi)
  // reason — and bill for it — unless told not to. Others reject the field outright: Fireworks maps
  // it to reasoning effort `none`, which gpt-oss answers with a 400. On that one refusal the client
  // retries without the field and remembers it for the rest of this client (one resolve, i.e. one
  // turn or run step), so only its first call pays for finding out.
  let omitDisabledThinking = false
  const bodyFor = (params: ChatParams): Anthropic.MessageCreateParams => {
    const body = anthropicBody(params, opts.defaults)
    if (!omitDisabledThinking || body.thinking?.type !== 'disabled') return body
    const { thinking: _off, ...rest } = body
    return rest as Anthropic.MessageCreateParams
  }
  const rejectsDisabledThinking = (err: unknown): boolean =>
    provider === 'anthropic_compatible' &&
    !omitDisabledThinking &&
    err instanceof Anthropic.APIError &&
    err.status === 400 &&
    /reasoning effort|thinking/i.test(err.message)

  /** One streamed request, raw SDK errors and all — `stream` decides whether to retry. */
  async function* streamOnce(params: ChatParams): AsyncIterable<ChatDelta> {
    const stream = sdk.messages.stream(bodyFor(params), { signal: params.signal })
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
  }

  return {
    provider,
    async complete(params) {
      const create = () =>
        sdk.messages.create({ ...bodyFor(params), stream: false }, { signal: params.signal })
      try {
        return fromAnthropicMessage(await create())
      } catch (err) {
        if (rejectsDisabledThinking(err)) {
          omitDisabledThinking = true
          try {
            return fromAnthropicMessage(await create())
          } catch (retryErr) {
            throw normalizeAiError(retryErr, provider)
          }
        }
        throw normalizeAiError(err, provider)
      }
    },
    async *stream(params) {
      let yielded = false
      try {
        for await (const delta of streamOnce(params)) {
          yielded = true
          yield delta
        }
      } catch (err) {
        // The refusal arrives before the first event, so a retry can never duplicate output.
        if (yielded || !rejectsDisabledThinking(err)) throw normalizeAiError(err, provider)
        omitDisabledThinking = true
        try {
          yield* streamOnce(params)
        } catch (retryErr) {
          throw normalizeAiError(retryErr, provider)
        }
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
        // Null is correct OpenAI for a pure tool-call turn; the Workers AI adapter coerces it.
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

/**
 * `TokenUsage.inputTokens` means UNCACHED input everywhere: that is what Anthropic reports
 * (`input_tokens` excludes both cache counters) and what `estimateCostMicrocents` prices at the
 * input rate. OpenAI counts the other way — `prompt_tokens` INCLUDES
 * `prompt_tokens_details.cached_tokens` — so the cached half is subtracted here, or it is billed
 * twice, at the full rate and again at the cache rate. Normalising in the adapter keeps the one
 * meaning in one place, rather than a per-provider branch inside pricing where nobody reading a
 * cost would think to look.
 */
function fromOpenAiUsage(usage: OpenAiUsage | undefined): TokenUsage {
  const prompt = usage?.prompt_tokens ?? 0
  const cached = usage?.prompt_tokens_details?.cached_tokens
  const out: TokenUsage = {
    inputTokens: typeof cached === 'number' ? Math.max(prompt - cached, 0) : prompt,
    outputTokens: usage?.completion_tokens ?? 0,
  }
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

// ---- Workers AI chat -----------------------------------------------------------------------------

/** A tool call as Workers AI models emit it — legacy `{ name, arguments }` or OpenAI-shaped. */
interface WorkersAiToolCall {
  id?: string
  name?: string
  arguments?: unknown
  type?: string
  function?: { name?: string | null; arguments?: unknown }
  /** Present on STREAMED deltas: which call a fragment belongs to (`ToolCallAssembler`). */
  index?: number
}

/**
 * Workers AI answers in TWO shapes and the model decides which. The older models
 * (`llama-3.3-70b-instruct-fp8-fast`) return `{ response, tool_calls }`; the newer ones — which are
 * also the ones that accept `tool_choice` — return the OpenAI chat-completions envelope,
 * `{ choices: [{ message | delta, finish_reason }] }`. Reading only the first shape is why a newer
 * model appears to answer with nothing at all.
 */
interface WorkersAiChoice {
  message?: { content?: string | null; tool_calls?: WorkersAiToolCall[] }
  delta?: { content?: string | null; tool_calls?: WorkersAiToolCall[] }
  finish_reason?: string | null
}

interface WorkersAiTextOutput {
  response?: string
  tool_calls?: WorkersAiToolCall[]
  usage?: OpenAiUsage
  choices?: WorkersAiChoice[]
}

/** Text, tool calls and finish reason from either shape — `message` when finished, `delta` mid-stream. */
function readWorkersAiPart(chunk: WorkersAiTextOutput): {
  text: string
  calls: WorkersAiToolCall[]
  finishReason?: string | null
} {
  const choice = chunk.choices?.[0]
  const part = choice?.message ?? choice?.delta
  const text = typeof chunk.response === 'string' ? chunk.response : (part?.content ?? '')
  return {
    text: text ?? '',
    calls: chunk.tool_calls ?? part?.tool_calls ?? [],
    finishReason: choice?.finish_reason,
  }
}

function workersAiStopReason(hasTools: boolean, finishReason?: string | null): StopReason {
  if (hasTools) return 'tool_use'
  if (finishReason === 'length') return 'max_tokens'
  return 'end_turn'
}

/**
 * Whether `stream()` may send tools to this model instead of replaying a non-streamed call.
 *
 * **No Workers AI model documents its stream shape** — every schema declares the SSE branch as
 * opaque `format: binary` — so this cannot be read off the catalog. It is the same list again
 * because every model on it was measured: driven through a real two-turn tool loop (call, tool
 * result, answer), each streams the tool call and then streams its answer as text. Re-measure when
 * adding one.
 *
 * A model OFF the list is an older one a stored config still names. Those replay a single
 * non-streamed call, which is what keeps them usable: `llama-3.3-70b-instruct-fp8-fast` asked a
 * knowledge question with tools streaming loops the same search to the turn cap and emits no text.
 */
export const workersAiStreamsTools = (model: string): boolean => workersAiSupportsToolChoice(model)

/**
 * Whether a forced tool can be SENT to this model as `tool_choice`, making it a real constraint
 * rather than a sentence in the prompt the model may ignore.
 *
 * The catalog is `WORKERS_AI_TOOL_CHOICE_MODELS` in `providers.ts`, deliberately the SAME list the
 * settings picker offers: a model somebody can choose is a model a forced tool can really
 * constrain, and two lists would be two things to keep in step. Those schemas declare OpenAI's
 * shape exactly (`'none' | 'auto' | 'required'`, or `{ type: 'function', function: { name } }`),
 * which is what `workersAiChatInputs` sends.
 *
 * Anything off it — an older model a stored config names — falls back to `forcedToolInstruction`
 * plus `recoverForcedToolCall`, which asks in the prompt and unwraps whatever prose JSON comes
 * back. That path can fail on a model that answers in plain prose.
 */
const TOOL_CHOICE_MODELS: ReadonlySet<string> = new Set(
  WORKERS_AI_TOOL_CHOICE_MODELS.map(model => model.toLowerCase())
)

export const workersAiSupportsToolChoice = (model: string): boolean =>
  TOOL_CHOICE_MODELS.has(model.trim().toLowerCase())

/** `tool_choice` in the OpenAI shape Workers AI declares, for a model that accepts it. */
function workersAiToolChoice(params: ChatParams): unknown | undefined {
  const choice = params.toolChoice
  if (!choice || !workersAiSupportsToolChoice(params.model)) return undefined
  if (choice.type === 'tool') return { type: 'function', function: { name: choice.name } }
  if (choice.type === 'any') return 'required'
  return undefined
}

/**
 * A forced tool as an INSTRUCTION, for models without `tool_choice` (see
 * {@link workersAiSupportsToolChoice}). Undefined when the model takes `tool_choice`, so the
 * constraint is never sent twice — once as a rule and once as a plea.
 */
export function forcedToolInstruction(params: ChatParams): string | undefined {
  const choice = params.toolChoice
  if (!choice || !params.tools?.length) return undefined
  if (workersAiSupportsToolChoice(params.model)) return undefined
  if (choice.type === 'tool')
    return `You must answer by calling the "${choice.name}" tool with its required arguments. Do not reply in plain text.`
  if (choice.type === 'any')
    return 'You must answer by calling one of the available tools. Do not reply in plain text.'
  return undefined
}

function appendSystem(system: ChatParams['system'], extra: string): ChatParams['system'] {
  if (system === undefined) return extra
  if (typeof system === 'string') return `${system}\n\n${extra}`
  return {
    stable: system.stable,
    volatile: system.volatile?.trim() ? `${system.volatile}\n\n${extra}` : extra,
  }
}

/**
 * Flatten an OpenAI-shaped transcript to the LOWEST common Workers AI schema: every message is
 * `{ role: 'system' | 'user' | 'assistant', content: <non-empty string> }` — no `tool_calls`, no
 * `role: 'tool'`, no null content. Model schemas differ per model on Workers AI (some accept the
 * OpenAI tool extras, some declare `content` as a plain string and reject the request with
 * `5006 … oneOf at '/' not met`), and a rejected transcript kills a run mid-loop. The tool call and
 * its result survive as text, which the model can still read and act on.
 */
export function flattenWorkersAiMessages(messages: OpenAiMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = []
  for (const message of messages) {
    const text = typeof message.content === 'string' ? message.content : ''
    if (message.role === 'tool') {
      out.push({ role: 'user', content: `Tool result:\n${text || '(empty)'}` })
      continue
    }
    const calls = (message.tool_calls ?? [])
      .map(c => `${c.function.name}(${c.function.arguments})`)
      .join('\n')
    const content = [text, calls && `Called: ${calls}`].filter(Boolean).join('\n\n')
    out.push({ role: message.role, content: content || '(no content)' })
  }
  return out
}

/** A payload the model's schema refused — retrying the same shape cannot help, flattening can. */
export function isWorkersAiSchemaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /5006|oneOf at |Type mismatch of /.test(message)
}

/**
 * The `env.AI.run` inputs for a chat call — OpenAI-shaped messages and tools, plus `tool_choice`
 * for the models that declare it.
 * `flatten` drops to the lowest common schema (see `flattenWorkersAiMessages`).
 */
export function workersAiChatInputs(
  params: ChatParams,
  stream: boolean,
  flatten = false
): Record<string, unknown> {
  const instruction = forcedToolInstruction(params)
  const system = instruction ? appendSystem(params.system, instruction) : params.system
  const messages = toOpenAiMessages({ ...params, system })
  const inputs: Record<string, unknown> = {
    messages: flatten
      ? flattenWorkersAiMessages(messages)
      : // Null content is legal OpenAI but not in every Workers AI model schema.
        messages.map(m => (m.content === null ? { ...m, content: '' } : m)),
    max_tokens: params.maxTokens,
    stream,
  }
  if (params.temperature !== undefined) inputs.temperature = params.temperature
  if (params.tools?.length && params.toolChoice?.type !== 'none') {
    inputs.tools = params.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }))
    // Only a FORCING choice is sent: `auto` is the model's own default, and every extra field is
    // one more thing a per-model schema could refuse mid-run.
    const choice = workersAiToolChoice(params)
    if (choice !== undefined) inputs.tool_choice = choice
  }
  return inputs
}

/**
 * Reassemble tool calls that arrive in PIECES across stream frames — the OpenAI streaming contract,
 * which most Workers AI models follow: the first frame carries
 * `{ index, id, function: { name, arguments: '' } }`, later frames only
 * `{ index, function: { arguments: '<fragment>' } }` with `id` and `name` null. **`index` is the
 * identity**, not arrival order, so parallel calls interleave safely; concatenating each index's
 * fragments rebuilds its JSON.
 *
 * Every streamed call goes through here, because a call delivered complete in one frame
 * (`glm-4.7-flash`) is just the one-fragment case. Reading a frame as a whole call instead would
 * emit one `tool_use` per fragment, each with unparseable arguments.
 */
export class ToolCallAssembler {
  private readonly byIndex = new Map<number, { id: string; name: string; args: string }>()

  add(deltas: readonly WorkersAiToolCall[]): void {
    for (const delta of deltas) {
      const key = typeof delta.index === 'number' ? delta.index : this.byIndex.size
      const call = this.byIndex.get(key) ?? { id: '', name: '', args: '' }
      if (delta.id) call.id = delta.id
      const name = delta.function?.name ?? delta.name
      if (name) call.name = name
      const args = delta.function?.arguments ?? delta.arguments
      // A string is a fragment and appends; an object is a whole value and replaces (some models
      // send the arguments pre-parsed, and concatenating `[object Object]` would lose them).
      if (typeof args === 'string') call.args += args
      else if (args !== undefined && args !== null) call.args = JSON.stringify(args)
      this.byIndex.set(key, call)
    }
  }

  /** The assembled calls, in index order, in the shape `fromWorkersAiToolCalls` reads. */
  done(): WorkersAiToolCall[] {
    return [...this.byIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({ id: call.id, name: call.name, arguments: call.args }))
  }
}

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>

function fromWorkersAiToolCalls(calls: WorkersAiToolCall[] | undefined): ToolUseBlock[] {
  const out: ToolUseBlock[] = []
  for (const call of calls ?? []) {
    const name = call.function?.name ?? call.name
    if (!name) continue
    const args = call.function?.arguments ?? call.arguments
    out.push({
      type: 'tool_use',
      id: call.id || crypto.randomUUID(),
      name,
      input: typeof args === 'string' ? parseArguments(args) : (args ?? {}),
    })
  }
  return out
}

function fromWorkersAiOutput(out: unknown, model: string): ChatResult {
  if (typeof out === 'string') {
    return { content: [{ type: 'text', text: out }], stopReason: 'end_turn', usage: ZERO, model }
  }
  const json = (out ?? {}) as WorkersAiTextOutput
  const part = readWorkersAiPart(json)
  const content: ContentBlock[] = []
  if (part.text) content.push({ type: 'text', text: part.text })
  const tools = fromWorkersAiToolCalls(part.calls)
  content.push(...tools)
  return {
    content,
    stopReason: workersAiStopReason(tools.length > 0, part.finishReason),
    usage: fromOpenAiUsage(json.usage),
    model,
  }
}

const ZERO: TokenUsage = { inputTokens: 0, outputTokens: 0 }

/** The tool a forced choice names — `any` counts only when there is exactly one tool to pick. */
function forcedToolName(params: ChatParams): string | undefined {
  const choice = params.toolChoice
  if (!choice || !params.tools?.length) return undefined
  if (choice.type === 'tool') return choice.name
  if (choice.type === 'any' && params.tools.length === 1) return params.tools[0]?.name
  return undefined
}

/** The first JSON object in a text (a ```json fence or bare), or undefined. */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1] ?? text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    const value: unknown = JSON.parse(candidate.slice(start, end + 1))
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Without `tool_choice`, a Workers AI model asked to call a tool sometimes writes the arguments as a
 * JSON object in prose instead (Mistral Small does this for short inputs). When ONE tool was forced
 * and the reply has no call but does carry a JSON object, treat it as that call — a `{ name,
 * arguments }` object naming the tool is unwrapped, anything else is the input itself.
 */
/** Keys a model puts its tool ARGUMENTS under when it writes the call out as prose JSON. */
const ARGUMENT_KEYS = ['arguments', 'parameters', 'input', 'args'] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * Strip the call envelope a model wrapped its arguments in, or return the object unchanged when it
 * IS the arguments. Observed in the wild from Llama 3.3 70B on Workers AI:
 * `{"type":"function","name":"submit_summary","parameters":{…}}` — the right content, one layer
 * down. `arguments` also arrives as a JSON string (the OpenAI wire shape), and some models nest the
 * whole thing under `function`.
 *
 * The guard matters: a tool whose OWN schema has a `parameters` field must not be unwrapped, so an
 * envelope is only believed when it also names the tool or declares itself a function call.
 */
function unwrapToolArguments(
  object: Record<string, unknown>,
  name: string
): Record<string, unknown> {
  const inner = isRecord(object.function) ? object.function : object
  const isEnvelope = inner.name === name || inner.type === 'function' || isRecord(object.function)
  if (!isEnvelope) return object
  for (const key of ARGUMENT_KEYS) {
    const value = inner[key]
    if (isRecord(value)) return value
    if (typeof value === 'string') {
      try {
        const parsed: unknown = JSON.parse(value)
        if (isRecord(parsed)) return parsed
      } catch {
        // Not JSON after all — keep looking, then fall through to the object as-is.
      }
    }
  }
  return object
}

export function recoverForcedToolCall(params: ChatParams, result: ChatResult): ChatResult {
  const name = forcedToolName(params)
  if (!name || result.content.some(b => b.type === 'tool_use')) return result
  const text = textOf(result.content)
  const object = extractJsonObject(text)
  if (!object) return result
  return {
    ...result,
    content: [
      { type: 'tool_use', id: crypto.randomUUID(), name, input: unwrapToolArguments(object, name) },
    ],
    stopReason: 'tool_use',
  }
}

/**
 * How long a single `env.AI.run` chat call may take. `AiOptions` carries no `signal`, so a Workers
 * AI call cannot be aborted — an unanswered one would otherwise hold a Workflow step until its
 * 10-minute timeout with nothing to show, which reads to a person as "the agent is stuck". Waiting
 * stops here instead: the call becomes an `unavailable` `AiError`, which the agent runtime already
 * treats as retryable, so the step retries and then fails with a message.
 */
export const WORKERS_AI_TIMEOUT_MS = 120_000

/** Resolve `promise`, or reject once `timeoutMs` passes / `signal` aborts. The call itself runs on. */
export async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AiError(
                'unavailable',
                'workers_ai',
                `Workers AI did not answer within ${Math.round(timeoutMs / 1000)}s`
              )
            ),
          timeoutMs
        )
        if (signal) {
          onAbort = () =>
            reject(new AiError('unavailable', 'workers_ai', 'The request was cancelled'))
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

function createWorkersAiChatClient(opts: ChatClientOptions): ChatClient {
  const ai = opts.ai as WorkersAiBinding | undefined
  if (!ai) throw new AiError('unavailable', 'workers_ai', 'The AI binding is not configured')
  const timeoutMs = opts.timeoutMs ?? WORKERS_AI_TIMEOUT_MS

  const complete = async (params: ChatParams): Promise<ChatResult> => {
    const call = async (flatten: boolean) =>
      withDeadline(
        ai.run(params.model, workersAiChatInputs(params, false, flatten)),
        timeoutMs,
        params.signal
      )
    try {
      let out: unknown
      try {
        out = await call(false)
      } catch (err) {
        // The model's schema refused the transcript (tool extras, null content). Every model on
        // Workers AI takes the flattened shape, so retry once there rather than failing the run.
        if (!isWorkersAiSchemaError(err)) throw err
        out = await call(true)
      }
      return recoverForcedToolCall(params, fromWorkersAiOutput(out, params.model))
    } catch (err) {
      throw normalizeAiError(err, 'workers_ai')
    }
  }

  /** Emit a finished result as the deltas a consumer would have seen from a real stream. */
  async function* replay(result: ChatResult): AsyncGenerator<ChatDelta> {
    for (const block of result.content) {
      if (block.type === 'text') yield { type: 'text', text: block.text }
      else if (block.type === 'tool_use') yield block
    }
    yield { type: 'usage', usage: result.usage }
    yield { type: 'end', result }
  }

  return {
    provider: 'workers_ai',
    complete,
    async *stream(params) {
      // Streaming WITH tools is per-model behaviour — see `workersAiStreamsTools`. For anything
      // unverified, one non-streamed call, replayed as deltas.
      if (
        params.tools?.length &&
        params.toolChoice?.type !== 'none' &&
        !workersAiStreamsTools(params.model)
      ) {
        yield* replay(await complete(params))
        return
      }
      let body: unknown
      try {
        try {
          body = await ai.run(params.model, workersAiChatInputs(params, true))
        } catch (err) {
          // Same schema fallback as `complete` — a chat transcript can carry tool turns too.
          if (!isWorkersAiSchemaError(err)) throw err
          body = await ai.run(params.model, workersAiChatInputs(params, true, true))
        }
      } catch (err) {
        throw normalizeAiError(err, 'workers_ai')
      }
      if (!(body instanceof ReadableStream)) {
        yield* replay(fromWorkersAiOutput(body, params.model))
        return
      }
      let text = ''
      let usage: TokenUsage = ZERO
      const calls = new ToolCallAssembler()
      try {
        for await (const data of sseData(body)) {
          if (params.signal?.aborted) break
          const chunk = safeJson(data) as WorkersAiTextOutput
          const part = readWorkersAiPart(chunk)
          if (part.text) {
            text += part.text
            yield { type: 'text', text: part.text }
          }
          if (chunk.usage) usage = fromOpenAiUsage(chunk.usage)
          if (part.calls.length) calls.add(part.calls)
        }
      } catch (err) {
        throw normalizeAiError(err, 'workers_ai')
      }
      if (params.signal?.aborted) await body.cancel().catch(() => undefined)
      const content: ContentBlock[] = []
      if (text) content.push({ type: 'text', text })
      const tools = fromWorkersAiToolCalls(calls.done())
      for (const block of tools) {
        content.push(block)
        yield block
      }
      const result: ChatResult = {
        content,
        stopReason: tools.length ? 'tool_use' : 'end_turn',
        usage,
        model: params.model,
      }
      yield { type: 'usage', usage }
      yield { type: 'end', result }
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
