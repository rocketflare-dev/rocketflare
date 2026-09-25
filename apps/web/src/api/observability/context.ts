/**
 * The ACTIVE span (D32), carried by `AsyncLocalStorage` so the code deep inside a unit of AI work —
 * a tool handler, `searchChunks`, an embeddings batch — can nest a span under whatever is running
 * without every signature between them growing a `trace` parameter. `withAgentTrace` makes its
 * handle active; `traceToolCall` makes each tool span active for its handler; anything with no
 * active span (a plain route, a test) runs untraced at the cost of one `getStore()`.
 *
 * `AsyncLocalStorage` is one of the `nodejs_compat` APIs `.claude/rules/cloudflare.md` allows, and
 * it is per request by construction — nothing here is module state shared across requests.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { embeddingAttributes, spanNameFor, toolAttributes } from './genai-attributes'
import type { SpanAttributes, SpanKind, TraceHandle } from './tracer'

const active = new AsyncLocalStorage<TraceHandle>()

export function activeSpan(): TraceHandle | undefined {
  return active.getStore()
}

export function withActiveSpan<T>(span: TraceHandle, fn: () => T): T {
  return active.run(span, fn)
}

export interface StepParams {
  name: string
  kind: SpanKind
  input?: unknown
  attributes?: SpanAttributes
}

export interface StepOutcome {
  output?: unknown
  attributes?: SpanAttributes
}

/**
 * Run `fn` as a child span of the active one (and make it active for anything `fn` traces in turn).
 * `describe` turns the result into the span's output — keep it small; it is exported and stored.
 */
export async function traceStep<T>(
  params: StepParams,
  fn: () => Promise<T>,
  describe?: (result: T) => StepOutcome
): Promise<T> {
  const parent = activeSpan()
  if (!parent) return fn()
  const span = parent.span({
    name: params.name,
    kind: params.kind,
    input: params.input,
    attributes: params.attributes,
  })
  try {
    const result = await withActiveSpan(span, fn)
    const outcome = describe?.(result)
    if (outcome?.attributes) span.setAttributes(outcome.attributes)
    span.end({ output: outcome?.output })
    return result
  } catch (error) {
    span.end({ error })
    throw error
  }
}

/**
 * One tool execution as `execute_tool <name>`, called from the kit's single tool runner so every
 * tool — the kit's, a plugin's, an agent's own — is traced in chat and in runs alike. A tool that
 * ANSWERS with an error (`isError`) is an error span; an interrupt raised from a handler is a park,
 * not a failure, and ends the span without an error status.
 */
export async function traceToolCall<T extends { text: string; isError: boolean }>(
  name: string,
  toolCallId: string | undefined,
  input: unknown,
  fn: () => Promise<T>
): Promise<T> {
  const parent = activeSpan()
  if (!parent) return fn()
  const span = parent.span({
    name: spanNameFor('tool', name),
    kind: 'tool',
    input,
    attributes: toolAttributes({ name, toolCallId }),
  })
  try {
    const outcome = await withActiveSpan(span, fn)
    span.end({ output: outcome.text, error: outcome.isError ? outcome.text : undefined })
    return outcome
  } catch (error) {
    if (error instanceof Error && error.name === 'InterruptRequested') {
      span.end({ output: 'interrupt requested — the run parked for a person' })
    } else {
      span.end({ error })
    }
    throw error
  }
}

/** One embeddings request as `embeddings <model>` under the active span. */
export function traceEmbed(
  embeddings: { model: string; provider: string },
  texts: string[],
  fn: () => Promise<number[][]>
): Promise<number[][]> {
  return traceStep(
    {
      name: spanNameFor('embedding', embeddings.model),
      kind: 'embedding',
      // The texts themselves are content, and can be a whole document's worth: count and a peek.
      input: { count: texts.length, first: texts[0]?.slice(0, 200) },
      attributes: embeddingAttributes({ ...embeddings, count: texts.length }),
    },
    fn,
    vectors => ({ output: { vectors: vectors.length, dimensions: vectors[0]?.length ?? 0 } })
  )
}
