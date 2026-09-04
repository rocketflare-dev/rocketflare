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
}

/** JSON Schema (draft-07, `$schema` stripped) for a tool input. */
export function toolInputSchema(schema: ZodType): Record<string, unknown> {
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
}

export interface ToolLoopResult {
  /** The terminal tool's validated input, or null if the loop ended without one. */
  terminalInput: unknown | null
  terminalTool: string | null
  turns: number
  stopReason: StopReason | 'max_turns' | 'no_tool_call'
  usage: TokenUsage
  /** The full transcript (seed + assistant/tool turns); also what `onCheckpoint` persists. */
  messages: ChatMessage[]
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
    return { text: err instanceof Error ? err.message : 'Tool execution failed', isError: true }
  }
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

  while (turns < maxTurns) {
    if (opts.signal?.aborted)
      throw new AiError('unavailable', client.provider, 'Agent run cancelled')
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

    const results: ContentBlock[] = []
    for (const block of toolUses) {
      const { text, isError } = await runHandler(byName.get(block.name), block.name, block.input)
      results.push({ type: 'tool_result', toolUseId: block.id, content: text, isError })
      await opts.onEvent?.({
        kind: 'tool_result',
        turn: turns,
        toolUseId: block.id,
        name: block.name,
        resultText: text,
        isError,
      })
    }
    messages.push({ role: 'user', content: results })
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
