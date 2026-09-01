/**
 * Agent runtime contracts (D7, D17): the agent roster, the run lifecycle, the `agent_runs` row the
 * API returns, the request/list/event shapes, and the one example agent's input/output schemas.
 * The server's registry (`apps/web/src/api/services/agents/registry.ts`) attaches a `run()` to
 * each `AgentMeta`; the UI only ever needs what is here. "DB is the truth": progress is durable in
 * `agent_run_events`, the WebSocket carries an `entity.changed { entity: 'agent-run', id }` nudge.
 */
import { z } from 'zod'
import { paginationQuerySchema } from '../pagination'
import { promptKeySchema } from './prompts'

/** Stable identifier for each agent the runtime knows. Append LAST; an app extends this list. */
export const AGENT_KEYS = ['summarize-text'] as const
export const agentKeySchema = z.enum(AGENT_KEYS)
export type AgentKey = z.infer<typeof agentKeySchema>

/**
 * Per-agent metadata the server registry and the UI share. `inputSchema` validates the request
 * body at the route (BEFORE any row exists); `outputSchema` validates what the run persists.
 * `exclusive` = at most one queued-or-running run per (tenant, agent) — enforced by a partial
 * unique index on `agent_runs`, never by memory.
 */
export interface AgentMeta<Input = unknown, Output = unknown> {
  key: AgentKey
  title: string
  description: string
  /** Output type `Input` — the raw (`unknown`) side may carry defaults/coercions. */
  inputSchema: z.ZodType<Input, z.ZodTypeDef, unknown>
  outputSchema: z.ZodType<Output, z.ZodTypeDef, unknown>
  /** Registry prompt (and `agent_models` assignment key) the agent runs with. */
  promptKey: z.infer<typeof promptKeySchema>
  exclusive: boolean
}

/** `GET /api/agents` item — the meta without its zod schemas (not serialisable). */
export const agentInfoSchema = z.object({
  key: agentKeySchema,
  title: z.string(),
  description: z.string(),
  promptKey: promptKeySchema,
  exclusive: z.boolean(),
})
export type AgentInfo = z.infer<typeof agentInfoSchema>

export const agentListResponseSchema = z.object({ items: z.array(agentInfoSchema) })
export type AgentListResponse = z.infer<typeof agentListResponseSchema>

// ---- Run lifecycle -------------------------------------------------------------------------------

/**
 * `queued` = row exists, Workflow instance created, not yet claimed; `running` = claimed by the
 * execute step. Terminal: `succeeded` / `failed` / `cancelled` (a status, never a message — see
 * 09 §4.1 on why a cancel must not be a `failed` row with prose).
 */
export const agentRunStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
])
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>

/** Whether a run still owes an answer — the ONE predicate for "this agent is busy". */
export const isRunActive = (status: AgentRunStatus): boolean =>
  status === 'queued' || status === 'running'

export const agentRunSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  agentKey: agentKeySchema,
  status: agentRunStatusSchema,
  input: z.unknown(),
  output: z.unknown().nullable(),
  error: z.string().nullable(),
  requestedByUserId: z.string().uuid().nullable(),
  /** The Workflow instance id (= run id). Null only for a row created outside the runtime. */
  instanceId: z.string().nullable(),
  /** Execute attempts started (1 on the first try; a Workflow step retry re-claims and bumps it). */
  attempt: z.number().int().nonnegative(),
  startedAt: z.coerce.date().nullable(),
  finishedAt: z.coerce.date().nullable(),
  cancelRequestedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
})
export type AgentRun = z.infer<typeof agentRunSchema>

/** `POST /api/agents/runs` → 202. `deduplicated` = an active run already existed (exclusive). */
export const createAgentRunResponseSchema = agentRunSchema.extend({
  deduplicated: z.boolean().optional(),
})
export type CreateAgentRunResponse = z.infer<typeof createAgentRunResponseSchema>

export const agentRunListQuerySchema = paginationQuerySchema.extend({
  agentKey: agentKeySchema.optional(),
  status: agentRunStatusSchema.optional(),
})
export type AgentRunListQuery = z.infer<typeof agentRunListQuerySchema>

/** `input` is validated a second time against the agent's own `inputSchema` in the service. */
export const createAgentRunRequestSchema = z.object({
  agentKey: agentKeySchema,
  input: z.unknown(),
})
export type CreateAgentRunRequest = z.infer<typeof createAgentRunRequestSchema>

// ---- Events ---------------------------------------------------------------------------------------

export const AGENT_RUN_EVENT_TYPES = [
  'step',
  'tool.start',
  'tool.end',
  'text',
  'status',
  'error',
] as const
export const agentRunEventTypeSchema = z.enum(AGENT_RUN_EVENT_TYPES)
export type AgentRunEventType = z.infer<typeof agentRunEventTypeSchema>

/** `step` payload: a coarse stage row (`done` updates the row announced by `running`). */
export const agentStepEventDataSchema = z.object({
  key: z.string(),
  label: z.string(),
  status: z.enum(['running', 'done', 'error']),
  detail: z.string().optional(),
})
export type AgentStepEventData = z.infer<typeof agentStepEventDataSchema>

export const agentRunEventSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  /** Position within the run's stream, from 1; a retried attempt continues the numbering. */
  seq: z.number().int().positive(),
  type: agentRunEventTypeSchema,
  data: z.unknown(),
  at: z.coerce.date(),
})
export type AgentRunEvent = z.infer<typeof agentRunEventSchema>

export const agentRunWithEventsSchema = agentRunSchema.extend({
  events: z.array(agentRunEventSchema),
})
export type AgentRunWithEvents = z.infer<typeof agentRunWithEventsSchema>

// ---- The example agent --------------------------------------------------------------------------

/** Longest text the example agent accepts (characters). */
export const SUMMARIZE_TEXT_MAX_CHARS = 20_000

export const summarizeTextInputSchema = z.object({
  text: z.string().trim().min(1).max(SUMMARIZE_TEXT_MAX_CHARS),
  style: z.enum(['bullets', 'paragraph']).default('bullets'),
  /** Also store the summary as a searchable document (`documents`/`chunks`) via `ingestText`. */
  index: z.boolean().default(false),
})
export type SummarizeTextInput = z.infer<typeof summarizeTextInputSchema>

export const summarizeTextOutputSchema = z.object({
  summary: z.string().min(1),
  keyPoints: z.array(z.string().min(1)).max(20),
  /** Set when `input.index` was true — the `documents` row holding the summary. */
  documentId: z.string().uuid().optional(),
})
export type SummarizeTextOutput = z.infer<typeof summarizeTextOutputSchema>
