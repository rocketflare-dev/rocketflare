/**
 * Agent runtime contracts (D7, D17): the agent roster, the run lifecycle, the `agent_runs` row the
 * API returns, the request/list/event shapes, and the one example agent's input/output schemas.
 * The server's registry (`apps/web/src/api/services/agents/registry.ts`) attaches a `run()` to
 * each `AgentMeta`; the UI only ever needs what is here. "DB is the truth": progress is durable in
 * `agent_run_events`, the WebSocket carries an `entity.changed { entity: 'agent-run', id }` nudge.
 */
import { z } from 'zod'
import { paginationQuerySchema } from '../pagination'
import { type DeclaredBy, type SHARED_PLUGINS, sharedPlugins } from '../plugins'
import { agentArtifactEventDataSchema, agentArtifactSchema } from './artifacts'
import {
  agentApproversSchema,
  agentInterruptEventDataSchema,
  agentInterruptResolvedEventDataSchema,
  agentRunInterruptSchema,
  jsonSchemaSchema,
  steeringNoteDataSchema,
} from './interrupts'
import { promptKeySchema } from './prompts'

/** Stable identifier for each agent the KIT ships. Append LAST; an app extends this list. */
export const CORE_AGENT_KEYS = ['summarize-text', 'research-topic'] as const

type PluginAgentKey = NonNullable<DeclaredBy<(typeof SHARED_PLUGINS)[number], 'agentKeys'>>[number]

/**
 * Core keys plus every installed plugin's (D31). `z.enum` needs a non-empty tuple and gets one
 * because the kit's own keys lead the list; iterate the widened barrel to build the tail (an EMPTY
 * tuple indexes to `never`, and `never.agentKeys` is a type error), then restore what the tuple
 * says those elements are.
 */
export const AGENT_KEYS = [
  ...CORE_AGENT_KEYS,
  ...(sharedPlugins.flatMap(p => p.agentKeys ?? []) as PluginAgentKey[]),
] as const
export const agentKeySchema = z.enum(AGENT_KEYS)
export type AgentKey = z.infer<typeof agentKeySchema>

/**
 * Per-agent metadata the server registry and the UI share. `inputSchema` validates the request
 * body at the route (BEFORE any row exists); `outputSchema` validates what the run persists.
 * `exclusive` = at most one ACTIVE run per (tenant, agent), where active is
 * {@link ACTIVE_RUN_STATUSES} — `queued`, `running` **and `awaiting_input`**, so a run parked on a
 * question still holds the slot. Enforced by a partial unique index on `agent_runs` whose predicate
 * is rendered from that same list, never by memory. `approvers` is who may answer this agent's
 * interrupts: `'requester'` (the default — whoever can see the run) or `'admin'`.
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
  /**
   * Who may answer this agent's interrupts (issue #17). `'requester'` (the default) is "whoever
   * may cancel this run may answer it" — the SAME rule `visible()` already implements, so there is
   * one mental model rather than two. `'admin'` is the opt-in for agents that touch money,
   * customers or deletion. It is not a new CASL subject: an app wanting approvals on its own axis
   * adds its own subject.
   */
  approvers?: z.infer<typeof agentApproversSchema>
}

/** `GET /api/agents` item — the meta without its zod schemas (not serialisable). */
export const agentInfoSchema = z.object({
  key: agentKeySchema,
  title: z.string(),
  description: z.string(),
  promptKey: promptKeySchema,
  exclusive: z.boolean(),
  approvers: agentApproversSchema.default('requester'),
  /**
   * The agent's `inputSchema` as JSON Schema, produced server-side by `toolInputSchema()`
   * (`services/ai/kit.ts`). Three reasons it is this and not zod: the conversion already exists;
   * it keeps zod off the client, which is what holds the zod-3/zod-4 boundary; and it is the SAME
   * shape `Interrupt.responseSchema` carries, so ONE renderer serves both the run form and the
   * `form` interrupt kind — which is why that kind costs almost nothing.
   */
  inputJsonSchema: jsonSchemaSchema.nullable().optional(),
})
export type AgentInfo = z.infer<typeof agentInfoSchema>

export const agentListResponseSchema = z.object({ items: z.array(agentInfoSchema) })
export type AgentListResponse = z.infer<typeof agentListResponseSchema>

// ---- Run lifecycle -------------------------------------------------------------------------------

/**
 * `queued` = row exists, Workflow instance created, not yet claimed; `running` = claimed by the
 * execute step; `awaiting_input` = parked on a human decision (issue #17), which is a real
 * lifecycle state and not a terminal one. Terminal: `succeeded` / `failed` / `cancelled` (a
 * status, never a message — see 09 §4.1 on why a cancel must not be a `failed` row with prose).
 *
 * Appended LAST because it is a `z.enum` mirrored by a text column.
 */
export const agentRunStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'awaiting_input',
])
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>

/**
 * Statuses that still owe an answer — the exclusive partial unique index, `findActiveRun`,
 * `settle()`, `saveCheckpoint` and {@link isRunActive} all read THIS list. A parked run is still
 * *the* active run for `(tenant, agentKey)`: leave it out and a second enqueue slips past the
 * exclusive guarantee while the first waits on a human.
 */
export const ACTIVE_RUN_STATUSES = ['queued', 'running', 'awaiting_input'] as const

/**
 * Statuses the `claim` step may take over — **narrower than {@link ACTIVE_RUN_STATUSES} on
 * purpose**. A parked row is not claimable: the resolve route flips it back to `running` as part
 * of its compare-and-set BEFORE nudging the instance, so by the time any claim runs the row is
 * `running` again. **The answer is the transition.** Widen this and a restarted instance claims a
 * row nobody has answered.
 */
export const CLAIMABLE_RUN_STATUSES = ['queued', 'running'] as const

/** Whether a run still owes an answer — the ONE predicate for "this agent is busy". */
export const isRunActive = (status: AgentRunStatus): boolean =>
  (ACTIVE_RUN_STATUSES as readonly string[]).includes(status)

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
  'interrupt',
  'interrupt.resolved',
  'steering',
  'artifact',
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

/**
 * The other event payloads, promoted from convention into contract. Until now only `step` had a
 * schema and the UI parsed the rest with local lenient copies (`AgentSteps.tsx`) — a second source
 * of truth waiting to drift, and the timeline is the audit trail for "where did the answer come
 * from?", so drifting silently is exactly the wrong failure.
 *
 * `tool.*` payloads are `.passthrough()` because an agent may attach whatever it likes beside the
 * tool name (`style`, `keyPoints`, `isError`) and the timeline shows it as-is. The NAMED fields are
 * the contract; the rest is detail.
 */
export const agentToolStartEventDataSchema = z
  .object({
    name: z.string(),
    /** The model's arguments. Absent for an agent that only announces the call. */
    input: z.unknown().optional(),
    /**
     * The model's own id for this call, when it has one. The projection pairs `tool.start` with
     * `tool.end` by this when present and falls back to the name — pairing by name alone is wrong
     * the day two calls to the same tool run in one turn.
     */
    toolCallId: z.string().optional(),
  })
  .passthrough()
export type AgentToolStartEventData = z.infer<typeof agentToolStartEventDataSchema>

export const agentToolEndEventDataSchema = z
  .object({
    name: z.string(),
    result: z.unknown().optional(),
    isError: z.boolean().optional(),
    toolCallId: z.string().optional(),
  })
  .passthrough()
export type AgentToolEndEventData = z.infer<typeof agentToolEndEventDataSchema>

export const agentTextEventDataSchema = z.object({ text: z.string() })
export type AgentTextEventData = z.infer<typeof agentTextEventDataSchema>

export const agentStatusEventDataSchema = z
  .object({
    status: z.string(),
    attempt: z.number().int().positive().optional(),
    /** Why, when the status alone does not say it — `'rejected'` for a declined approval. */
    reason: z.string().optional(),
  })
  .passthrough()
export type AgentStatusEventData = z.infer<typeof agentStatusEventDataSchema>

export const agentErrorEventDataSchema = z
  .object({
    message: z.string(),
    attempt: z.number().int().positive().optional(),
    willRetry: z.boolean().optional(),
    /**
     * What the runtime knows and the message cannot hold: the zod issues, or — when a forced tool
     * produced no call — `{ reason, stopReason, text }` with what the model actually said.
     */
    details: z.unknown().optional(),
  })
  .passthrough()
export type AgentErrorEventData = z.infer<typeof agentErrorEventDataSchema>

/**
 * Event type → the schema its `data` parses with. ONE lookup, so the timeline, the AG-UI
 * projection and any app code read the same shapes. `data` stays `z.unknown()` on
 * {@link agentRunEventSchema} deliberately: a row written by a newer server must still list.
 */
export const AGENT_RUN_EVENT_DATA = {
  step: agentStepEventDataSchema,
  'tool.start': agentToolStartEventDataSchema,
  'tool.end': agentToolEndEventDataSchema,
  text: agentTextEventDataSchema,
  status: agentStatusEventDataSchema,
  error: agentErrorEventDataSchema,
  interrupt: agentInterruptEventDataSchema,
  'interrupt.resolved': agentInterruptResolvedEventDataSchema,
  steering: steeringNoteDataSchema,
  artifact: agentArtifactEventDataSchema,
} as const satisfies Record<AgentRunEventType, z.ZodTypeAny>

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
  /** Every ask this run has made, newest last — pending ones are what the action panel draws. */
  interrupts: z.array(agentRunInterruptSchema).default([]),
  /** What the run produced that a person opens, keyed by `key` and upserted as it is redrafted. */
  artifacts: z.array(agentArtifactSchema).default([]),
})
export type AgentRunWithEvents = z.infer<typeof agentRunWithEventsSchema>

// ---- Suspend / resume ----------------------------------------------------------------------------

/**
 * Cloudflare Workflows event type names allow **only letters, digits, `-` and `_`**. A `.` is
 * rejected with `workflow.invalid_event_type`
 * (https://developers.cloudflare.com/workflows/build/events-and-parameters/).
 *
 * This is here rather than only in a test because nothing else would catch a bad name: the Node
 * suite's `createFakeWorkflowStep` never validates it, so a `.` would first surface as *a parked
 * run that can never be resumed*, in production, on the first approval anyone ever gives.
 */
export const WORKFLOW_EVENT_TYPE_PATTERN = /^[A-Za-z0-9_-]{1,100}$/

/**
 * The Workflow event a resolved interrupt sends to wake a parked run.
 *
 * **It is a nudge, not the answer.** The payload carries `{ interruptId }` only and the step
 * re-reads the row: an answer travelling in the event would be a second source of truth that can
 * disagree with the audit row — the same rule the WebSocket hub already follows.
 */
export const AGENT_RESUME_EVENT = 'agent-resume'

/** Most park/resume rounds one run may go through, so a buggy agent cannot grow step state forever. */
export const MAX_INTERRUPT_ROUNDS = 32

// ---- Live run streaming ---------------------------------------------------------------------------

/**
 * `GET /api/agents/runs/:id/agui/stream` tails `agent_run_events` on an open connection. These are
 * PROTOCOL numbers the client agrees with, not `[vars]`: making them configurable would add parity
 * surface and buy nothing, because both ends ship from one tag.
 *
 * The cadence is adaptive because an agent's output is bursty — fast matters just after a row, not
 * during a two-minute model call — and the slowest tick is still below today's 3 s poll, so the
 * stream's worst case beats the poll's best.
 */
export const RUN_STREAM_POLL_MS = 500
/** After this many empty ticks, slow to {@link RUN_STREAM_SLOW_MS}. Any row resets the cadence. */
export const RUN_STREAM_SLOW_AFTER_TICKS = 10
export const RUN_STREAM_SLOW_MS = 1_000
/** After this many empty ticks, slow to {@link RUN_STREAM_IDLE_MS}. */
export const RUN_STREAM_IDLE_AFTER_TICKS = 30
export const RUN_STREAM_IDLE_MS = 2_000
/** Rows one tick may read — bounds its CPU and frame burst; a full page re-loops immediately. */
export const RUN_STREAM_TAIL_LIMIT = 200
/** Comment frame keeping the connection off an idle proxy's timeout. */
export const RUN_STREAM_HEARTBEAT_MS = 15_000
/**
 * Five minutes of complete silence: the run is wedged or inside one very long step, and the
 * connection is better recycled than held. Closes with NO terminal event, which means "reconnect".
 */
export const RUN_STREAM_IDLE_CAP_MS = 300_000
/**
 * Ten minutes, whatever is happening. It keeps the tick count provably under the 1 000-subrequest
 * ceiling, bounds mid-stream session expiry, matches the `execute` step timeout, and — the real
 * reason — **makes a redeploy indistinguishable from the normal path**, so the reconnect is
 * exercised on every stream rather than only during an incident.
 */
export const RUN_STREAM_MAX_MS = 600_000
/**
 * Connections that delivered NOTHING before the client stops reconnecting and falls back to
 * polling `GET /runs/:id/agui`. Three, because one empty connection is a quiet run and two is bad
 * luck; three in a row means the stream is not reaching this browser (a proxy that buffers
 * `text/event-stream`, a corporate middlebox, an exhausted HTTP/1.1 connection pool) and polling —
 * exactly today's behaviour against a different URL — is better than an invisible outage.
 */
export const RUN_STREAM_FALLBACK_ATTEMPTS = 3

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

// ---- The research agent -------------------------------------------------------------------------

/** Longest research question the agent accepts (characters). */
export const RESEARCH_TOPIC_MAX_CHARS = 2_000
/** Most citations an answer may carry — one per document consulted, not per passage. */
export const RESEARCH_TOPIC_MAX_CITATIONS = 20

export const researchTopicInputSchema = z.object({
  topic: z.string().trim().min(1).max(RESEARCH_TOPIC_MAX_CHARS),
})
export type ResearchTopicInput = z.infer<typeof researchTopicInputSchema>

/** A document the answer actually drew on — the id is checked against what search returned. */
export const researchCitationSchema = z.object({
  documentId: z.string().uuid(),
  title: z.string(),
})
export type ResearchCitation = z.infer<typeof researchCitationSchema>

export const researchTopicOutputSchema = z.object({
  /** The answer in Markdown; cites documents by title. */
  answer: z.string().min(1),
  citations: z.array(researchCitationSchema).max(RESEARCH_TOPIC_MAX_CITATIONS),
  /** Model turns the run spent (a run that found nothing still answers, saying so). */
  turns: z.number().int().nonnegative(),
})
export type ResearchTopicOutput = z.infer<typeof researchTopicOutputSchema>
