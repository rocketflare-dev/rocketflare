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
import type { AgentKey, AgentMeta, AgentRunEventType } from '@rocketflare/shared/ai/agents'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import type { Tracer } from '../../observability/tracer'
import type { AppBindings } from '../../types'
import type { Logger } from '../../utils/core/logger'
import type { Tool } from '../ai/kit'
import type { ChatClient } from '../ai/types'
import type { JobsQueue } from '../jobs'
import { researchTopicAgent } from './examples/research-topic'
import { summarizeTextAgent } from './examples/summarize-text'

/** Emitted by the run into `agent_run_events` (and nudged to viewers). */
export interface AgentEvent {
  type: AgentRunEventType
  data: unknown
}

/** The bindings a run may touch — structural slices, so tests hand in stubs. */
export interface AgentRunEnv {
  AI?: AppBindings['AI']
  JOBS_QUEUE?: JobsQueue | null
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
  /** `resolvePrompt(meta.promptKey, vars)` with `appName`/`tenantName` pre-filled. */
  prompt(vars?: Record<string, string | undefined>): Promise<string>
  /** Shortcut for a `step` event: `step('summarize', 'Summarising', 'running')`. */
  step(
    key: string,
    label: string,
    status: 'running' | 'done' | 'error',
    detail?: string
  ): Promise<void>
}

export interface AgentDefinition<Input = unknown, Output = unknown> {
  meta: AgentMeta<Input, Output>
  run(ctx: AgentContext<Input>): Promise<Output>
}

// biome-ignore lint/suspicious/noExplicitAny: the catalog mixes agent input/output types.
export type AnyAgentDefinition = AgentDefinition<any, any>

export const AGENTS: Record<AgentKey, AnyAgentDefinition> = {
  'summarize-text': summarizeTextAgent,
  'research-topic': researchTopicAgent,
}

export function getAgent(key: AgentKey): AnyAgentDefinition {
  return AGENTS[key]
}

export function isAgentKey(key: string): key is AgentKey {
  return Object.hasOwn(AGENTS, key)
}

/** `GET /api/agents` — the metas without their zod schemas. */
export function listAgentInfo() {
  return Object.values(AGENTS).map(a => ({
    key: a.meta.key,
    title: a.meta.title,
    description: a.meta.description,
    promptKey: a.meta.promptKey,
    exclusive: a.meta.exclusive,
  }))
}
