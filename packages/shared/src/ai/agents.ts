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
import { agentDecisionEventDataSchema, agentRunDecisionSchema } from './decisions'
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
export const CORE_AGENT_KEYS = ['summarize-text', 'research-topic', 'triage-research'] as const

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
 * is rendered from that same list, never by memory. `exclusive: false` opts out — the run row
 * holds no slot (`agent_runs.concurrency_key` NULL) and sits outside the index, so any number may
 * be active at once (one person's conversation with an agent, where two people at once is normal).
 * A server caller narrows either kind to one active run per key with
 * `enqueueRun({ concurrencyKey })`. `approvers` is who may answer this agent's
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
  /**
   * D39: what ONE run of this agent may spend, overriding `AGENT_RUN_MAX_TOKENS` /
   * `AGENT_RUN_MAX_COST_USD`. Checked before every model call and decision the run makes; a run
   * over it fails with event code `agent_budget_exceeded`. Decision engines with no price
   * (TypeSafe) count toward `maxTokens` only.
   */
  budget?: AgentBudget
  /**
   * D39: how far ONE run's tool loop may go, and what happens when it runs out. Enforced by
   * `runToolLoop` when the agent passes it (`policy: meta.policy`); `AGENT_MAX_TURNS` stays the
   * ceiling a policy cannot raise. Absent, a loop behaves exactly as before: it stops at the turn
   * cap and hands back no answer.
   */
  policy?: AgentPolicy
}

/** D39: a per-run spending cap. Either side may be absent — the deployment's default applies. */
export interface AgentBudget {
  maxTokens?: number
  maxCostUsd?: number
}

export const AGENT_EXHAUSTION_MODES = ['final-answer', 'fail'] as const
export type AgentExhaustionMode = (typeof AGENT_EXHAUSTION_MODES)[number]

/**
 * D39: a tool loop's limits, every one counted across ALL attempts of the run — the turns and
 * the active time ride the checkpoint, the tool calls and the failures are read back out of the
 * transcript — so a retried step never gets a fresh allowance. Time spent parked on a person is
 * not active time.
 *
 * `onExhaustion` decides what running out means. `'final-answer'` (the default) makes ONE forced
 * call to the loop's terminal tool over the transcript so far — the salvage `research-topic` used
 * to carry by hand — and fails the run when that call fails. `'fail'` fails the run straight away.
 */
export const agentPolicySchema = z.object({
  /** Model turns. Clamped to `AGENT_MAX_TURNS`. */
  maxTurns: z.number().int().positive().optional(),
  /** Tool calls executed (the terminal tool's call is the answer, not one of these). */
  maxToolCalls: z.number().int().positive().optional(),
  /** Maximum number of tool calls to execute concurrently in one turn. Defaults to 4. */
  maxConcurrentToolCalls: z.number().int().positive().optional(),
  /** Seconds of active loop time. */
  maxDurationSeconds: z.number().positive().optional(),
  /** Consecutive tool calls that came back as errors. A success resets the count. */
  repeatedFailureLimit: z.number().int().positive().optional(),
  onExhaustion: z.enum(AGENT_EXHAUSTION_MODES).optional(),
})
export type AgentPolicy = z.infer<typeof agentPolicySchema>

/** `GET /api/agents` item — the meta without its zod schemas (not serialisable). */
export const agentInfoSchema = z.object({
  key: agentKeySchema,
  title: z.string(),
  description: z.string(),
  promptKey: promptKeySchema,
  exclusive: z.boolean(),
  approvers: agentApproversSchema.default('requester'),
  /** D39: the agent's tool-loop policy, when it declares one — the Agents page shows it. */
  policy: agentPolicySchema.optional(),
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
  /**
   * D39: whether this run held its agent's exclusive slot — copied from `meta.exclusive` at enqueue,
   * so the database predicate does not depend on the code that is deployed today. Defaulted for a
   * response from a server older than D39.
   */
  exclusive: z.boolean().default(true),
  /** D39: the `POST /runs/batch` call that created this run; null for a single enqueue. */
  batchId: z.string().uuid().nullable().default(null),
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
  /** D39: only the runs one batch created. */
  batchId: z.string().uuid().optional(),
})
export type AgentRunListQuery = z.infer<typeof agentRunListQuerySchema>

/** `input` is validated a second time against the agent's own `inputSchema` in the service. */
export const createAgentRunRequestSchema = z.object({
  agentKey: agentKeySchema,
  input: z.unknown(),
})
export type CreateAgentRunRequest = z.infer<typeof createAgentRunRequestSchema>

// ---- Batch enqueue (D39) -------------------------------------------------------------------------

/** Most inputs one `POST /api/agents/runs/batch` takes — the Workflows `createBatch` ceiling. */
export const AGENT_RUN_BATCH_MAX = 100

/**
 * `POST /api/agents/runs/batch`: many runs of ONE non-exclusive agent in one request, and one
 * `AGENT_RUN_WORKFLOW.createBatch()` call. Each input is validated against the agent's own
 * `inputSchema` in the service, item by item — an invalid one is reported, the rest still run.
 */
export const createAgentRunBatchRequestSchema = z.object({
  agentKey: agentKeySchema,
  inputs: z.array(z.unknown()).min(1).max(AGENT_RUN_BATCH_MAX),
})
export type CreateAgentRunBatchRequest = z.infer<typeof createAgentRunBatchRequestSchema>

/**
 * One input's fate, at its `index` in the request. `run` is set whenever a row exists — including
 * a row whose Workflow instance could not be created, which is settled `failed` and carries the
 * error too. `run: null` means the input never became a row (it did not validate).
 */
export const agentRunBatchItemSchema = z.object({
  index: z.number().int().nonnegative(),
  run: agentRunSchema.nullable(),
  error: z
    .object({ code: z.string(), message: z.string(), details: z.unknown().optional() })
    .nullable(),
})
export type AgentRunBatchItem = z.infer<typeof agentRunBatchItemSchema>

/** 202. `created` counts runs that are queued; `failed` counts every item with an `error`. */
export const createAgentRunBatchResponseSchema = z.object({
  batchId: z.string().uuid(),
  agentKey: agentKeySchema,
  created: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  items: z.array(agentRunBatchItemSchema),
})
export type CreateAgentRunBatchResponse = z.infer<typeof createAgentRunBatchResponseSchema>

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
  'decision',
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
    outcome: z.enum(['success', 'error', 'unknown']).or(z.string()).optional(),
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
    /** A machine-readable reason, when there is one — `agent_budget_exceeded` (D39). */
    code: z.string().optional(),
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
  decision: agentDecisionEventDataSchema,
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
  /** Every typed question the run asked (D37) — answers, probabilities, the engine that gave them. */
  decisions: z.array(agentRunDecisionSchema).default([]),
  /** D39: what the run spent, every attempt included — its `ai_usage` rows, summed. */
  usage: z
    .object({
      calls: z.number().int().nonnegative(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      /** Priced calls only, in microcents (1e-8 USD); an unpriced call counts in the tokens alone. */
      costMicrocents: z.number().int().nonnegative(),
    })
    .optional(),
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

// ---- The decisions example agent (D37) ----------------------------------------------------------

/** Longest question `triage-research` accepts (characters). */
export const TRIAGE_RESEARCH_MAX_CHARS = 2_000

export const triageResearchInputSchema = z.object({
  question: z.string().trim().min(1).max(TRIAGE_RESEARCH_MAX_CHARS),
})
export type TriageResearchInput = z.infer<typeof triageResearchInputSchema>

/**
 * How the run ended. `answered` = the screened passages were enough; `not_covered` = they
 * confidently were not (an honest "the knowledge base does not say"); `escalated` = no question
 * could settle it, so the full `research-topic` loop answered instead.
 */
export const TRIAGE_ROUTES = ['answered', 'not_covered', 'escalated'] as const

export const triageResearchOutputSchema = z.object({
  answer: z.string().min(1),
  citations: z.array(researchCitationSchema).max(RESEARCH_TOPIC_MAX_CITATIONS),
  route: z.enum(TRIAGE_ROUTES),
  /** Passages search returned, and how many the relevance screen kept. */
  screened: z.number().int().nonnegative(),
  kept: z.number().int().nonnegative(),
})
export type TriageResearchOutput = z.infer<typeof triageResearchOutputSchema>
