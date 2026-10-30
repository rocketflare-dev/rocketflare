/**
 * Agent tools and agents, as a plugin writes them.
 *
 * `AgentCtx` is derived from the core `AgentContext` (`services/agents/registry.ts`) and from
 * what agents demonstrably use, and nothing speculative is added beyond that. It was first widened
 * for a plugin that holds a conversation with a person (`interrupt`, `chatModel`): widen it again
 * when a plugin exists to widen it for.
 *
 * Two core rules carry over and matter more inside a plugin, because a plugin's author is
 * further from the runtime that enforces them:
 *
 * - **A tool is bound to the RUN, never to the model.** The tenant comes from `ctx.scope`, which
 *   the runtime built at EXECUTE time from the run's requester — current membership, not a
 *   snapshot from enqueue. A `tenantId` argument on a tool's input schema is the model choosing its
 *   own tenant, which is the whole game.
 * - **A dead end is still information.** A tool that answers only "nothing found" makes a model
 *   invent. Answer with an `error`/`hint` it can act on, and where it helps, what DOES exist.
 *
 * This module names `services/agents/**` and `services/ai/agent-loop`, which live inside the deletable
 * `feature-agents` surface — the same dependency `plugins/types.ts` already carries and for the
 * same reason: the real types are what make a registration an exhaustiveness check rather than a
 * shape a plugin can get subtly wrong.
 */

import type { AiProvider } from '@rocketflare/shared/ai/config'
import type { AccessScope } from '../../api/services/access-sql'
import type { AgentDecide } from '../../api/services/agents/decisions'
import type {
  AgentContext,
  AgentDefinition,
  AgentInterruptAnswer,
  AgentInterruptAsk,
} from '../../api/services/agents/registry'
import type { AgentToolContext } from '../../api/services/agents/tools'
import type {
  CallStructuredToolOptions,
  RunToolLoopOptions,
  Tool,
  ToolLoopResult,
} from '../../api/services/ai/agent-loop'
import { callStructuredTool, runToolLoop, toolInputSchema } from '../../api/services/ai/agent-loop'
import { AiNotConfiguredError } from '../../api/services/ai/errors'
import { recordUsage } from '../../api/services/ai/usage'
import { tenantFeatures } from '../../api/services/features'
import type { StorageService } from '../../api/services/storage'
import { filesStorage } from './storage'
import type { Database, PluginBindings, PluginConfig } from './types'

export type {
  AgentDecide,
  Decision,
  PickOptions,
  PickResult,
  SiftOptions,
  SiftResult,
} from '../../api/services/agents/decisions'
export type {
  AgentContext,
  AgentDefinition,
  AgentInterruptAnswer,
  AgentInterruptAsk,
} from '../../api/services/agents/registry'
export type { AgentToolContext } from '../../api/services/agents/tools'
export type {
  Tool,
  ToolApproval,
  ToolLoopCheckpoint,
  ToolLoopResult,
} from '../../api/services/ai/agent-loop'
/** A tool whose input schema failed to convert is a tool the model cannot see — fail loudly. */
/** Ledger one model call (`ai_usage`). `feature` is `<plugin id>:<what>` or `agent:<key>`. */
/** 503 `ai_not_configured` — throw it BEFORE any row is written or any stream opens. */
export { AiNotConfiguredError, recordUsage, toolInputSchema }

/**
 * What `ServerPlugin.agentTools(ctx)` is handed, spelled as the plugin surface rather than as the
 * runtime's internal shape.
 *
 * `scope` and not `tenantId`: the scope carries the tenant AND what this particular requester may
 * read. Passing it to a query is how a plugin's tool answers the same rows the person who
 * started the run would see, rather than everything in the organisation.
 */
export interface ToolCtx {
  db: Database
  config: PluginConfig
  env: PluginBindings
  scope: AccessScope
  /** The run's tenant — `scope.tenantId`, surfaced because every query needs it. */
  tenantId: string
  /** The CALLER's budget for one document window, in characters. An agent run's is far larger than a chat turn's. */
  maxDocumentChars?: number
  /**
   * R2 (the `FILES` bucket), or a 503 `storage_not_configured` — the same service every other
   * context's `storage()` returns. Read and write under `tenants/<ctx.tenantId>/<plugin id>/…`;
   * the tenant is the RUN's, never one the model named.
   */
  storage(): StorageService
  /**
   * The feature keys the run's organisation has — what `ctx.features(tenantId)` answers in a job.
   * A plugin whose tool belongs to a flagged surface returns `[]` when the flag is off, so a dark
   * feature costs no prompt tokens and the model never sees a tool it could only fail with.
   */
  features(): Promise<readonly string[]>
}

/** Adapt the runtime's tool context. The only place a plugin's tools name a core internal. */
export function toolCtx(ctx: AgentToolContext): ToolCtx {
  return {
    db: ctx.db,
    config: ctx.cfg,
    env: ctx.env as PluginBindings,
    scope: ctx.scope,
    tenantId: ctx.scope.tenantId,
    ...(ctx.maxDocumentChars !== undefined && { maxDocumentChars: ctx.maxDocumentChars }),
    storage: () => filesStorage(ctx.env as PluginBindings),
    features: () => tenantFeatures(ctx.db, ctx.cfg, ctx.scope.tenantId),
  }
}

/**
 * Declare a tool. A thin helper, and its only job is to be the thing a plugin imports instead of
 * the `Tool` type from a core path — but it is also where the two rules in this file's header can
 * be stated where somebody is looking.
 *
 * A tool with **no handler is TERMINAL**: its validated input is the agent's answer, and the loop
 * stops when the model calls it.
 */
export function defineTool<Input>(tool: Tool<Input>): Tool<Input> {
  return tool
}

/**
 * What a plugin's `run(ctx)` is handed.
 *
 * `toolLoop` and `structured` are methods rather than imports because both need the resolved
 * client, the model and the token ceiling that the RUNTIME chose for this run — per-agent model
 * assignment applies, so an agent that built its own client would quietly ignore the tenant's
 * configuration. They also wire the approval plumbing (`approvals`, `runApproved`) that a gated
 * tool needs and that is easy to forget: without the first an answered gate is asked again, and
 * without the second an approved write repeats on a step retry.
 */
export interface AgentCtx<Input = unknown> {
  db: Database
  config: PluginConfig
  env: PluginBindings
  logger: AgentContext['logger']
  tenantId: string
  runId: string
  /** Who asked; null for a system-triggered run. */
  userId: string | null
  /** Already validated against the agent's own `inputSchema`, twice: at enqueue and before `run()`. */
  input: Input
  /** The built-in knowledge tools plus every installed plugin's, bound to this run's scope. */
  tools: Tool[]
  /**
   * R2 (the `FILES` bucket), or a 503 `storage_not_configured` — the same service every other
   * context's `storage()` returns. Read and write under `tenants/<ctx.tenantId>/<plugin id>/…`. A
   * write is a side effect, so it goes through `once` like any other.
   */
  storage(): StorageService
  /** The system prompt for this agent's `promptKey`, with `appName`/`tenantName` filled in. */
  prompt(vars?: Record<string, string | undefined>): Promise<string>
  /** A durable timeline row. Never throws — progress must not be able to fail a run. */
  step(
    key: string,
    label: string,
    status: 'running' | 'done' | 'error',
    detail?: string
  ): Promise<void>
  /** Throws when the run was asked to stop. Call it between model turns; the loop takes no signal. */
  checkCancelled(): Promise<void>
  /**
   * Run `fn` at most once per `key` across every attempt, replaying its recorded result after.
   *
   * **Anything with a side effect goes through here** — an ingest, a ledger write, an outbound
   * call — because a retry re-enters `run()` from the TOP, and so does a resume after a human
   * answered. `key` is yours and must be stable across attempts. The result is stored as jsonb, so
   * return ids and scalars, never rows.
   */
  once<T>(key: string, fn: () => Promise<T>): Promise<T>
  /**
   * The agentic loop, with this run's client, model, ceiling and approval plumbing already bound.
   */
  toolLoop(options: PluginToolLoopOptions): Promise<ToolLoopResult>
  /** One forced tool call, zod-validated, one retry with the issues fed back. */
  structured<T>(options: PluginStructuredOptions<T>): Promise<T>
  /**
   * Typed questions answered with probabilities: `decide(key, { state, questions })`,
   * `decide.sift(key, …)`, `decide.pick(key, …)`. The tenant's decisions engine answers —
   * TypeSafe's Jev, or the chat model's uncalibrated fallback — and every call is recorded once per
   * `key`, so `key` must be stable across attempts, exactly like `once`.
   */
  decide: AgentDecide
  /**
   * Ask the person a question and park the run until they answer — `approval`,
   * `choice`, `input` or `form`. The SECOND time this line runs (the run resumed after the answer,
   * re-entering `run()` from the top) it returns the answer instead of asking again, which is why
   * **`key` must be stable across attempts**: derive it from a step or a round number your code
   * controls, never from model output that may differ on the replay. Everything after the call is
   * on the far side of a deploy, so a side effect there still goes through `once`.
   *
   * A declined `approval` throws (the run is cancelled); a declined `choice` / `input` / `form` comes
   * back as `status: 'cancelled'` for the agent to handle. Parse `payload` with
   * `interruptPayloadSchema(spec)` from `@rocketflare/shared/ai/interrupts`.
   */
  interrupt(ask: AgentInterruptAsk): Promise<AgentInterruptAnswer>
  /**
   * The provider and model this run resolved to (per-agent `agent_models` assignment applied) —
   * what `recordUsage` needs to ledger a `structured` call's `onUsage`. Read-only: the client
   * itself stays with the runtime.
   */
  readonly chatModel: { readonly provider: AiProvider; readonly model: string }
}

/** `runToolLoop` minus what the runtime supplies. */
export type PluginToolLoopOptions = Omit<
  RunToolLoopOptions,
  'model' | 'maxTokens' | 'approvals' | 'runApproved'
> & { maxTokens?: number }

/** `callStructuredTool` minus what the runtime supplies. */
export type PluginStructuredOptions<T> = Omit<
  CallStructuredToolOptions<T>,
  'model' | 'maxTokens'
> & {
  maxTokens?: number
}

/**
 * Adapt the runtime's `AgentContext`.
 *
 * Note what is NOT forwarded: `chat` (the raw client), `emit` (the untyped event writer), `tracer`
 * and `cfg`. An agent that needs the raw client is an agent doing something the loop does not
 * cover, and that is a conversation to have rather than a field to expose by default.
 */
export function agentCtx<Input>(ctx: AgentContext<Input>): AgentCtx<Input> {
  return {
    db: ctx.db,
    config: ctx.cfg,
    env: ctx.env as PluginBindings,
    logger: ctx.logger,
    tenantId: ctx.tenantId,
    runId: ctx.runId,
    userId: ctx.userId,
    input: ctx.input,
    tools: ctx.tools,
    storage: () => filesStorage(ctx.env as PluginBindings),
    prompt: vars => ctx.prompt(vars),
    step: (key, label, status, detail) => ctx.step(key, label, status, detail),
    checkCancelled: () => ctx.checkCancelled(),
    once: (key, fn) => ctx.once(key, fn),
    decide: ctx.decide,
    interrupt: ask => ctx.interrupt(ask),
    chatModel: { provider: ctx.chat.client.provider, model: ctx.chat.model },
    toolLoop: options =>
      runToolLoop(ctx.chat.client, {
        ...options,
        model: ctx.chat.model,
        maxTokens: options.maxTokens ?? ctx.chat.maxOutputTokens,
        approvals: ctx.approvals,
        runApproved: ctx.once,
      }),
    structured: options =>
      callStructuredTool(ctx.chat.client, {
        ...options,
        model: ctx.chat.model,
        maxTokens: options.maxTokens ?? ctx.chat.maxOutputTokens,
      }),
  }
}

/** A plugin's agent, as `ServerPlugin.agents` takes it. */
export type PluginAgent<Input = unknown, Output = unknown> = AgentDefinition<Input, Output>
