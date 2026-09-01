/**
 * The two tracing seams every LLM entry point uses (D16): `withAgentTrace(name, ctx, fn)` brackets
 * one agent run / chat turn in a trace, and `traceChatClient(client, trace, meta)` wraps a
 * `ChatClient` so every `complete`/`stream` emits one `generation` with usage. Both are no-ops on
 * the `noopTracer`, so code paths are identical with and without Langfuse keys. `tracerFor(cfg)`
 * is the switch: presence of both keys enables the fetch batcher.
 */
import type { AppConfig } from '../../config'
import type { ChatClient, ChatParams, ChatResult } from '../services/ai/types'
import { createLangfuseTracer } from './langfuse-fetch'
import { noopTracer, type TraceHandle, type TraceParams, type Tracer } from './tracer'

export function isTracingEnabled(cfg: AppConfig): boolean {
  return Boolean(cfg.LANGFUSE_PUBLIC_KEY && cfg.LANGFUSE_SECRET_KEY)
}

/** A per-request tracer: the Langfuse batcher when both keys are present, else the no-op. */
export function tracerFor(
  cfg: AppConfig,
  options: {
    fetch?: typeof fetch
    logger?: Parameters<typeof createLangfuseTracer>[0]['logger']
  } = {}
): Tracer {
  if (!cfg.LANGFUSE_PUBLIC_KEY || !cfg.LANGFUSE_SECRET_KEY) return noopTracer
  return createLangfuseTracer({
    publicKey: cfg.LANGFUSE_PUBLIC_KEY,
    secretKey: cfg.LANGFUSE_SECRET_KEY,
    baseUrl: cfg.LANGFUSE_BASE_URL,
    environment: cfg.LANGFUSE_TRACING_ENVIRONMENT ?? cfg.APP_ENV,
    fetch: options.fetch,
    logger: options.logger,
  })
}

export interface AgentTraceContext extends Omit<TraceParams, 'name'> {
  tracer: Tracer
}

/**
 * Run `fn` inside one trace named `name`; the handle is passed so the body can wrap its client
 * with `traceChatClient`. Output is recorded on success, the error on failure (then rethrown).
 */
export async function withAgentTrace<T>(
  name: string,
  ctx: AgentTraceContext,
  fn: (trace: TraceHandle) => Promise<T>
): Promise<T> {
  const { tracer, ...params } = ctx
  const trace = tracer.startTrace({ name, ...params })
  try {
    const output = await fn(trace)
    trace.end({ output })
    return output
  } catch (error) {
    trace.end({ error })
    throw error
  }
}

export interface TraceClientMeta {
  provider: string
  /** Generation name; defaults to `<provider>.messages`. */
  name?: string
}

function generationInput(params: ChatParams) {
  return { system: params.system, messages: params.messages, tools: params.tools?.map(t => t.name) }
}

/** Wrap a client so each call emits a `generation` on `trace`. Returns the client unchanged when tracing is off. */
export function traceChatClient(
  client: ChatClient,
  trace: TraceHandle,
  meta: TraceClientMeta,
  tracer?: Tracer
): ChatClient {
  if (tracer && !tracer.enabled) return client
  const name = meta.name ?? `${meta.provider}.messages`
  const record = (params: ChatParams, startTime: Date, result?: ChatResult, error?: unknown) => {
    trace.generation({
      name,
      model: result?.model ?? params.model,
      provider: meta.provider,
      input: generationInput(params),
      output: result?.content,
      usage: result?.usage,
      startTime,
      endTime: new Date(),
      level: error ? 'ERROR' : 'DEFAULT',
      statusMessage: error ? (error instanceof Error ? error.message : String(error)) : undefined,
      metadata: { maxTokens: params.maxTokens, stopReason: result?.stopReason },
    })
  }
  return {
    provider: client.provider,
    countTokens: client.countTokens?.bind(client),
    async complete(params) {
      const startTime = new Date()
      try {
        const result = await client.complete(params)
        record(params, startTime, result)
        return result
      } catch (err) {
        record(params, startTime, undefined, err)
        throw err
      }
    },
    async *stream(params) {
      const startTime = new Date()
      let result: ChatResult | undefined
      try {
        for await (const delta of client.stream(params)) {
          if (delta.type === 'end') result = delta.result
          yield delta
        }
        record(params, startTime, result)
      } catch (err) {
        record(params, startTime, result, err)
        throw err
      }
    },
  }
}
