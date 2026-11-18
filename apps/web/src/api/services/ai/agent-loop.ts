/**
 * The agent loop — "how to call the client": prompt-cache breakpoint policy (`cachedSystem`,
 * `withRollingCacheBreakpoints`), forced structured output (`callStructuredTool`), the agentic
 * tool loop (`runToolLoop`, the agent runtime's engine) and the streaming conversational loop
 * (`runStreamingChat`, the chat route's engine). Everything is written against `ChatClient`, so a
 * fake client drives it in tests and every provider adapter benefits from the same policy.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type { AgentPolicy } from '@rocketflare/shared/ai/agents'
import { type TokenUsage, tokenUsageSchema } from '@rocketflare/shared/ai/chat'
import { aiProviderSchema } from '@rocketflare/shared/ai/config'
import type { AgentInterruptSpec, JsonSchema } from '@rocketflare/shared/ai/interrupts'
import { type ZodType, z } from 'zod'
import { traceToolCall } from '../../observability/context'
import { hashToken } from '../../utils/core/hash'
import { stableStringify } from '../../utils/core/stable-stringify'
import { AiError } from './errors'
import {
  addUsage,
  type ChatClient,
  type ChatMessage,
  type ContentBlock,
  type StopReason,
  type SystemPrompt,
  type ToolDefinition,
  textOf,
  toolUsesOf,
  ZERO_USAGE,
} from './types'

// ---- Prompt caching ------------------------------------------------------------------------
//
// Anthropic's budget is 4 breakpoints; this spends at most 3 — one on system (which also covers
// `tools`, since tools precede system in the cache hierarchy) and two rolling on the conversation.

/**
 * Render a {@link SystemPrompt} as Anthropic text blocks, closing the stable prefix with a
 * `cache_control` breakpoint (`cache: false` emits the same shape without it — single-shot calls).
 * Anthropic silently ignores a breakpoint whose prefix is under the minimum cacheable size; a
 * small system prompt therefore looks like a no-op until the conversation is inside the prefix.
 */
export function cachedSystem(system: SystemPrompt, cache = true): Anthropic.TextBlockParam[] {
  const stable = typeof system === 'string' ? system : system.stable
  const volatile = typeof system === 'string' ? undefined : system.volatile
  const head: Anthropic.TextBlockParam = { type: 'text', text: stable }
  if (cache) head.cache_control = { type: 'ephemeral' }
  return volatile?.trim() ? [head, { type: 'text', text: volatile }] : [head]
}

/** Block kinds that accept `cache_control` (thinking blocks do not). */
const CACHEABLE_BLOCK_TYPES = new Set(['text', 'image', 'tool_use', 'tool_result', 'document'])

function withBreakpoint(
  content: Anthropic.MessageParam['content']
): Anthropic.MessageParam['content'] {
  if (typeof content === 'string') {
    if (!content) return content
    return [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }]
  }
  const last = content[content.length - 1]
  if (!last || !CACHEABLE_BLOCK_TYPES.has(last.type)) return content
  const blocks = [...content]
  blocks[blocks.length - 1] = {
    ...last,
    cache_control: { type: 'ephemeral' },
  } as Anthropic.ContentBlockParam
  return blocks
}

/**
 * Mark the conversation tail (last two messages) so the NEXT request reads an exact cached prefix.
 * In a chat the transcript IS the prefix; without this every turn re-sends it at full price.
 * Returns a copy; unmarked messages keep their string content.
 */
export function withRollingCacheBreakpoints(
  messages: Anthropic.MessageParam[]
): Anthropic.MessageParam[] {
  const marked = [...messages]
  for (const index of [marked.length - 1, marked.length - 2]) {
    if (index < 0) continue
    const message = marked[index]
    if (message && message.role !== 'system') {
      marked[index] = { ...message, content: withBreakpoint(message.content) }
    }
  }
  return marked
}

// ---- Tools ---------------------------------------------------------------------------------

/** JSON as the database stores it, with keys in a fixed order: what makes two inputs comparable. */
const canonicalJson = (value: unknown) => stableStringify(JSON.parse(JSON.stringify(value ?? null)))

/** A tool the model may call. `handler` runs it; a tool WITHOUT a handler is terminal (its input is the answer). */
export interface Tool<Input = unknown> {
  name: string
  description: string
  /** zod schema for the input — validated before `handler` runs and rendered to JSON Schema for the model. */
  schema: ZodType<Input>
  /**
   * Method syntax on purpose: bivariant params let a `Tool<{ q: string }>` sit in a `Tool[]`.
   * `call` names the model's call — `idempotencyKey` is what a {@link Tool.durable} handler hands
   * the system it writes to, so a re-run after a crash is recognised there as the same request.
   */
  handler?(input: Input, call?: ToolCallInfo): Promise<string>
  /**
   * The handler changes something outside the run — sends, writes, charges. A loop with a
   * {@link RunToolLoopOptions.journal} records `started` before such a handler runs, and a retry
   * that finds `started` with no result does NOT run it again: the call settles as an "unknown
   * outcome" error the model sees, so it can check before repeating it. Leave it unset for a read
   * (`search_knowledge`): an unrecorded read simply runs again.
   */
  sideEffects?: boolean
  /**
   * The handler is safe to run again with the same {@link ToolCallInfo.idempotencyKey} — the
   * system it writes to deduplicates on it. A `sideEffects` tool marked `durable` is re-run after
   * a crash instead of settling as an unknown outcome.
   */
  durable?: boolean
  /**
   * Gate this call on a person: the loop stops, asks, and runs the handler only on a
   * `resolved` answer. Enforced by {@link runToolLoop}, never by the handler — a handler that
   * checks for itself is a handler that has already run. {@link runStreamingChat} cannot ask, so
   * chat never offers or runs a tool with a gate.
   */
  requiresApproval?: boolean
  /**
   * Gate only the calls that matter (`input => input.recipients.length > 10`), overriding
   * {@link Tool.requiresApproval}. The input has ALREADY passed `schema`, so arguments the tool
   * would reject anyway never become a question somebody has to read.
   *
   * Method syntax, like `handler`, and for the same reason: a function in PROPERTY position is
   * contravariant in `Input` under `strictFunctionTypes`, and a `Tool<{ to: string }>` has to be
   * able to sit in a `Tool[]`. That is also why there is a predicate member beside a boolean one
   * rather than a `boolean | ((input) => boolean)` union, which cannot be written bivariantly.
   */
  requiresApprovalWhen?(input: Input): boolean
  /**
   * The question a person is asked. Defaults to a sentence naming the tool; it does not need to
   * repeat the arguments, because the ask carries them (`spec.tool.input`) and the panel shows them.
   */
  approvalMessage?: string
  /** May the approver change the arguments before approving? The route re-validates the edit. */
  allowEdits?: boolean
  /** What a rejection does. Defaults to `INTERRUPT_REJECTION.approval` (`cancel_run`). */
  onReject?: 'cancel_run' | 'tell_model'
}

/** What a handler is told about the call it is answering. */
export interface ToolCallInfo {
  /** The model's id for this call; absent only when a handler is run outside a loop. */
  toolCallId?: string
  /**
   * Stable across every attempt of the run — the same call re-run after a crash carries the same
   * key. The model's call id today (the journal is what keeps it stable across a retry).
   */
  idempotencyKey?: string
}

/**
 * JSON Schema (draft-07, `$schema` stripped) for a tool input.
 *
 * The return type is the shared {@link JsonSchema} — the SAME contract `Interrupt.responseSchema`
 * and `agentInfoSchema.inputJsonSchema` carry — so a converted schema can be put on the wire
 * without a cast. Both are `Record<string, unknown>`; naming it says which one it is.
 */
export function toolInputSchema(schema: ZodType): JsonSchema {
  const { $schema: _drop, ...json } = z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>
  return json
}

export function toToolDefinition(tool: Tool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: toolInputSchema(tool.schema),
  }
}

// ---- Interrupts: the human-in-the-loop seam -------------------------------------

/**
 * One question the loop needs answered before it can go on. It is not the row: the row lives in
 * `agent_run_interrupts` and is written by the runtime, because `agent-loop.ts` knows nothing about a
 * database. `key` is what makes the two idempotent — `UNIQUE (run_id, key)` is why a re-entered
 * attempt finds the first ask's ANSWER instead of asking again.
 */
export interface InterruptRequest {
  /** Stable across attempts. For a gated tool call it is the call's own id, which the checkpoint replays. */
  key: string
  spec: AgentInterruptSpec
  /** The model's id for the call this ask gates, when it gates one. */
  toolCallId?: string
}

/**
 * Raised out of the loop when a turn needs a person. The host (`executeRun`) writes the rows, parks
 * the run and returns; there is nothing to catch inside the loop.
 *
 * It is a TYPE, not a message, for the same reason `AgentCancelledError` is: nothing downstream may
 * reclassify a park as a failure, and `isRetryableRunError` must answer `false` for it or a step
 * retry re-asks somebody who has already been asked.
 */
export class InterruptRequested extends Error {
  constructor(public readonly requests: InterruptRequest[]) {
    super(`Waiting for a human decision: ${requests.map(r => r.key).join(', ') || 'an interrupt'}`)
    this.name = 'InterruptRequested'
  }
}

/**
 * A person said no to something whose rejection means STOP (`onReject: 'cancel_run'` — the default
 * for an `approval`). The run settles `cancelled` with `error` NULL: a refusal is a status, not a
 * fault, and a retry must never re-ask.
 */
export class InterruptDeclinedError extends Error {
  constructor(
    public readonly interruptId: string,
    /** What the person typed when they declined, if anything. */
    public readonly note?: string
  ) {
    super('The run was declined by a human reviewer')
    this.name = 'InterruptDeclinedError'
  }
}

/**
 * An answered gate, as the loop consumes it — keyed by `toolCallId` in
 * {@link RunToolLoopOptions.approvals}, built by the runtime from the resolved rows. The agent
 * never assembles this and never queries for it.
 */
export interface ToolApproval {
  interruptId: string
  /** AG-UI's own vocabulary: `resolved` = go ahead, `cancelled` = declined. Never an `approved` boolean. */
  status: 'resolved' | 'cancelled'
  /** Replaces the model's arguments when the approver edited them (`allowEdits`); re-validated server-side. */
  input?: unknown
  note?: string
  /** What this rejection means — `rejectionFor(spec)`, resolved once by the runtime. */
  onReject: 'cancel_run' | 'tell_model'
  /** The call the person was shown (`spec.tool`). A go-ahead runs only a call that matches it. */
  approvedCall: { name: string; input: unknown } | null
}

/**
 * Append free text as a USER turn without ever producing two consecutive user messages — which
 * Anthropic rejects outright, and which is exactly what naive steering produces: a resumed
 * transcript usually ends in a user turn of `tool_result` blocks.
 *
 * Text after `tool_result` blocks is legal (the spec only requires tool results to come FIRST),
 * so the note folds into that same turn.
 */
export function appendUserText(messages: ChatMessage[], text: string): void {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'user') {
    messages.push({ role: 'user', content: text })
    return
  }
  messages[messages.length - 1] =
    typeof last.content === 'string'
      ? { ...last, content: `${last.content}\n\n${text}` }
      : { ...last, content: [...last.content, { type: 'text', text }] }
}

// ---- Structured output -----------------------------------------------------------------------

export class StructuredOutputError extends Error {
  constructor(
    message: string,
    public readonly issues?: unknown
  ) {
    super(message)
    this.name = 'StructuredOutputError'
  }
}

export interface CallStructuredToolOptions<T> {
  model: string
  system: SystemPrompt
  messages: ChatMessage[]
  tool: { name: string; description: string; schema: ZodType<T> }
  maxTokens?: number
  signal?: AbortSignal
  /** Breakpoint on the system prefix — only worth it if this prompt re-runs (default off). */
  cache?: boolean
  /** Usage tap (the sum of both attempts when a retry happens). */
  onUsage?: (usage: TokenUsage) => void
}

/**
 * Force ONE tool call and return its zod-validated input. On a parse failure the model is told the
 * issues and asked once more; a second failure throws `StructuredOutputError`.
 */
export async function callStructuredTool<T>(
  client: ChatClient,
  opts: CallStructuredToolOptions<T>
): Promise<T> {
  const tool: ToolDefinition = {
    name: opts.tool.name,
    description: opts.tool.description,
    inputSchema: toolInputSchema(opts.tool.schema),
  }
  const messages: ChatMessage[] = [...opts.messages]
  let usage = ZERO_USAGE
  let lastIssues: unknown

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await client.complete({
      model: opts.model,
      maxTokens: opts.maxTokens ?? 4096,
      system: opts.system,
      messages,
      tools: [tool],
      toolChoice: { type: 'tool', name: tool.name },
      cache: opts.cache ?? false,
      signal: opts.signal,
    })
    usage = addUsage(usage, result.usage)
    const call = toolUsesOf(result.content).find(b => b.name === tool.name)
    const parsed = call ? opts.tool.schema.safeParse(call.input) : undefined
    if (parsed?.success) {
      opts.onUsage?.(usage)
      return parsed.data
    }
    // No call: keep what the model said instead — the one clue a person has when a provider
    // without `tool_choice` (Workers AI) answers in prose.
    lastIssues = parsed
      ? parsed.error.issues
      : {
          reason: 'no tool call in the response',
          stopReason: result.stopReason,
          text: textOf(result.content).slice(0, 500),
        }
    // Feed the failure back once: assistant turn as sent, then a user turn naming the problem.
    messages.push({ role: 'assistant', content: result.content })
    messages.push({
      role: 'user',
      content: call
        ? [
            {
              type: 'tool_result',
              toolUseId: call.id,
              isError: true,
              content: `The input failed validation: ${JSON.stringify(lastIssues)}. Call ${tool.name} again with corrected input.`,
            },
          ]
        : `You must call the ${tool.name} tool with your answer.`,
    })
  }
  opts.onUsage?.(usage)
  throw new StructuredOutputError(
    `${opts.tool.name}: the model did not return valid input`,
    lastIssues
  )
}

// ---- Agentic tool loop --------------------------------------------------------------------------

export type ToolLoopEvent =
  | { kind: 'text'; turn: number; text: string }
  | { kind: 'tool_call'; turn: number; toolUseId: string; name: string; input: unknown }
  | {
      kind: 'tool_result'
      turn: number
      toolUseId: string
      name: string
      resultText: string
      isError: boolean
    }

export interface ToolLoopStep {
  turn: number
  toolNames: string[]
  terminal: boolean
  /** The turn came from the journal — an earlier attempt paid for it; nothing was billed now. */
  served?: boolean
}

/**
 * Everything a later attempt needs to carry on where this one stopped. Deliberately symmetric:
 * what {@link RunToolLoopOptions.onCheckpoint} hands you is exactly what
 * {@link RunToolLoopOptions.resume} takes back.
 */
export interface ToolLoopCheckpoint {
  /** The transcript as of the end of a turn — the seed plus every assistant/tool turn since. */
  messages: ChatMessage[]
  /** Turns spent across ALL attempts, so `maxTurns` is a run budget rather than a per-attempt one. */
  turns: number
  /** Tokens billed across all attempts (see `runtime.ts` on why this cannot double-count). */
  usage: TokenUsage
  /**
   * Milliseconds of active loop time across all attempts — what `policy.maxDurationSeconds`
   * counts. Absent in an older checkpoint, which reads as 0.
   */
  activeMs?: number
}

const contentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('tool_result'),
    toolUseId: z.string(),
    content: z.string(),
    isError: z.boolean().optional(),
  }),
  // Opaque and replayed verbatim; a provider that no longer accepts it is recovered in the adapter.
  z.object({ type: z.literal('reasoning'), provider: aiProviderSchema, data: z.unknown() }),
])

const checkpointSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant']),
      content: z.union([z.string(), z.array(contentBlockSchema)]),
    })
  ),
  turns: z.number().int().nonnegative(),
  usage: tokenUsageSchema,
  activeMs: z.number().nonnegative().optional(),
})

/**
 * Read a checkpoint back out of storage, or **null when it does not parse**. Degrading is the whole
 * point: a checkpoint written by an older build, or a corrupted row, must cost ONE replayed
 * attempt — which is exactly the behaviour before checkpoints existed — rather than failing a run
 * or feeding a provider a malformed transcript. Never widen this to a throw.
 *
 * The blocks are rebuilt field by field rather than returned straight from zod because
 * `z.unknown()` infers `input?: unknown`, which does not satisfy `ContentBlock`'s required `input`.
 */
export function parseToolLoopCheckpoint(value: unknown): ToolLoopCheckpoint | null {
  const parsed = checkpointSchema.safeParse(value)
  if (!parsed.success) return null
  return {
    turns: parsed.data.turns,
    usage: parsed.data.usage,
    ...(parsed.data.activeMs !== undefined ? { activeMs: parsed.data.activeMs } : {}),
    messages: parsed.data.messages.map(toChatMessage),
  }
}

type ParsedMessage = z.infer<typeof checkpointSchema>['messages'][number]
type ParsedBlock = z.infer<typeof contentBlockSchema>

function toContentBlock(block: ParsedBlock): ContentBlock {
  return block.type === 'tool_use'
    ? { type: 'tool_use', id: block.id, name: block.name, input: block.input }
    : block.type === 'reasoning'
      ? { type: 'reasoning', provider: block.provider, data: block.data }
      : block
}

function toChatMessage(message: ParsedMessage): ChatMessage {
  return {
    role: message.role,
    content:
      typeof message.content === 'string' ? message.content : message.content.map(toContentBlock),
  }
}

// ---- The turn journal -------------------------------------------------------------------------

/** One model turn as an earlier attempt recorded it. */
export interface RecordedModelTurn {
  content: ContentBlock[]
  stopReason: StopReason
  usage: TokenUsage
  /** What `beforeTurn` folded in before the call — re-applied, never asked for again. */
  injected: ChatMessage[]
  /** {@link toolLoopRequestHash} of the transcript (and tool list) the turn answered. */
  requestHash: string
  /** {@link toolLoopSystemHash} of the system prompt it ran under. */
  systemHash: string
}

/** One tool call as an earlier attempt recorded it. `started`: a side-effect handler began, no result. */
export type RecordedToolCall =
  | { status: 'settled'; text: string; isError: boolean }
  | { status: 'started' }

/**
 * Where the loop records each model turn and tool result AS IT SETTLES, so a retried attempt is
 * handed them instead of paying for a turn again or re-running a tool that already finished. The
 * agent runtime keeps it in `agent_run_turns` (`services/agents/turns.ts`, `ctx.journal`); a
 * replay answers from that table; this file knows neither.
 */
export interface ToolLoopJournal {
  /**
   * Open one loop's record. `key` names the loop within the run and must be stable across
   * attempts; a second `open` of the same key in ONE attempt throws (`EffectKeyConflictError`), so
   * two loops cannot silently share a record. Loads what is recorded under it.
   */
  open(key: string): Promise<ToolLoopRecord>
}

export interface ToolLoopRecord {
  /**
   * `true`: a served turn or result emits its `onEvent`s again (a replay rebuilding the timeline).
   * `false`: it does not — the attempt that recorded it already emitted them (the runtime).
   */
  readonly reemitServed: boolean
  modelTurn(turn: number): RecordedModelTurn | null
  /**
   * May this recorded turn answer the request the loop is about to send? The runtime's answer is
   * "only if the transcript is the same" (`requestHash`); a strict replay serves a changed one and
   * reports it as drift. Omitted = compare `requestHash`.
   */
  accept?(turn: number, recorded: RecordedModelTurn, current: TurnHashes): boolean
  recordModelTurn(turn: number, record: RecordedModelTurn): Promise<void>
  toolCall(toolCallId: string): RecordedToolCall | null
  /** Written before a `sideEffects` handler runs. */
  startToolCall(turn: number, toolCallId: string, name: string): Promise<void>
  settleToolCall(
    turn: number,
    toolCallId: string,
    name: string,
    result: { text: string; isError: boolean }
  ): Promise<void>
  /** A handler that raised an interrupt did not finish: forget its `started` marker. */
  forgetToolCall(toolCallId: string): Promise<void>
}

export interface TurnHashes {
  requestHash: string
  systemHash: string
}

/** The fingerprint of what one model turn answered: the transcript and the tools on offer. */
export async function toolLoopRequestHash(
  messages: ChatMessage[],
  toolNames: readonly string[]
): Promise<string> {
  return (await hashToken(canonicalJson({ messages, tools: toolNames }))).slice(0, 16)
}

export async function toolLoopSystemHash(system: SystemPrompt): Promise<string> {
  return (await hashToken(canonicalJson(system))).slice(0, 16)
}

const recordedModelTurnSchema = z.object({
  content: z.array(contentBlockSchema),
  stopReason: z.string(),
  usage: tokenUsageSchema,
  injected: checkpointSchema.shape.messages,
})

/**
 * A stored model turn back into a {@link RecordedModelTurn}, or **null when it does not parse** —
 * the same rule as {@link parseToolLoopCheckpoint}: a row an older build wrote costs one model
 * call, never a failed run.
 */
export function parseRecordedModelTurn(
  value: unknown,
  hashes: { requestHash: string | null; systemHash: string | null }
): RecordedModelTurn | null {
  const parsed = recordedModelTurnSchema.safeParse(value)
  if (!parsed.success || !hashes.requestHash) return null
  return {
    content: parsed.data.content.map(toContentBlock),
    stopReason: parsed.data.stopReason as StopReason,
    usage: parsed.data.usage,
    injected: parsed.data.injected.map(toChatMessage),
    requestHash: hashes.requestHash,
    systemHash: hashes.systemHash ?? '',
  }
}

/** The journal's turn number for a policy's forced final-answer call. */
export const SALVAGE_TURN = 0

/** What a `sideEffects` tool's call settles as when a retry cannot know whether it ran. */
export const UNKNOWN_OUTCOME_RESULT =
  'Unknown outcome: the run was interrupted while this call was running, so it may or may not have taken effect. Check whether it did before calling it again.'

export interface RunToolLoopOptions {
  model: string
  system: SystemPrompt
  /** Seed conversation — usually one user message. Ignored when `resume` is given. */
  messages: ChatMessage[]
  /** Read tools (with handlers) PLUS the terminal tool (no handler). */
  tools: Tool[]
  /** Hard cap on model turns (live agents pass `cfg.AGENT_MAX_TURNS`). */
  maxTurns?: number
  maxTokens?: number
  /** Called once per turn (before tools run) so callers can stream live progress. */
  onStep?: (step: ToolLoopStep) => void | Promise<void>
  /** Fine-grained transcript: text blocks, each tool call, each result (after the handler). */
  onEvent?: (event: ToolLoopEvent) => void | Promise<void>
  /**
   * Pick up a previous attempt instead of replaying it: its `messages` REPLACE the seed and its
   * `turns`/`usage` seed the counters, so the model is never asked to redo work it already did.
   */
  resume?: ToolLoopCheckpoint
  /**
   * Awaited at the end of each turn, after that turn's messages are appended. Persist it and a
   * retried step resumes here. A throw propagates — a checkpoint that cannot be written is a
   * failure the caller should see, not a silent loss of the transcript.
   */
  onCheckpoint?: (checkpoint: ToolLoopCheckpoint) => void | Promise<void>
  signal?: AbortSignal
  /**
   * Answers to gates already decided, keyed by the model's `toolCallId` — built by the RUNTIME from
   * the resolved `agent_run_interrupts` rows, never by the agent. A call with an entry here is not
   * asked about again; it is executed, refused or edited according to the answer.
   */
  approvals?: ReadonlyMap<string, ToolApproval>
  /**
   * Called with the open gates before the loop stops for them. `'throw'` (the default) raises
   * {@link InterruptRequested}, which is what an agent run wants: the Workflow step unwinds and the
   * run parks. `'return'` makes the loop RETURN with `stopReason: 'interrupt'` instead — the
   * Part-3 seam, because a chat host has no Workflow to unwind.
   */
  onInterrupt?: (requests: InterruptRequest[]) => Promise<'throw' | 'return'>
  /**
   * Runs an APPROVED tool call at most once across every attempt of the run. The runtime passes
   * `ctx.once`; without it an approved call re-executes on a step retry, which is precisely the
   * side effect a person was asked about.
   */
  runApproved?: <T>(key: string, fn: () => Promise<T>) => Promise<T>
  /**
   * Awaited at the top of every turn, BEFORE the model is called. Anything it returns is folded
   * into the transcript — this is where a steering note lands. A `user` message with string content
   * goes through {@link appendUserText}, so a note after a turn of tool results never becomes a
   * second consecutive user turn.
   */
  beforeTurn?: (turn: number) => Promise<ChatMessage[] | void>
  /**
   * The run's limits and what running out means (`AgentMeta.policy`) — pass the agent's
   * `meta.policy`. `maxTurns` above stays the ceiling. Without a policy the loop behaves as it
   * always has: it stops at `maxTurns` or on a turn with no tool call and hands back no answer.
   */
  policy?: AgentPolicy
  /** Awaited once before the `'final-answer'` salvage call, so a caller can show it is recovering. */
  onExhausted?: (reason: ToolLoopExhaustion) => void | Promise<void>
  /**
   * Decide, before anything else happens to it, whether a tool call may run at all — a deny by
   * POLICY, where `requiresApproval` asks a PERSON. A denied call is never gated and never
   * executed: the model gets an error result saying why and carries on. Runs on the resume path
   * too, so an answer to an old gate cannot slip a call past a rule that changed while it waited.
   */
  authorizeTool?: (call: ToolCallToAuthorize) => ToolAuthorization | Promise<ToolAuthorization>
  /**
   * Record every model turn and tool result as it settles, and serve them back on a retry — pass
   * `ctx.journal`. With it a retried attempt never pays for a turn it already took and never
   * re-runs a tool that already finished, even mid-turn; a {@link Tool.sideEffects} call that may
   * have run settles as an unknown outcome instead of running twice. It also makes the loop
   * replayable from the record (`agent:replay` strict). Without it, a retry resumes from the last
   * checkpoint and redoes whatever came after.
   */
  journal?: ToolLoopJournal
  /**
   * This loop's name in the journal, stable across attempts. Default `'tool-loop'`; a run with
   * two loops in one scope names them, or the second throws `EffectKeyConflictError`.
   */
  key?: string
}

/** What {@link RunToolLoopOptions.authorizeTool} is asked about. `input` is the model's, unparsed. */
export interface ToolCallToAuthorize {
  name: string
  input: unknown
  toolUseId: string
  turn: number
}

/** `true` / `{ allow: true }` runs the call; `false` / `{ allow: false, reason }` refuses it. */
export type ToolAuthorization = boolean | { allow: boolean; reason?: string }

/** Why a loop under a {@link AgentPolicy} ran out of road. */
export type ToolLoopExhaustion =
  | 'max_turns'
  | 'no_tool_call'
  | 'max_tool_calls'
  | 'max_duration'
  | 'repeated_failures'

/**
 * A loop under a policy ran out and could not salvage an answer: `onExhaustion: 'fail'`, or a
 * `'final-answer'` loop that does not have exactly one terminal tool to force. Not retryable — a
 * retry would resume the same exhausted transcript.
 */
export class ToolLoopExhaustedError extends Error {
  constructor(
    public readonly reason: ToolLoopExhaustion,
    public readonly turns: number
  ) {
    super(`The agent ran out of its execution budget (${reason}) after ${turns} turns`)
    this.name = 'ToolLoopExhaustedError'
  }
}

export interface ToolLoopResult {
  /** The terminal tool's validated input, or null if the loop ended without one. */
  terminalInput: unknown | null
  terminalTool: string | null
  turns: number
  stopReason: StopReason | ToolLoopExhaustion | 'interrupt'
  usage: TokenUsage
  /** The full transcript (seed + assistant/tool turns); also what `onCheckpoint` persists. */
  messages: ChatMessage[]
  /** Set only with `stopReason: 'interrupt'` and `onInterrupt` answering `'return'`. */
  interrupts?: InterruptRequest[]
  /**
   * The loop ran out (`stopReason` says how) and `terminalInput` came from the policy's ONE forced
   * call to the terminal tool, not from a turn of the loop.
   */
  salvaged?: boolean
}

/**
 * Read the policy's two transcript-derived counters back out of a transcript: tool calls answered
 * (the terminal tool's answer is not one) and the run of error results at its end. Derived rather
 * than stored so an older checkpoint — or any resumed attempt — counts what really
 * happened.
 */
function countToolResults(
  messages: ChatMessage[],
  byName: ReadonlyMap<string, Tool>
): { toolCalls: number; consecutiveFailures: number } {
  const nameOf = new Map<string, string>()
  let toolCalls = 0
  let consecutiveFailures = 0
  for (const message of messages) {
    if (typeof message.content === 'string') continue
    for (const block of message.content) {
      if (block.type === 'tool_use') nameOf.set(block.id, block.name)
      if (block.type !== 'tool_result') continue
      const tool = byName.get(nameOf.get(block.toolUseId) ?? '')
      if (!tool || tool.handler) toolCalls += 1
      consecutiveFailures = block.isError ? consecutiveFailures + 1 : 0
    }
  }
  return { toolCalls, consecutiveFailures }
}

function isAllowed(decision: ToolAuthorization): { allow: boolean; reason?: string } {
  return typeof decision === 'boolean' ? { allow: decision } : decision
}

/**
 * THE tool runner — both loops call it, so it is also where every tool execution becomes an
 * `execute_tool <name>` span under whatever span is active. Untraced when nothing is.
 */
function runHandler(
  tool: Tool | undefined,
  name: string,
  input: unknown,
  toolUseId?: string
): Promise<{ text: string; isError: boolean }> {
  return traceToolCall(name, toolUseId, input, () =>
    executeHandler(tool, name, input, { toolCallId: toolUseId, idempotencyKey: toolUseId })
  )
}

async function executeHandler(
  tool: Tool | undefined,
  name: string,
  input: unknown,
  call: ToolCallInfo
) {
  if (!tool) return { text: `Unknown tool: ${name}`, isError: true }
  const parsed = tool.schema.safeParse(input)
  if (!parsed.success) {
    return {
      text: `Invalid input for ${name}: ${JSON.stringify(parsed.error.issues)}`,
      isError: true,
    }
  }
  if (!tool.handler)
    return { text: `${name} is a terminal tool and cannot be executed`, isError: true }
  try {
    return { text: await tool.handler(parsed.data, call), isError: false }
  } catch (err) {
    // The ONE thing that is not a tool failure. Raising an interrupt from inside a handler is the
    // natural place to ask ("which of these three customers did you mean?"), and swallowing it into
    // an `isError` result would leave the model to simply ask the same question again, forever.
    // `runStreamingChat` deliberately does NOT get this rethrow — see the note on its handler loop.
    if (err instanceof InterruptRequested) throw err
    return { text: err instanceof Error ? err.message : 'Tool execution failed', isError: true }
  }
}

/** A `tool_use` block, as the loop and its gate pass one around. */
type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>

/**
 * The tool calls of a transcript's TRAILING assistant turn that nothing has answered yet — which is
 * exactly what a parked run's checkpoint looks like, because the gate raises after the assistant
 * turn is pushed and before any handler runs.
 *
 * Nothing else in the loop can produce this shape: every other path pushes a `user` turn of
 * `tool_result` blocks before it checkpoints. It matters because `runToolLoop`'s `while` opens with
 * `client.complete(messages)`, and sending an unanswered `tool_use` is a 400 on Anthropic and
 * garbage everywhere else — so without this a resumed run could never take its first turn.
 */
function pendingToolUses(messages: ChatMessage[]): ToolUseBlock[] {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant' || typeof last.content === 'string') return []
  return toolUsesOf(last.content)
}

/**
 * Drive the model until it calls a TERMINAL tool (one without a handler), stops calling tools, or
 * hits `maxTurns`. Each turn: run every requested read tool (unknown/erroring → `is_error` result
 * so the model can recover), append assistant + tool_result turns, continue. The terminal tool is
 * never executed — its input is the answer.
 *
 * The loop is RESUMABLE: `onCheckpoint` is awaited at the end of every turn, and handing that
 * checkpoint back as `resume` continues the same conversation with the turn and token counters
 * intact, so a retried Workflow step costs the turns it still owes rather than all of them again.
 *
 * It is also INTERRUPTIBLE: a tool may declare `requiresApproval`, and a turn with an
 * unanswered gate checkpoints and raises {@link InterruptRequested} rather than running anything.
 * Two properties of that are load-bearing and easy to break:
 *
 * - **The gate scans the WHOLE turn before any handler runs.** A turn with three calls, one of them
 *   gated, parks with nothing executed — so resuming has only the approved call to make idempotent,
 *   and the plural `interrupts[]` is what `RunFinishedInterruptOutcome` already models.
 * - **The resume path and the in-loop path share ONE `executeToolUses`.** Two copies of the
 *   approval rules is how a gate ends up bypassed on the resume path only.
 */
export async function runToolLoop(
  client: ChatClient,
  opts: RunToolLoopOptions
): Promise<ToolLoopResult> {
  const policy = opts.policy
  const ceiling = opts.maxTurns ?? 8
  const maxTurns = policy?.maxTurns ? Math.min(ceiling, policy.maxTurns) : ceiling
  const byName = new Map(opts.tools.map(t => [t.name, t]))
  const definitions = opts.tools.map(toToolDefinition)
  const toolNames = opts.tools.map(t => t.name)
  // Opened before anything else: a second loop under the same key in this attempt throws here,
  // before it could read — or overwrite — the first one's record.
  const record = opts.journal ? await opts.journal.open(opts.key ?? 'tool-loop') : null
  const systemHash = record ? await toolLoopSystemHash(opts.system) : ''
  // A resumed loop starts from the stored transcript, NOT the seed: replaying it would re-ask the
  // model everything the previous attempt already paid for.
  const messages: ChatMessage[] = [...(opts.resume?.messages ?? opts.messages)]
  let usage = opts.resume?.usage ?? ZERO_USAGE
  let turns = opts.resume?.turns ?? 0
  // Active time is carried in the checkpoint rather than measured from the run's start, so a run
  // parked on a person for a day resumes with the time it had actually used.
  const attemptStartedAt = Date.now()
  const activeMs = () => (opts.resume?.activeMs ?? 0) + (Date.now() - attemptStartedAt)
  const checkpoint = async () => {
    await opts.onCheckpoint?.({ messages: [...messages], turns, usage, activeMs: activeMs() })
  }

  /** The limit this loop has hit, if any — checked before each model turn and after each tool turn. */
  const spent = (): ToolLoopExhaustion | null => {
    if (!policy) return null
    const { toolCalls, consecutiveFailures } = countToolResults(messages, byName)
    if (policy.repeatedFailureLimit && consecutiveFailures >= policy.repeatedFailureLimit) {
      return 'repeated_failures'
    }
    if (policy.maxToolCalls && toolCalls >= policy.maxToolCalls) return 'max_tool_calls'
    if (policy.maxDurationSeconds && activeMs() >= policy.maxDurationSeconds * 1000) {
      return 'max_duration'
    }
    return null
  }

  /**
   * Out of road. Without a policy: the old result, no answer. With one: `'fail'` throws, and
   * `'final-answer'` forces ONE call to the terminal tool over the transcript so far. That call
   * failing fails the run (`StructuredOutputError`, or the provider's own error, cancellation
   * included) — a salvage that cannot produce an answer is never reported as one.
   */
  const exhaust = async (reason: ToolLoopExhaustion): Promise<ToolLoopResult> => {
    const unanswered = { terminalInput: null, terminalTool: null, turns, usage, messages }
    if (!policy) return { ...unanswered, stopReason: reason }
    const terminals = opts.tools.filter(t => !t.handler)
    const terminal = terminals.length === 1 ? terminals[0] : undefined
    if ((policy.onExhaustion ?? 'final-answer') === 'fail' || !terminal) {
      throw new ToolLoopExhaustedError(reason, turns)
    }
    await opts.onExhausted?.(reason)
    const input = await salvage(terminal)
    return {
      ...unanswered,
      terminalInput: input,
      terminalTool: terminal.name,
      stopReason: reason,
      usage,
      salvaged: true,
    }
  }

  /**
   * The ONE forced call to the terminal tool, journaled as turn 0 (real turns count from 1): a
   * retry that dies after it, and a replay, get the recorded answer instead of a second call.
   */
  const salvage = async (terminal: Tool): Promise<unknown> => {
    const hashes = record
      ? { requestHash: await toolLoopRequestHash(messages, [terminal.name]), systemHash }
      : null
    const recorded = record?.modelTurn(SALVAGE_TURN) ?? null
    if (record && hashes && recorded) {
      const accepted = record.accept
        ? record.accept(SALVAGE_TURN, recorded, hashes)
        : recorded.requestHash === hashes.requestHash
      const call = accepted
        ? toolUsesOf(recorded.content).find(b => b.name === terminal.name)
        : null
      const parsed = call ? terminal.schema.safeParse(call.input) : null
      if (parsed?.success) {
        usage = addUsage(usage, recorded.usage)
        return parsed.data
      }
    }
    let spentHere = ZERO_USAGE
    const input = await callStructuredTool(client, {
      model: opts.model,
      maxTokens: opts.maxTokens ?? 4096,
      system: opts.system,
      messages,
      tool: { name: terminal.name, description: terminal.description, schema: terminal.schema },
      // The loop just sent this transcript, so a caching provider reads the prefix back.
      cache: true,
      signal: opts.signal,
      onUsage: extra => {
        spentHere = extra
        usage = addUsage(usage, extra)
      },
    })
    if (record && hashes) {
      await record.recordModelTurn(SALVAGE_TURN, {
        content: [{ type: 'tool_use', id: `salvage:${terminal.name}`, name: terminal.name, input }],
        stopReason: 'tool_use',
        usage: spentHere,
        injected: [],
        ...hashes,
      })
    }
    return input
  }

  /**
   * `authorizeTool`'s answers for a turn, keyed by tool call id — only the refusals. Asked BEFORE
   * the gates are collected, so nobody is asked to approve a call policy would refuse anyway.
   */
  const authorize = async (toolUses: ToolUseBlock[], turn: number) => {
    const denied = new Map<string, string | undefined>()
    if (!opts.authorizeTool) return denied
    for (const block of toolUses) {
      const decision = isAllowed(
        await opts.authorizeTool({
          name: block.name,
          input: block.input,
          toolUseId: block.id,
          turn,
        })
      )
      if (!decision.allow) denied.set(block.id, decision.reason)
    }
    return denied
  }

  /**
   * Every open gate in a turn, or none. An input that fails the tool's own schema is skipped on
   * purpose — it takes the existing `isError` path, because nobody should be asked to approve
   * arguments the tool would reject anyway.
   */
  const collectGates = (
    toolUses: ToolUseBlock[],
    denied: ReadonlyMap<string, string | undefined>
  ): InterruptRequest[] => {
    const requests: InterruptRequest[] = []
    for (const block of toolUses) {
      const tool = byName.get(block.name)
      if (!tool || opts.approvals?.has(block.id) || denied.has(block.id)) continue
      if (!tool.requiresApproval && !tool.requiresApprovalWhen) continue
      const parsed = tool.schema.safeParse(block.input)
      if (!parsed.success) continue
      const gated = tool.requiresApprovalWhen
        ? tool.requiresApprovalWhen(parsed.data)
        : tool.requiresApproval === true
      if (!gated) continue
      const message = tool.approvalMessage ?? `Run ${tool.name}?`
      requests.push({
        // The tool call's own id: the checkpoint replays the same assistant turn, so the same id
        // comes back on the next attempt — which is what makes `(run_id, key)` find the answer.
        key: `tool:${block.id}`,
        toolCallId: block.id,
        spec: {
          kind: 'approval',
          message,
          tool: {
            name: tool.name,
            input: parsed.data,
            allowEdits: tool.allowEdits ?? false,
            inputSchema: toolInputSchema(tool.schema),
          },
          ...(tool.onReject ? { onReject: tool.onReject } : {}),
        },
      })
    }
    return requests
  }

  /** Checkpoint FIRST — the whole point of parking cheaply — then hand the gates to the host. */
  const raise = async (requests: InterruptRequest[]): Promise<ToolLoopResult | never> => {
    await checkpoint()
    const mode = (await opts.onInterrupt?.(requests)) ?? 'throw'
    if (mode === 'throw') throw new InterruptRequested(requests)
    return {
      terminalInput: null,
      terminalTool: null,
      turns,
      stopReason: 'interrupt',
      usage,
      messages,
      interrupts: requests,
    }
  }

  const defaultConcurrency = 4
  const rawCap = policy?.maxConcurrentToolCalls
  const maxConcurrentToolCalls =
    typeof rawCap === 'number' && Number.isInteger(rawCap) && rawCap >= 1
      ? rawCap
      : defaultConcurrency

  // An approval is good for one execution per attempt. A retried attempt starts a fresh set and
  // replays the recorded effect through `runApproved`.
  const spentApprovals = new Set<string>()

  /** Is this block the very call the person approved? Stored input is parsed, so compare parsed. */
  const isApprovedCall = (tool: Tool | undefined, block: ToolUseBlock, shown: ToolApproval) => {
    const call = shown.approvedCall
    if (!tool || !call || call.name !== block.name) return false
    const parsed = tool.schema.safeParse(block.input)
    if (!parsed.success) return false
    return canonicalJson(parsed.data) === canonicalJson(call.input)
  }

  type ToolOutcome = { text: string; isError: boolean; served?: boolean }

  /**
   * One call through the journal: a settled record is the answer (nothing runs); a `started`
   * record on a `sideEffects` tool that is not `durable` is an unknown outcome (nothing runs);
   * otherwise the call runs — `started` first when it has side effects — and settles its record.
   */
  const executeSingleToolUse = async (block: ToolUseBlock, turn: number): Promise<ToolOutcome> => {
    if (!record) return executeToolUse(block)
    const tool = byName.get(block.name)
    const recorded = record.toolCall(block.id)
    if (recorded?.status === 'settled') {
      return { text: recorded.text, isError: recorded.isError, served: true }
    }
    const risky = tool?.handler && tool.sideEffects
    if (recorded?.status === 'started' && risky && !tool.durable) {
      const unknown = { text: UNKNOWN_OUTCOME_RESULT, isError: true }
      await record.settleToolCall(turn, block.id, block.name, unknown)
      return unknown
    }
    if (risky && !recorded) await record.startToolCall(turn, block.id, block.name)
    let outcome: ToolOutcome
    try {
      outcome = await executeToolUse(block)
    } catch (err) {
      // A handler that ASKED did not finish: the resumed attempt calls it again with the answer.
      if (risky && err instanceof InterruptRequested) await record.forgetToolCall(block.id)
      throw err
    }
    await record.settleToolCall(turn, block.id, block.name, outcome)
    return outcome
  }

  const executeToolUse = async (block: ToolUseBlock): Promise<ToolOutcome> => {
    const tool = byName.get(block.name)
    const approval = opts.approvals?.get(block.id)
    if (approval?.status === 'cancelled') {
      if (approval.onReject === 'cancel_run') {
        throw new InterruptDeclinedError(approval.interruptId, approval.note)
      }
      // `tell_model`: declining is an ANSWER, not a fault, so `isError` is false. An error result
      // would have the model apologising and retrying the thing it was just refused.
      return {
        text: approval.note
          ? `A person declined this action: ${approval.note}`
          : 'A person declined this action. Do not try it again; continue another way.',
        isError: false,
      }
    }
    if (approval) {
      if (spentApprovals.has(approval.interruptId) || !isApprovedCall(tool, block, approval)) {
        return {
          text: 'This call is not the one a person approved. It did not run.',
          isError: true,
        }
      }
      spentApprovals.add(approval.interruptId)
      // An approver may have edited the arguments; the route re-validated them against the tool's
      // own schema before storing them, and `runHandler` validates once more here.
      const input = approval.input !== undefined ? approval.input : block.input
      const run = () => runHandler(tool, block.name, input, block.id)
      return opts.runApproved
        ? await opts.runApproved(`tool:${approval.interruptId}`, run)
        : await run()
    }
    return await runHandler(tool, block.name, block.input, block.id)
  }

  /**
   * Run a turn's tool calls and build its `tool_result` blocks. The ONE place the approval rules
   * live — the in-loop path and the resume path both call it.
   *
   * Executes via a single bounded worker pool (size = min(maxConcurrentToolCalls, toolUses.length)).
   * Emits each `tool_result` event progressively as soon as that result and all preceding results
   * in model-request order are ready, preserving transcript order and live timeline updates.
   */
  const executeToolUses = async (
    toolUses: ToolUseBlock[],
    turn: number,
    denied: ReadonlyMap<string, string | undefined>
  ): Promise<ContentBlock[]> => {
    if (toolUses.length === 0) return []

    // Calls already answered before this turn, for `maxToolCalls`. Every call in the turn still
    // gets a result — a `tool_use` left unanswered is a 400 on the NEXT request, the salvage's.
    let budget = policy?.maxToolCalls
      ? policy.maxToolCalls - countToolResults(messages, byName).toolCalls
      : Number.POSITIVE_INFINITY

    type TaskOutcome = { kind: 'result'; outcome: ToolOutcome } | { kind: 'error'; error: unknown }

    const outcomes: (TaskOutcome | undefined)[] = new Array(toolUses.length)
    let nextIndex = 0
    let stopClaiming = false

    let nextEmitIndex = 0
    let emitPromise = Promise.resolve()
    let emitError: unknown

    const flushEmits = () => {
      emitPromise = emitPromise
        .then(async () => {
          while (nextEmitIndex < toolUses.length) {
            if (emitError) break
            const task = outcomes[nextEmitIndex]
            if (!task || task.kind === 'error') break
            const index = nextEmitIndex++
            const block = toolUses[index]
            const outcome = task.outcome
            // Served from the journal: the attempt that recorded it already put it on the timeline.
            if (outcome.served && !record?.reemitServed) continue
            try {
              await opts.onEvent?.({
                kind: 'tool_result',
                turn,
                toolUseId: block.id,
                name: block.name,
                resultText: outcome.text,
                isError: outcome.isError,
              })
            } catch (err) {
              emitError = err
              stopClaiming = true
              break
            }
          }
        })
        .catch(err => {
          emitError = err
          stopClaiming = true
        })
      return emitPromise
    }

    const runWorker = async () => {
      while (true) {
        if (stopClaiming || emitError || opts.signal?.aborted) return

        const index = nextIndex++
        if (index >= toolUses.length) return

        const block = toolUses[index]

        if (denied.has(block.id)) {
          const reason = denied.get(block.id)
          outcomes[index] = {
            kind: 'result',
            outcome: {
              text: reason
                ? `This call was refused by policy: ${reason}`
                : `This call was refused by policy: ${block.name} may not run here.`,
              isError: true,
            },
          }
          await flushEmits()
          continue
        }

        if (budget <= 0) {
          outcomes[index] = {
            kind: 'result',
            outcome: {
              text: 'Not run: this run has used all of its tool calls.',
              isError: true,
            },
          }
          await flushEmits()
          continue
        }

        budget -= 1

        try {
          const outcome = await executeSingleToolUse(block, turn)
          outcomes[index] = { kind: 'result', outcome }
          await flushEmits()
        } catch (err) {
          outcomes[index] = { kind: 'error', error: err }
          stopClaiming = true
          await flushEmits()
          return
        }
      }
    }

    const workerCount = Math.min(maxConcurrentToolCalls, toolUses.length)
    const workers = Array.from({ length: workerCount }, () => runWorker())
    await Promise.all(workers)

    await emitPromise

    if (opts.signal?.aborted) {
      throw new AiError('unavailable', client.provider, 'Agent run cancelled')
    }

    if (emitError) {
      throw emitError
    }

    for (let i = 0; i < toolUses.length; i++) {
      const task = outcomes[i]
      if (task?.kind === 'error') {
        throw task.error
      }
    }

    const results: ContentBlock[] = []
    for (let i = 0; i < toolUses.length; i++) {
      const block = toolUses[i]
      const task = outcomes[i]
      if (!task || task.kind !== 'result') {
        break
      }
      results.push({
        type: 'tool_result',
        toolUseId: block.id,
        content: task.outcome.text,
        isError: task.outcome.isError,
      })
    }

    return results
  }

  /** Fold `beforeTurn`'s (or a recorded turn's) messages into the transcript. */
  const inject = (into: ChatMessage[], injected: readonly ChatMessage[]) => {
    for (const message of injected) {
      if (message.role === 'user' && typeof message.content === 'string') {
        appendUserText(into, message.content)
      } else {
        into.push(message)
      }
    }
  }

  /**
   * One model turn: served from the journal when an earlier attempt recorded it against this
   * same transcript, else asked for and recorded. A recorded turn's steering notes are re-applied
   * rather than asked for again — `ctx.steering()` delivers each note once, and it was delivered
   * to the attempt that recorded the turn. A transcript that changed underneath a record (an
   * unrecorded tool re-ran and answered differently) asks the model and replaces the record.
   */
  const takeTurn = async (
    turn: number
  ): Promise<{ result: Awaited<ReturnType<ChatClient['complete']>>; served: boolean }> => {
    const recorded = record?.modelTurn(turn) ?? null
    if (record && recorded) {
      const candidate = [...messages]
      inject(candidate, recorded.injected)
      const current = {
        requestHash: await toolLoopRequestHash(candidate, toolNames),
        systemHash,
      }
      const accepted = record.accept
        ? record.accept(turn, recorded, current)
        : recorded.requestHash === current.requestHash
      if (accepted) {
        messages.splice(0, messages.length, ...candidate)
        return {
          result: {
            content: recorded.content,
            stopReason: recorded.stopReason,
            usage: recorded.usage,
            model: opts.model,
          },
          served: true,
        }
      }
    }
    const injected = [...(recorded?.injected ?? []), ...((await opts.beforeTurn?.(turn)) ?? [])]
    inject(messages, injected)
    const result = await client.complete({
      model: opts.model,
      maxTokens: opts.maxTokens ?? 4096,
      system: opts.system,
      messages,
      tools: definitions,
      toolChoice: { type: 'auto' },
      signal: opts.signal,
    })
    if (record) {
      // The hash is over the transcript as SENT — with the folded-in notes, which the record keeps.
      await record.recordModelTurn(turn, {
        content: result.content,
        stopReason: result.stopReason,
        usage: result.usage,
        injected,
        requestHash: await toolLoopRequestHash(messages, toolNames),
        systemHash,
      })
    }
    return { result, served: false }
  }

  // The resume path. A checkpoint whose last turn is an assistant message with unanswered
  // tool calls is what parking leaves behind, and it must be answered BEFORE the `while` body ever
  // calls the model again. A gate that is STILL open (a second round, or a partly answered turn)
  // parks again rather than running anything.
  const pending = pendingToolUses(messages)
  if (pending.length > 0) {
    const denied = await authorize(pending, turns)
    const stillGated = collectGates(pending, denied)
    if (stillGated.length > 0) return await raise(stillGated)
    messages.push({ role: 'user', content: await executeToolUses(pending, turns, denied) })
    await checkpoint()
  }

  while (turns < maxTurns) {
    if (opts.signal?.aborted)
      throw new AiError('unavailable', client.provider, 'Agent run cancelled')
    const limit = spent()
    if (limit) return await exhaust(limit)
    const turn = turns + 1
    const { result, served } = await takeTurn(turn)
    turns = turn
    usage = addUsage(usage, result.usage)
    const toolUses = toolUsesOf(result.content)
    // A served turn's events were emitted by the attempt that paid for it.
    const emits = !served || record?.reemitServed === true

    if (opts.onEvent && emits) {
      for (const block of result.content) {
        if (block.type === 'text' && block.text.trim()) {
          await opts.onEvent({ kind: 'text', turn: turns, text: block.text })
        }
      }
    }
    const terminal = toolUses.find(b => !byName.get(b.name)?.handler && byName.has(b.name))
    await opts.onStep?.({
      turn: turns,
      toolNames: toolUses.map(b => b.name),
      terminal: Boolean(terminal),
      ...(served ? { served: true } : {}),
    })
    if (opts.onEvent && emits) {
      for (const block of toolUses) {
        await opts.onEvent({
          kind: 'tool_call',
          turn: turns,
          toolUseId: block.id,
          name: block.name,
          input: block.input,
        })
      }
    }

    messages.push({ role: 'assistant', content: result.content })

    if (terminal) {
      const tool = byName.get(terminal.name)
      const parsed = tool?.schema.safeParse(terminal.input)
      if (parsed?.success) {
        return {
          terminalInput: parsed.data,
          terminalTool: terminal.name,
          turns,
          stopReason: result.stopReason,
          usage,
          messages,
        }
      }
      // Invalid terminal input: hand the issues back and let the model try again (counts as a turn).
      const issues = parsed ? JSON.stringify(parsed.error.issues) : 'unknown tool'
      const results: ContentBlock[] = [
        {
          type: 'tool_result',
          toolUseId: terminal.id,
          isError: true,
          content: `Invalid input for ${terminal.name}: ${issues}`,
        },
      ]
      await opts.onEvent?.({
        kind: 'tool_result',
        turn: turns,
        toolUseId: terminal.id,
        name: terminal.name,
        resultText: results[0]?.type === 'tool_result' ? results[0].content : '',
        isError: true,
      })
      messages.push({ role: 'user', content: results })
      await checkpoint()
      continue
    }

    if (toolUses.length === 0) return await exhaust('no_tool_call')

    // The gate: after the assistant turn is on the transcript, before any handler has run.
    const denied = await authorize(toolUses, turns)
    const gates = collectGates(toolUses, denied)
    if (gates.length > 0) return await raise(gates)

    // Checkpoint BEFORE the tools run: a retry that dies among them resumes on the pending path
    // with this assistant turn, instead of asking the model for it again.
    await checkpoint()
    messages.push({ role: 'user', content: await executeToolUses(toolUses, turns, denied) })
    await checkpoint()
  }

  return await exhaust(spent() ?? 'max_turns')
}

// ---- Streaming conversational loop ----------------------------------------------------------

export interface StreamingToolCall {
  id: string
  name: string
  input: unknown
  result?: string
  isError?: boolean
}

export interface RunStreamingChatOptions {
  model: string
  system: SystemPrompt
  messages: ChatMessage[]
  /** Read tools only (every tool here has a handler); zero by default. */
  tools?: Tool[]
  maxTurns?: number
  maxTokens?: number
  signal?: AbortSignal
  onDelta: (text: string) => void | Promise<void>
  onToolStart?: (call: { toolUseId: string; name: string; input: unknown }) => void | Promise<void>
  onToolEnd?: (call: {
    toolUseId: string
    name: string
    result: string
    isError: boolean
  }) => void | Promise<void>
}

export interface StreamingChatResult {
  /** The final, tool-free turn's text — what the reader saw. */
  text: string
  toolCalls: StreamingToolCall[]
  usage: TokenUsage
  stopReason: StopReason | 'max_turns'
}

/**
 * Stream a reply, running read tools between turns until the model answers without one. Text from
 * a tool-calling turn is streamed too (and kept, joined by a paragraph break) so the transcript is
 * byte-for-byte what the reader was shown.
 */
export async function runStreamingChat(
  client: ChatClient,
  opts: RunStreamingChatOptions
): Promise<StreamingChatResult> {
  const maxTurns = opts.maxTurns ?? 8
  // Chat cannot park a turn for a person's answer, so a tool that declares a gate is withheld: the
  // model is not offered it, and naming it anyway finds no tool and gets an error result.
  const tools = (opts.tools ?? []).filter(t => !t.requiresApproval && !t.requiresApprovalWhen)
  const byName = new Map(tools.map(t => [t.name, t]))
  const definitions = tools.map(toToolDefinition)
  const messages: ChatMessage[] = [...opts.messages]
  const toolCalls: StreamingToolCall[] = []
  let usage = ZERO_USAGE
  let carried = ''

  for (let turn = 0; turn < maxTurns; turn++) {
    if (opts.signal?.aborted) throw new AiError('unavailable', client.provider, 'Chat cancelled')
    let turnText = ''
    let result: Awaited<ReturnType<ChatClient['complete']>> | undefined
    for await (const delta of client.stream({
      model: opts.model,
      maxTokens: opts.maxTokens ?? 4096,
      system: opts.system,
      messages,
      tools: definitions.length > 0 ? definitions : undefined,
      toolChoice: definitions.length > 0 ? { type: 'auto' } : undefined,
      signal: opts.signal,
    })) {
      if (delta.type === 'text') {
        turnText += delta.text
        await opts.onDelta(delta.text)
      } else if (delta.type === 'end') {
        result = delta.result
      }
    }
    if (!result)
      throw new AiError('unavailable', client.provider, 'The stream ended without a result')
    usage = addUsage(usage, result.usage)
    const toolUses = toolUsesOf(result.content)

    if (toolUses.length === 0) {
      return {
        text: carried + (turnText || textOf(result.content)),
        toolCalls,
        usage,
        stopReason: result.stopReason,
      }
    }

    if (turnText) {
      await opts.onDelta('\n\n')
      carried += `${turnText}\n\n`
    }
    messages.push({ role: 'assistant', content: result.content })
    const results: ContentBlock[] = []
    // No interrupt gate here, deliberately: gated tools were withheld above. Chat has no host that
    // can park a turn — there is no Workflow to unwind and no `agent_runs` row to hold the answer —
    // so a tool raising
    // `InterruptRequested` in a chat is a BUG, and `runHandler` turning it into an `isError` result
    // is what we want to see: a visible wrong answer rather than a stream that never terminates.
    // Chat HITL is Part 3 and arrives as `onInterrupt: 'return'` plus a conversation checkpoint.
    for (const block of toolUses) {
      await opts.onToolStart?.({ toolUseId: block.id, name: block.name, input: block.input })
      const { text, isError } = await runHandler(
        byName.get(block.name),
        block.name,
        block.input,
        block.id
      )
      toolCalls.push({ id: block.id, name: block.name, input: block.input, result: text, isError })
      results.push({ type: 'tool_result', toolUseId: block.id, content: text, isError })
      await opts.onToolEnd?.({ toolUseId: block.id, name: block.name, result: text, isError })
    }
    messages.push({ role: 'user', content: results })
  }

  return { text: carried.trimEnd(), toolCalls, usage, stopReason: 'max_turns' }
}
