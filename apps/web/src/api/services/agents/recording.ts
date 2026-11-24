/**
 * What a run's steps did, as timeline rows, without the agent writing any of it.
 *
 * Two sources, both wired by the runtime (`runtime.ts`), so every agent gets them:
 *
 * - **Model calls** — {@link recordingChatClient} wraps `ctx.chat.client`: every `complete` or
 *   `stream` writes a `tool.start`/`tool.end` pair marked `kind: 'model'` (named for the model),
 *   carrying the forced tool if there was one, the usage, the stop reason, the tools the model
 *   called and the SHAPE of a forced answer (counts, never content). The run page shows it inside
 *   whichever stage was open; the AG-UI projection and the evals export skip it — a model call is
 *   not a tool the model called.
 * - **Tool-loop events** — {@link loopEventSink} is `ctx.journal.onEvent`: a `runToolLoop` that
 *   passes the journal and no `onEvent` of its own gets a row per text block, tool call and result
 *   (results through `summariseToolResult`). A loop with its own `onEvent` owns its rows.
 *
 * **Replay safety** comes from where the calls are, not from bookkeeping here: a turn the journal
 * serves and a `ctx.once` body that is served make no model call, so they write no row. A call
 * that IS made again on a retry is a real second call and gets its own row — the id names the
 * `execute` invocation, so it never pairs with an earlier one's start (a Workflows step retry keeps
 * `run.attempt`, so the attempt alone would collide); the timeline marks a row an earlier
 * invocation left open stopped when the retry is announced. `tool.end` is written in a `finally`, so a call that
 * throws (a cancel included) never leaves its row spinning.
 *
 * **Payloads are small by rule**: names, counts, token numbers, clipped tool inputs. Never a
 * prompt, a document, file bytes or a credential.
 */
import type { ToolLoopEvent } from '../ai/agent-loop'
import { AiError, describeAiError, redactSecrets } from '../ai/errors'
import type { ChatClient, ChatParams, ChatResult } from '../ai/types'
import type { AgentEvent } from './registry'
import { summariseToolResult } from './tools/event-summary'

/** A tool input kept on a `tool.start` row, as JSON characters. Past it: a clipped preview. */
export const RECORDED_INPUT_CHARS = 2_000

type Emit = (event: AgentEvent) => Promise<void>

/**
 * `ctx.chat.client`, recording each call as `model:<invocation>:<n>`. `invocation` is unique to
 * one `executeRun` (its round and a random tag); `n` counts its calls, in order.
 */
export function recordingChatClient(
  client: ChatClient,
  emit: Emit,
  options: { invocation: string }
): ChatClient {
  let calls = 0
  const open = async (params: ChatParams) => {
    calls += 1
    const toolCallId = `model:${options.invocation}:${calls}`
    const forced = params.toolChoice?.type === 'tool' ? params.toolChoice.name : undefined
    await emit({
      type: 'tool.start',
      data: {
        name: params.model,
        kind: 'model',
        toolCallId,
        input: {
          ...(forced ? { tool: forced } : {}),
          messages: params.messages.length,
          ...(params.tools?.length ? { tools: params.tools.length } : {}),
          maxTokens: params.maxTokens,
        },
      },
    })
    return { toolCallId, forced }
  }
  const close = (
    params: ChatParams,
    call: { toolCallId: string; forced?: string },
    outcome: { result: ChatResult } | { error: unknown }
  ) =>
    emit({
      type: 'tool.end',
      data: {
        name: params.model,
        kind: 'model',
        toolCallId: call.toolCallId,
        ...('error' in outcome
          ? { isError: true, result: { error: describeCallError(outcome.error) } }
          : { result: modelCallSummary(outcome.result, call.forced) }),
      },
    })

  return {
    provider: client.provider,
    countTokens: client.countTokens?.bind(client),
    async complete(params) {
      const call = await open(params)
      let outcome: { result: ChatResult } | { error: unknown } = {
        error: new Error('The call did not finish'),
      }
      try {
        const result = await client.complete(params)
        outcome = { result }
        return result
      } catch (error) {
        outcome = { error }
        throw error
      } finally {
        await close(params, call, outcome)
      }
    },
    async *stream(params) {
      const call = await open(params)
      let outcome: { result: ChatResult } | { error: unknown } = {
        // A consumer that stops reading early (`break`) ends the call without an `end` delta.
        error: new Error('The stream was not read to the end'),
      }
      try {
        for await (const delta of client.stream(params)) {
          if (delta.type === 'end') outcome = { result: delta.result }
          yield delta
        }
      } catch (error) {
        outcome = { error }
        throw error
      } finally {
        await close(params, call, outcome)
      }
    },
  }
}

/** The `tool.end` result of a model call: what came back, in numbers. */
export function modelCallSummary(result: ChatResult, forced?: string): Record<string, unknown> {
  const toolUses = result.content.filter(block => block.type === 'tool_use')
  const textChars = result.content.reduce(
    (sum, block) => sum + (block.type === 'text' ? block.text.length : 0),
    0
  )
  const answer = forced ? toolUses.find(block => block.name === forced) : undefined
  return {
    model: result.model,
    stopReason: result.stopReason,
    usage: result.usage,
    ...(toolUses.length ? { toolCalls: toolUses.map(block => block.name) } : {}),
    ...(textChars ? { textChars } : {}),
    ...(answer ? { answer: answerShape(answer.input) } : {}),
  }
}

/**
 * A forced answer's shape: each top-level field as a count — `"3 items"`, `"412 chars"` — with
 * numbers and booleans as they are. Enough to see that a step produced something sensible; never
 * the text itself.
 */
export function answerShape(value: unknown): unknown {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`
  if (typeof value === 'string') return `${value.length} chars`
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (typeof value !== 'object') return typeof value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, field]) => [
      key,
      field && typeof field === 'object' && !Array.isArray(field)
        ? `${Object.keys(field).length} fields`
        : answerShape(field),
    ])
  )
}

/** `ctx.journal.onEvent`: a tool loop's events as timeline rows. */
export function loopEventSink(emit: Emit): (event: ToolLoopEvent) => Promise<void> {
  return async event => {
    if (event.kind === 'text') {
      await emit({ type: 'text', data: { text: event.text } })
    } else if (event.kind === 'tool_call') {
      await emit({
        type: 'tool.start',
        data: { name: event.name, input: clipInput(event.input), toolCallId: event.toolUseId },
      })
    } else {
      await emit({
        type: 'tool.end',
        data: {
          name: event.name,
          toolCallId: event.toolUseId,
          isError: event.isError,
          result: summariseToolResult(event.name, event.resultText),
        },
      })
    }
  }
}

function clipInput(input: unknown): unknown {
  let json: string | undefined
  try {
    json = JSON.stringify(input)
  } catch {
    return '[unserialisable input]'
  }
  if (json === undefined || json.length <= RECORDED_INPUT_CHARS) return input
  return { preview: `${json.slice(0, RECORDED_INPUT_CHARS)}…`, truncated: true }
}

/** `describeRunError`'s rule (provider bodies redacted, never a stack), without importing the runtime. */
function describeCallError(err: unknown): string {
  if (err instanceof AiError) return describeAiError(err)
  return redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 500)
}
