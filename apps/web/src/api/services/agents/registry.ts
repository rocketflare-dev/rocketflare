/**
 * The agent registry (D7, D17): `AGENTS` maps every `AgentKey` to a definition = the shared
 * `AgentMeta` (key, title, schemas, promptKey, exclusive) + a server-side `run(ctx)`. The runtime
 * (`runtime.ts`, driven by `workflows/agent-run.ts`) owns the lifecycle — claim, trace, client,
 * cancellation, persistence, events — so an agent is a declarative meta and one async function that
 * reads `ctx.input`, calls the model through `ctx.chat` (with `ctx.tools` — the knowledge base is
 * available to every agent through `search_knowledge`), emits progress and returns its output.
 * Adding an agent = a key in `@rocketflare/shared/ai/agents`, a prompt in `services/prompts.ts`, a file in
 * `examples/` and one entry here. No migration.
 */
import type {
  AgentInfo,
  AgentKey,
  AgentMeta,
  AgentRunEventType,
} from '@rocketflare/shared/ai/agents'
import type { AgentArtifact, AgentArtifactInput } from '@rocketflare/shared/ai/artifacts'
import type { AgentInterruptSpec, AgentSteeringNote } from '@rocketflare/shared/ai/interrupts'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { serverPlugins } from '../../../plugins/server'
import type { Tracer } from '../../observability/tracer'
import type { Logger } from '../../utils/core/logger'
import { type Tool, type ToolApproval, type ToolLoopCheckpoint, toolInputSchema } from '../ai/kit'
import type { AiEnv, ChatClient } from '../ai/types'
import type { JobsQueue } from '../jobs'
import type { RegistryPromptKey } from '../prompts'
import type { MeteredCall } from './budget'
import type { AgentDecide } from './decisions'
import { researchTopicAgent } from './examples/research-topic'
import { summarizeTextAgent } from './examples/summarize-text'
import { triageResearchAgent } from './examples/triage-research'
import type { MapOptions } from './fanout'
import type { ReconciledToolOutcome } from './runs'

/** Emitted by the run into `agent_run_events` (and nudged to viewers). */
export interface AgentEvent {
  type: AgentRunEventType
  data: unknown
}

/** The bindings a run may touch — structural slices, so tests hand in stubs. */
export interface AgentRunEnv {
  AI?: AiEnv['AI']
  JOBS_QUEUE?: JobsQueue | null
}

/** What an agent asks a person through {@link AgentContext.interrupt}. */
export interface AgentInterruptAsk {
  /**
   * **Yours, and it must be stable across attempts.** A resumed or retried `execute` step
   * re-enters `run()` from the TOP and reaches this call again; `(run_id, key)` is what makes the
   * second call find the ANSWER rather than opening a second question (T2). Derive it from
   * something durable — the entity id, the step name — never from a counter or `Date.now()`.
   */
  key: string
  /** What is being asked, in the shape the panel needs to draw it. */
  spec: AgentInterruptSpec
  /** The tool call this ask gates, when it gates one. Set by the tool loop, rarely by an agent. */
  toolCallId?: string
}

/**
 * The answer. `status` is AG-UI's own `ResumeEntry` vocabulary and there is deliberately no
 * `approved` boolean: two ways to say no is how a UI and a server end up disagreeing.
 *
 * A `cancelled` answer only ever REACHES an agent for a kind whose rejection means "tell the
 * model" — `choice`, `input`, `form`. A declined `approval` throws `InterruptDeclinedError`
 * instead, because a person saying no to an action means stop.
 */
export interface AgentInterruptAnswer {
  interruptId: string
  status: 'resolved' | 'cancelled'
  /** Validated against `interruptPayloadSchema(spec)` at the route — parse it with the same schema. */
  payload: unknown
  resolvedByUserId: string | null
}

/** How a replay (D38) treats one `ctx.once` — see {@link AgentContext.once}. */
export interface OnceOptions {
  /**
   * `'serve'` (default) — hand back the recording; `'rerun'` — a live replay calls `fn` again (a
   * pure model call); `'inner'` — every replay calls `fn` again and serves what is recorded INSIDE
   * it. `'inner'` is for a `once` that only memoises other recorded calls — `ctx.map`'s items.
   */
  replay?: 'serve' | 'rerun' | 'inner'
}

/** What `run()` receives. Never carries a client-supplied tenant id. */
export interface AgentContext<Input = unknown> {
  db: Database
  cfg: AppConfig
  env: AgentRunEnv
  logger: Logger
  tracer: Tracer
  tenantId: string
  runId: string
  /** Who asked (attached to usage and the trace); null for a system-triggered run. */
  userId: string | null
  /** Validated against `meta.inputSchema` at enqueue AND before `run()`. */
  input: Input
  /** Append a durable progress event (+ realtime nudge). Never throws. */
  emit(event: AgentEvent): Promise<void>
  /** Throws `AgentCancelledError` when the run was asked to stop — call between model turns. */
  checkCancelled(): Promise<void>
  /** The resolved (traced) client for `meta.promptKey` and the model/max_tokens to pass it. */
  chat: { client: ChatClient; model: string; maxOutputTokens: number }
  /**
   * The kit's built-in tools, tenant-scoped to this run (`tools/`: `search_knowledge` over
   * everything indexed in the knowledge base, `get_document` to read one in full or by window).
   * Hand them to `runToolLoop` alongside the agent's own tools; a forced single-tool agent may
   * ignore them.
   */
  tools: Tool[]
  /**
   * The tool loop's resume point for THIS run. Pass `load()`'s result to `runToolLoop` as `resume`
   * and `save` as `onCheckpoint`, and a retried `execute` step continues the conversation instead of
   * replaying every turn from the seed. `load()` returns null when there is nothing to resume — a
   * first attempt, or a stored value that no longer parses (which starts fresh, never fails).
   */
  checkpoint: {
    load(): Promise<ToolLoopCheckpoint | null>
    save(checkpoint: ToolLoopCheckpoint): Promise<void>
  }
  /**
   * Run `fn` at most once per `key` across every attempt of this run, replaying its recorded result
   * afterwards. **Anything with a side effect the run must not repeat goes through here** — an
   * ingest, a ledger write, an outbound call — because an `execute` retry re-enters `run()` from the
   * top. `key` is yours and must be stable across attempts. The result is stored as jsonb: return
   * ids and scalars, not rows. At-least-once with a recorded result, not exactly-once.
   *
   * `options.replay` matters only to a REPLAY of the run (D38, `agent:replay`), never to the run
   * itself: `'rerun'` marks `fn` as a pure model call a live replay may make again — so a changed
   * prompt shows up as a changed answer — where the default `'serve'` hands back the recording,
   * because `fn` may have a side effect.
   */
  once<T>(key: string, fn: () => Promise<T>, options?: OnceOptions): Promise<T>
  /**
   * Ask a person, and suspend the run until they answer (issue #17).
   *
   * Three things are true of every call and each one has bitten somebody:
   *
   * 1. **`key` is yours and must be stable across attempts.** A resumed `execute` re-enters
   *    `run()` from the top and reaches this line again; `UNIQUE (run_id, key)` is what makes the
   *    second call find the answer instead of asking again, forever (T2).
   * 2. **Everything after this call is on the far side of a Worker deploy.** The run may resume
   *    days later, in a different isolate, on different code. Anything with a side effect goes
   *    behind {@link AgentContext.once}, exactly as it would after any retry.
   * 3. **Rejection differs by kind.** An `approval` that is declined throws
   *    `InterruptDeclinedError` and settles the run `cancelled`; `choice` / `input` / `form`
   *    resolve normally with `{ status: 'cancelled' }`, because declining to answer is an answer.
   *
   * The first call raises `InterruptRequested`, which the runtime turns into a row and a parked
   * run — so it does not return on that attempt at all.
   */
  interrupt(ask: AgentInterruptAsk): Promise<AgentInterruptAnswer>
  /**
   * Notes a person has sent to this run and that this run has not seen yet — delivered **exactly
   * once** across every attempt (`agent_run_effects`, keyed by the note's event id), so a step
   * retry never replays them. Feed them to the model through `runToolLoop`'s `beforeTurn`, which
   * folds them in with `appendUserText` rather than opening a second consecutive user turn.
   */
  steering(): Promise<AgentSteeringNote[]>
  /**
   * Record something the run PRODUCED that a person opens — a draft, a table, the document it
   * wrote. `key` is the UPSERT key, so a redrafted artifact replaces itself instead of piling up.
   * Safe to call again on a retry for that reason; it also writes a thin `artifact` event so the
   * timeline says where it appeared.
   */
  artifact(input: AgentArtifactInput): Promise<AgentArtifact>
  /**
   * Answers to this run's gated TOOL calls, keyed by `toolCallId` — hand it to `runToolLoop` as
   * `approvals`. **Built by the runtime; an agent never queries for it and never assembles it**,
   * which is what keeps one set of approval rules in one place.
   */
  approvals: ReadonlyMap<string, ToolApproval>
  /**
   * Pre-reconciled tool outcomes for this attempt (issue #5). Built by the runtime;
   * hand it to `runToolLoop` as `reconciledTools`.
   */
  reconciledTools?: ReadonlyMap<string, ReconciledToolOutcome>
  /**
   * Ask typed questions about a state and get probabilities back (D37) — `ctx.decide(key, { state,
   * questions })`, or the shapes `ctx.decide.sift(key, …)` (the same yes/no of every item, one
   * request) and `ctx.decide.pick(key, …)` (one item, or none). Answered by the tenant's decisions
   * engine — TypeSafe's Jev when configured, else the chat model (`llm_self_report`, uncalibrated)
   * — and recorded in `agent_run_decisions`.
   *
   * **`key` is yours and must be stable across attempts**, exactly like `once` and `interrupt`: a
   * re-entered `run()` gets the RECORDED answer back, so the run takes the branch it took before.
   * Re-using a key with different questions throws. The rule the API is shaped around: a question
   * decides what a thing IS; your code decides what follows — the threshold is a number here.
   */
  decide: AgentDecide
  /**
   * `resolvePrompt(meta.promptKey, vars)` with `appName`/`tenantName` pre-filled. `promptKey`
   * names ANOTHER registry entry — for an agent that hands a case to a second agent's body (the
   * `triage-research` escalation runs `research-topic` on its own prompt).
   */
  prompt(vars?: Record<string, string | undefined>, promptKey?: RegistryPromptKey): Promise<string>
  /** Shortcut for a `step` event: `step('summarize', 'Summarising', 'running')`. */
  step(
    key: string,
    label: string,
    status: 'running' | 'done' | 'error',
    detail?: string
  ): Promise<void>
  /**
   * This context with every keyed primitive — `once`, `decide`, `interrupt`, `artifact`, `step` —
   * namespaced under `prefix` (D39), so the same code can run for many items without their keys
   * colliding. Scopes nest. A scope has no checkpoint (a tool loop inside one restarts on a retry).
   */
  scope(prefix: string): AgentContext<Input>
  /**
   * Run `fn` over `items`, a few at a time (D39, `fanout.ts`): each item is a `once` keyed
   * `key[index]` (or `key[keyOf(item)]`) and gets its own `scope`, so a retried step replays the
   * items that finished and runs only the rest. Concurrency is `min(options.concurrency ?? 4, 6)`.
   * The first error stops scheduling; asks from several items become ONE park. `fn`'s result is
   * stored as jsonb — return ids and scalars. Freeze the item list (`once`) before mapping it.
   */
  map<T, R>(
    key: string,
    items: readonly T[],
    fn: (item: T, ctx: AgentContext<Input>) => Promise<R>,
    options?: MapOptions<T>
  ): Promise<R[]>
  /**
   * Ledger a model call that did NOT go through `ctx.chat.client` or `ctx.decide` — a client of
   * the agent's own (D39). One `ai_usage` row carrying this run's id, counted toward its budget.
   * Calls through `ctx.chat.client` and `ctx.decide` are metered already: never record those.
   */
  recordUsage(call: MeteredCall): Promise<void>
}

export interface AgentDefinition<Input = unknown, Output = unknown> {
  meta: AgentMeta<Input, Output>
  run(ctx: AgentContext<Input>): Promise<Output>
}

// biome-ignore lint/suspicious/noExplicitAny: the catalog mixes agent input/output types.
export type AnyAgentDefinition = AgentDefinition<any, any>

/** The kit's own agents. A plugin adds its own through `ServerPlugin.agents`. */
const CORE_AGENTS = {
  'summarize-text': summarizeTextAgent,
  'research-topic': researchTopicAgent,
  'triage-research': triageResearchAgent,
} satisfies Record<string, AnyAgentDefinition>

/**
 * Core plus every installed plugin's (D31). `AGENT_KEYS` already carries a plugin's keys, and the
 * plugin's own `agents` is checked against the keys IT declared — so the only thing this merge
 * asserts is that the two halves together cover the union.
 */
export const AGENTS = {
  ...CORE_AGENTS,
  ...(Object.assign({}, ...serverPlugins.map(p => p.agents ?? {})) as Record<
    string,
    AnyAgentDefinition
  >),
} as Record<AgentKey, AnyAgentDefinition>

export function getAgent(key: AgentKey): AnyAgentDefinition {
  return AGENTS[key]
}

export function isAgentKey(key: string): key is AgentKey {
  return Object.hasOwn(AGENTS, key)
}

/**
 * `GET /api/agents` — the metas without their zod schemas, which are not serialisable.
 *
 * **`inputJsonSchema` is the zod schema converted once** by the same `toolInputSchema()` the tool
 * loop uses, so there is one conversion in the repo rather than two that can disagree. It is what
 * lets the UI label a run's input (`summariseInput`) and build a form for an agent with no
 * hand-written one (`formFor`'s middle rung) — both of which read this field and nothing else, so
 * omitting it does not fail, it silently degrades to a JSON box.
 *
 * Built once per isolate: `AGENTS` is a module constant, so the conversion cannot change between
 * requests and a Worker should not pay for it on each one.
 */
let agentInfoCache: AgentInfo[] | null = null

export function listAgentInfo(): AgentInfo[] {
  agentInfoCache ??= Object.values(AGENTS).map(a => ({
    key: a.meta.key,
    title: a.meta.title,
    description: a.meta.description,
    promptKey: a.meta.promptKey,
    exclusive: a.meta.exclusive,
    approvers: a.meta.approvers ?? 'requester',
    ...(a.meta.policy ? { policy: a.meta.policy } : {}),
    inputJsonSchema: toolInputSchema(a.meta.inputSchema),
  }))
  return agentInfoCache
}
