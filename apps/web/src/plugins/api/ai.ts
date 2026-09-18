/**
 * Agent tools and agents, as a plugin writes them (D7, D17, D31).
 *
 * **Half of this is unexercised.** `ToolCtx` is real — the reference plugin contributes a tool to
 * every agent run — but `AgentCtx` is not: neither plugin that existed when this was written
 * registers an AGENT. So `AgentCtx` is derived from the kit's own `AgentContext`
 * (`services/agents/registry.ts`) and from what its two example agents demonstrably use, and
 * nothing speculative is added beyond that. Widen it when a plugin exists to widen it for.
 *
 * Two rules carry over from the kit and matter more inside a plugin, because a plugin's author is
 * further from the runtime that enforces them:
 *
 * - **A tool is bound to the RUN, never to the model.** The tenant comes from `ctx.scope`, which
 *   the runtime built at EXECUTE time from the run's requester — current membership, not a
 *   snapshot from enqueue. A `tenantId` argument on a tool's input schema is the model choosing its
 *   own tenant, which is the whole game.
 * - **A dead end is still information.** A tool that answers only "nothing found" makes a model
 *   invent. Answer with an `error`/`hint` it can act on, and where it helps, what DOES exist.
 *
 * This module names `services/agents/**` and `services/ai/kit`, which live inside the deletable
 * `feature-agents` surface — the same dependency `plugins/types.ts` already carries and for the
 * same reason: the real types are what make a registration an exhaustiveness check rather than a
 * shape a plugin can get subtly wrong.
 */

import type { AccessScope } from '../../api/services/access-sql'
import type { AgentContext, AgentDefinition } from '../../api/services/agents/registry'
import type { AgentToolContext } from '../../api/services/agents/tools'
import { AiNotConfiguredError } from '../../api/services/ai/errors'
import type {
  CallStructuredToolOptions,
  RunToolLoopOptions,
  Tool,
  ToolLoopResult,
} from '../../api/services/ai/kit'
import { callStructuredTool, runToolLoop, toolInputSchema } from '../../api/services/ai/kit'
import { recordUsage } from '../../api/services/ai/usage'
import type { Database, PluginBindings, PluginConfig } from './types'

export type { AgentContext, AgentDefinition } from '../../api/services/agents/registry'
export type { AgentToolContext } from '../../api/services/agents/tools'
export type {
  Tool,
  ToolApproval,
  ToolLoopCheckpoint,
  ToolLoopResult,
} from '../../api/services/ai/kit'
/** A tool whose input schema failed to convert is a tool the model cannot see — fail loudly. */
/** Ledger one model call (`ai_usage`). `feature` is `<plugin id>:<what>` or `agent:<key>`. */
/** 503 `ai_not_configured` — throw it BEFORE any row is written or any stream opens. */
export { AiNotConfiguredError, recordUsage, toolInputSchema }

/**
 * What `ServerPlugin.agentTools(ctx)` is handed, spelled as the plugin surface rather than as the
 * runtime's internal shape.
 *
 * `scope` and not `tenantId`: the scope carries the tenant AND what this particular requester may
 * read (D29). Passing it to a query is how a plugin's tool answers the same rows the person who
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
}

/** Adapt the runtime's tool context. The only place a plugin's tools name a kit internal. */
export function toolCtx(ctx: AgentToolContext): ToolCtx {
  return {
    db: ctx.db,
    config: ctx.cfg,
    env: ctx.env as PluginBindings,
    scope: ctx.scope,
    tenantId: ctx.scope.tenantId,
    ...(ctx.maxDocumentChars !== undefined && { maxDocumentChars: ctx.maxDocumentChars }),
  }
}

/**
 * Declare a tool. A thin helper, and its only job is to be the thing a plugin imports instead of
 * the `Tool` type from a kit path — but it is also where the two rules in this file's header can
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
  /** The kit's knowledge tools plus every installed plugin's, bound to this run's scope. */
  tools: Tool[]
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
    prompt: vars => ctx.prompt(vars),
    step: (key, label, status, detail) => ctx.step(key, label, status, detail),
    checkCancelled: () => ctx.checkCancelled(),
    once: (key, fn) => ctx.once(key, fn),
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
