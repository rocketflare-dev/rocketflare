/**
 * The demo seed's agent-run timelines, in the shapes the runtime itself records — so a seeded
 * run's timeline shows the steps its output claims ("Read 1 document in 3 model turns"), not a
 * bare Started → Finished.
 *
 * - `modelCall` is the pair `recordingChatClient` writes around every `ctx.chat.client` call
 *   (`src/api/services/agents/recording.ts`): `kind: 'model'`, the model as `name`, a
 *   `model:<invocation>:<n>` id on both rows, counts in, `modelCallSummary` out.
 * - `pastRunEvents` derives a further run from a fully recorded one: a success replays it at
 *   the new duration; a failure or cancel keeps what happened before it stopped, closes the call
 *   that was in flight as an error (as the recording client's `finally` does) and settles.
 *
 * Pure: no database, no clock — `tests/config/seed-run-events.test.ts` runs the output through the
 * real timeline model.
 */

export interface SeedRunEvent {
  type: string
  data: unknown
  offsetSeconds: number
}

export const seedEvent = (type: string, data: unknown, offsetSeconds: number): SeedRunEvent => ({
  type,
  data,
  offsetSeconds,
})

/** One recorded model call: `tool.start` at `from`, `tool.end` at `to`. */
export function modelCall(options: {
  model: string
  /** The call's number within the attempt — `model:<invocation>:<n>`. */
  n: number
  invocation?: string
  from: number
  to: number
  messages: number
  tools?: number
  /** The tool a forced call must answer with (`toolChoice`). */
  forced?: string
  maxTokens: number
  usage: { inputTokens: number; outputTokens: number }
  /** The tool calls the model answered with; none = a text answer. */
  toolCalls?: string[]
  textChars?: number
  /** The forced answer's shape (`answerShape`), when `forced` is set. */
  answer?: Record<string, unknown>
}): SeedRunEvent[] {
  const toolCallId = `model:${options.invocation ?? '0.seed'}:${options.n}`
  const toolCalls = options.toolCalls ?? []
  return [
    seedEvent(
      'tool.start',
      {
        name: options.model,
        kind: 'model',
        toolCallId,
        input: {
          ...(options.forced ? { tool: options.forced } : {}),
          messages: options.messages,
          ...(options.tools ? { tools: options.tools } : {}),
          maxTokens: options.maxTokens,
        },
      },
      options.from
    ),
    seedEvent(
      'tool.end',
      {
        name: options.model,
        kind: 'model',
        toolCallId,
        result: {
          model: options.model,
          stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
          usage: options.usage,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          ...(options.textChars ? { textChars: options.textChars } : {}),
          ...(options.answer ? { answer: options.answer } : {}),
        },
      },
      options.to
    ),
  ]
}

const isStatus = (e: SeedRunEvent) => e.type === 'status'

/**
 * A further run modelled on `base` (whose last event is its terminal `status`):
 *
 * - `succeeded`: every event of the base, its offsets scaled to `durationSeconds`
 * - `failed` / `cancelled`: what the base did before it stopped — no later than `durationSeconds`
 *   and never past the base's first half, so a failure never shows a finished answer — then every
 *   call still open is closed as an error, a failure writes its `error` row, and the status settles.
 */
export function pastRunEvents(
  base: readonly SeedRunEvent[],
  run: {
    status: 'succeeded' | 'failed' | 'cancelled'
    error?: string | null
    durationSeconds: number
  }
): SeedRunEvent[] {
  const baseSeconds = base.at(-1)?.offsetSeconds ?? 0
  if (run.status === 'succeeded') {
    const scale = baseSeconds > 0 ? run.durationSeconds / baseSeconds : 1
    return base.map(e => ({ ...e, offsetSeconds: Math.round(e.offsetSeconds * scale * 10) / 10 }))
  }
  const cut = Math.min(run.durationSeconds, baseSeconds / 2)
  const [first, ...rest] = base
  const kept: SeedRunEvent[] = first && isStatus(first) ? [first] : []
  for (const e of rest) if (!isStatus(e) && e.offsetSeconds < cut) kept.push(e)

  // A call that started and has no end in what was kept was in flight when the run stopped.
  const open = new Map<string, { name: string; kind?: unknown }>()
  for (const e of kept) {
    const data = e.data as { name?: string; toolCallId?: string; kind?: unknown }
    const id = data.toolCallId ?? data.name ?? ''
    if (e.type === 'tool.start') open.set(id, { name: data.name ?? 'tool', kind: data.kind })
    if (e.type === 'tool.end') open.delete(id)
  }
  const end = run.durationSeconds
  const closingAt = Math.max(end - 0.1, kept.at(-1)?.offsetSeconds ?? 0)
  const message =
    run.status === 'failed' ? (run.error ?? 'The run failed') : 'The run was cancelled'
  const closing = [...open].map(([toolCallId, call]) =>
    seedEvent(
      'tool.end',
      {
        name: call.name,
        toolCallId,
        ...(call.kind === 'model' ? { kind: 'model' } : {}),
        isError: true,
        result: { error: message },
      },
      closingAt
    )
  )
  return [
    ...kept,
    ...closing,
    ...(run.status === 'failed' ? [seedEvent('error', { message, willRetry: false }, end)] : []),
    seedEvent(
      'status',
      run.status === 'failed' ? { status: 'failed', error: message } : { status: 'cancelled' },
      end
    ),
  ]
}
