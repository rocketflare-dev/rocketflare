/**
 * Turning what a target DID into a transcript (D33) — pure, so it is unit-tested without a model.
 *
 * A chat turn arrives as the AG-UI events `streamChatTurn` emitted; an agent run as its
 * `agent_run_events` rows. Both become the same shape: the output, the tool calls (name, arguments,
 * result), the documents the knowledge tools retrieved, and vitest-evals transcript events for its
 * reporter and report UI. `retrieved` is what a faithfulness judge grades the answer against, so it
 * is read from the tool RESULTS, never from the dataset's `context` — the model can only be faithful
 * to what it was actually shown.
 */
import type { KitAguiEvent } from '@rocketflare/shared/ai/agui'
import type { EvalContextDoc } from '@rocketflare/shared/ai/evals'
import type { JsonValue, TranscriptEvent } from 'vitest-evals'
import { contextFromSearchResult } from '@/api/services/evals'

const SEARCH_TOOL = 'search_knowledge'

export interface TranscriptToolCall {
  id: string
  name: string
  arguments: Record<string, JsonValue>
  result?: string
  isError?: boolean
}

export interface Transcript<TOutput = string> {
  output: TOutput
  toolCalls: TranscriptToolCall[]
  retrieved: EvalContextDoc[]
  events: TranscriptEvent[]
  provider?: string
  model?: string
  /** Set when the run failed: the error it reported. */
  error?: string
}

function asArgs(value: unknown): Record<string, JsonValue> {
  if (typeof value === 'string') {
    try {
      return asArgs(JSON.parse(value))
    } catch {
      return { raw: value }
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>)
    : {}
}

function resultText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function dedupe(docs: EvalContextDoc[]): EvalContextDoc[] {
  const seen = new Map<string, EvalContextDoc>()
  for (const doc of docs) {
    const prior = seen.get(doc.title)
    if (!prior) seen.set(doc.title, doc)
    else if (!prior.text.includes(doc.text)) {
      seen.set(doc.title, { title: doc.title, text: `${prior.text}\n\n${doc.text}` })
    }
  }
  return [...seen.values()]
}

/** A chat turn's AG-UI stream → transcript. `question` is the user turn that started it. */
export function transcriptFromAgui(events: KitAguiEvent[], question: string): Transcript {
  let text = ''
  let provider: string | undefined
  let model: string | undefined
  let error: string | undefined
  const calls = new Map<string, TranscriptToolCall>()
  const out: TranscriptEvent[] = [{ type: 'message', role: 'user', content: question }]
  for (const event of events) {
    switch (event.type) {
      case 'TEXT_MESSAGE_CONTENT':
        text += event.delta
        break
      case 'TOOL_CALL_START':
        calls.set(event.toolCallId, {
          id: event.toolCallId,
          name: event.toolCallName,
          arguments: {},
        })
        break
      case 'TOOL_CALL_ARGS': {
        const call = calls.get(event.toolCallId)
        if (call) call.arguments = asArgs(event.delta)
        break
      }
      case 'TOOL_CALL_RESULT': {
        const call = calls.get(event.toolCallId)
        if (!call) break
        call.result = event.content
        out.push({ type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments })
        out.push({
          type: 'tool_result',
          toolCallId: call.id,
          name: call.name,
          content: call.result,
        })
        break
      }
      case 'CUSTOM':
        if (event.name === 'kit.chat.ids') {
          const ids = event.value as { provider?: string; model?: string }
          provider = ids.provider
          model = ids.model
        }
        break
      case 'RUN_ERROR':
        error = event.message
        break
      default:
        break
    }
  }
  out.push({ type: 'message', role: 'assistant', content: text })
  const toolCalls = [...calls.values()]
  return {
    output: text,
    toolCalls,
    retrieved: dedupe(
      toolCalls.filter(c => c.name === SEARCH_TOOL).flatMap(c => contextFromSearchResult(c.result))
    ),
    events: out,
    provider,
    model,
    ...(error ? { error } : {}),
  }
}

export interface RunEventRow {
  type: string
  data: unknown
}

/** An agent run's durable events + its settled output → transcript. */
export function transcriptFromRunEvents(
  rows: readonly RunEventRow[],
  input: unknown,
  output: JsonValue | undefined,
  error?: string | null
): Transcript<JsonValue | undefined> {
  const out: TranscriptEvent[] = [
    { type: 'message', role: 'user', content: JSON.parse(JSON.stringify(input ?? null)) },
  ]
  const toolCalls: TranscriptToolCall[] = []
  const open = new Map<string, TranscriptToolCall>()
  rows.forEach((row, index) => {
    const data = (row.data ?? {}) as {
      name?: string
      input?: unknown
      result?: unknown
      isError?: boolean
      toolCallId?: string
    }
    if (row.type === 'tool.start' && data.name) {
      const call: TranscriptToolCall = {
        id: data.toolCallId ?? `call_${index}`,
        name: data.name,
        arguments: asArgs(data.input),
      }
      toolCalls.push(call)
      open.set(data.toolCallId ?? data.name, call)
      out.push({ type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments })
    } else if (row.type === 'tool.end' && data.name) {
      const call = open.get(data.toolCallId ?? data.name)
      if (call) {
        call.result = resultText(data.result)
        call.isError = data.isError
        open.delete(data.toolCallId ?? data.name)
        out.push({
          type: 'tool_result',
          toolCallId: call.id,
          name: call.name,
          content: call.result,
          ...(data.isError ? { error: { message: call.result ?? 'tool error' } } : {}),
        })
      }
    }
  })
  out.push({ type: 'message', role: 'assistant', content: output ?? null })
  return {
    output,
    toolCalls,
    retrieved: dedupe(
      toolCalls.filter(c => c.name === SEARCH_TOOL).flatMap(c => contextFromSearchResult(c.result))
    ),
    events: out,
    ...(error ? { error } : {}),
  }
}
