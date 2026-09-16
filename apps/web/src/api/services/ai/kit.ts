/**
 * Agent kit (D17) — "how to call the client": prompt-cache breakpoint policy (`cachedSystem`,
 * `withRollingCacheBreakpoints`), forced structured output (`callStructuredTool`), the agentic
 * tool loop (`runToolLoop`, Phase 3b's engine) and the streaming conversational loop
 * (`runStreamingChat`, the chat route's engine). Everything is written against `ChatClient`, so a
 * fake client drives it in tests and every provider adapter benefits from the same policy.
 * Ported from the Node reference app's `agent-kit.ts`, minus its narration-buffering and speech
 * heuristics (the options are gone, not the loop).
 */

import type Anthropic from '@anthropic-ai/sdk'
import { type TokenUsage, tokenUsageSchema } from '@rocketflare/shared/ai/chat'
import type { AgentInterruptSpec, JsonSchema } from '@rocketflare/shared/ai/interrupts'
import { type ZodType, z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
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
    if (message) marked[index] = { ...message, content: withBreakpoint(message.content) }
  }
  return marked
}

// ---- Tools ---------------------------------------------------------------------------------

/** A tool the model may call. `handler` runs it; a tool WITHOUT a handler is terminal (its input is the answer). */
export interface Tool<Input = unknown> {
  name: string
  description: string
  /** zod schema for the input — validated before `handler` runs and rendered to JSON Schema for the model. */
  schema: ZodType<Input>
  /** Method syntax on purpose: bivariant params let a `Tool<{ q: string }>` sit in a `Tool[]`. */
  handler?(input: Input): Promise<string>
  /**
   * Gate this call on a person (issue #17): the loop stops, asks, and runs the handler only on a
   * `resolved` answer. Enforced by {@link runToolLoop}, never by the handler — a handler that
   * checks for itself is a handler that has already run.
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

/**
 * JSON Schema (draft-07, `$schema` stripped) for a tool input.
 *
 * The return type is the shared {@link JsonSchema} — the SAME contract `Interrupt.responseSchema`
 * and `agentInfoSchema.inputJsonSchema` carry — so a converted schema can be put on the wire
 * without a cast. Both are `Record<string, unknown>`; naming it says which one it is.
 */
export function toolInputSchema(schema: ZodType): JsonSchema {
  const { $schema: _drop, ...json } = zodToJsonSchema(schema, { target: 'jsonSchema7' }) as Record<
    string,
    unknown
  >
  return json
}

export function toToolDefinition(tool: Tool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: toolInputSchema(tool.schema),
  }
}

// ---- Interrupts: the human-in-the-loop seam (issue #17) -------------------------------------

/**
 * One question the loop needs answered before it can go on. It is not the row: the row lives in
 * `agent_run_interrupts` and is written by the runtime, because `kit.ts` knows nothing about a
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
    messages: parsed.data.messages.map(message => ({
      role: message.role,
      content:
        typeof message.content === 'string'
          ? message.content
          : message.content.map(
              (block): ContentBlock =>
                block.type === 'tool_use'
                  ? { type: 'tool_use', id: block.id, name: block.name, input: block.input }
                  : block
            ),
    })),
  }
}

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
}

export interface ToolLoopResult {
  /** The terminal tool's validated input, or null if the loop ended without one. */
  terminalInput: unknown | null
  terminalTool: string | null
  turns: number
  stopReason: StopReason | 'max_turns' | 'no_tool_call' | 'interrupt'
  usage: TokenUsage
  /** The full transcript (seed + assistant/tool turns); also what `onCheckpoint` persists. */
  messages: ChatMessage[]
  /** Set only with `stopReason: 'interrupt'` and `onInterrupt` answering `'return'`. */
  interrupts?: InterruptRequest[]
}

async function runHandler(tool: Tool | undefined, name: string, input: unknown) {
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
    return { text: await tool.handler(parsed.data), isError: false }
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
 * garbage everywhere else — so without this a resumed run could never take its first turn (T1).
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
 * It is also INTERRUPTIBLE (issue #17): a tool may declare `requiresApproval`, and a turn with an
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
  const maxTurns = opts.maxTurns ?? 8
  const byName = new Map(opts.tools.map(t => [t.name, t]))
  const definitions = opts.tools.map(toToolDefinition)
  // A resumed loop starts from the stored transcript, NOT the seed: replaying it would re-ask the
  // model everything the previous attempt already paid for.
  const messages: ChatMessage[] = [...(opts.resume?.messages ?? opts.messages)]
  let usage = opts.resume?.usage ?? ZERO_USAGE
  let turns = opts.resume?.turns ?? 0
  const checkpoint = async () => {
    await opts.onCheckpoint?.({ messages: [...messages], turns, usage })
  }

  /**
   * Every open gate in a turn, or none. An input that fails the tool's own schema is skipped on
   * purpose — it takes the existing `isError` path, because nobody should be asked to approve
   * arguments the tool would reject anyway.
   */
  const collectGates = (toolUses: ToolUseBlock[]): InterruptRequest[] => {
    const requests: InterruptRequest[] = []
    for (const block of toolUses) {
      const tool = byName.get(block.name)
      if (!tool || opts.approvals?.has(block.id)) continue
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

  /**
   * Run a turn's tool calls and build its `tool_result` blocks. The ONE place the approval rules
   * live — the in-loop path and the resume path both call it.
   */
  const executeToolUses = async (
    toolUses: ToolUseBlock[],
    turn: number
  ): Promise<ContentBlock[]> => {
    const results: ContentBlock[] = []
    for (const block of toolUses) {
      const tool = byName.get(block.name)
      const approval = opts.approvals?.get(block.id)
      let outcome: { text: string; isError: boolean }
      if (approval?.status === 'cancelled') {
        if (approval.onReject === 'cancel_run') {
          throw new InterruptDeclinedError(approval.interruptId, approval.note)
        }
        // `tell_model`: declining is an ANSWER, not a fault, so `isError` is false. An error result
        // would have the model apologising and retrying the thing it was just refused.
        outcome = {
          text: approval.note
            ? `A person declined this action: ${approval.note}`
            : 'A person declined this action. Do not try it again; continue another way.',
          isError: false,
        }
      } else if (approval) {
        // An approver may have edited the arguments; the route re-validated them against the tool's
        // own schema before storing them, and `runHandler` validates once more here.
        const input = approval.input !== undefined ? approval.input : block.input
        const run = () => runHandler(tool, block.name, input)
        outcome = opts.runApproved
          ? await opts.runApproved(`tool:${approval.interruptId}`, run)
          : await run()
      } else {
        outcome = await runHandler(tool, block.name, block.input)
      }
      results.push({
        type: 'tool_result',
        toolUseId: block.id,
        content: outcome.text,
        isError: outcome.isError,
      })
      await opts.onEvent?.({
        kind: 'tool_result',
        turn,
        toolUseId: block.id,
        name: block.name,
        resultText: outcome.text,
        isError: outcome.isError,
      })
    }
    return results
  }

  // T1 — the resume path. A checkpoint whose last turn is an assistant message with unanswered
  // tool calls is what parking leaves behind, and it must be answered BEFORE the `while` body ever
  // calls the model again. A gate that is STILL open (a second round, or a partly answered turn)
  // parks again rather than running anything.
  const pending = pendingToolUses(messages)
  if (pending.length > 0) {
    const stillGated = collectGates(pending)
    if (stillGated.length > 0) return await raise(stillGated)
    messages.push({ role: 'user', content: await executeToolUses(pending, turns) })
    await checkpoint()
  }

  while (turns < maxTurns) {
    if (opts.signal?.aborted)
      throw new AiError('unavailable', client.provider, 'Agent run cancelled')
    const injected = await opts.beforeTurn?.(turns + 1)
    for (const message of injected ?? []) {
      if (message.role === 'user' && typeof message.content === 'string') {
        appendUserText(messages, message.content)
      } else {
        messages.push(message)
      }
    }
    turns += 1
    const result = await client.complete({
      model: opts.model,
      maxTokens: opts.maxTokens ?? 4096,
      system: opts.system,
      messages,
      tools: definitions,
      toolChoice: { type: 'auto' },
      signal: opts.signal,
    })
    usage = addUsage(usage, result.usage)
    const toolUses = toolUsesOf(result.content)

    if (opts.onEvent) {
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
    })
    if (opts.onEvent) {
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

    if (toolUses.length === 0) {
      return {
        terminalInput: null,
        terminalTool: null,
        turns,
        stopReason: 'no_tool_call',
        usage,
        messages,
      }
    }

    // The gate: after the assistant turn is on the transcript, before any handler has run.
    const gates = collectGates(toolUses)
    if (gates.length > 0) return await raise(gates)

    messages.push({ role: 'user', content: await executeToolUses(toolUses, turns) })
    await checkpoint()
  }

  return {
    terminalInput: null,
    terminalTool: null,
    turns,
    stopReason: 'max_turns',
    usage,
    messages,
  }
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
  const tools = opts.tools ?? []
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
    // No interrupt gate here, deliberately (T3). Chat has no host that can park a turn — there is
    // no Workflow to unwind and no `agent_runs` row to hold the answer — so a tool raising
    // `InterruptRequested` in a chat is a BUG, and `runHandler` turning it into an `isError` result
    // is what we want to see: a visible wrong answer rather than a stream that never terminates.
    // Chat HITL is Part 3 and arrives as `onInterrupt: 'return'` plus a conversation checkpoint.
    for (const block of toolUses) {
      await opts.onToolStart?.({ toolUseId: block.id, name: block.name, input: block.input })
      const { text, isError } = await runHandler(byName.get(block.name), block.name, block.input)
      toolCalls.push({ id: block.id, name: block.name, input: block.input, result: text, isError })
      results.push({ type: 'tool_result', toolUseId: block.id, content: text, isError })
      await opts.onToolEnd?.({ toolUseId: block.id, name: block.name, result: text, isError })
    }
    messages.push({ role: 'user', content: results })
  }

  return { text: carried.trimEnd(), toolCalls, usage, stopReason: 'max_turns' }
}
