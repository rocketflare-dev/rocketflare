/**
 * Eval and feedback contracts (D33). Three things share this file because they are one loop:
 *
 * - **`EvalCase`** — one line of a dataset (`apps/evals/datasets/<name>.jsonl`): the input a target
 *   is driven with, the context it may retrieve, and what "good" means (an expected output, a
 *   rubric, the tools it should call). Suites parse every line with it; `GET /api/evals/export`
 *   answers with one; `rocketflare evals promote` appends one.
 * - **Feedback** — a person's thumbs up/down on an assistant message or an agent run's output
 *   (`POST /api/feedback`, `ai_feedback`), which is where promotion candidates come from.
 * - **The export query** — which real message or run to turn into a draft case.
 *
 * A promoted case carries TENANT DATA (the user's question, the documents retrieved, the answer),
 * which is why `source` records where it came from and never which tenant: the id is enough to find
 * it again from inside that tenant, and a dataset in a repository must not name customers.
 */
import { z } from 'zod'
import { paginatedResponse, paginationQuerySchema } from '../pagination'

// ---- Feedback ------------------------------------------------------------------------------------

export const FEEDBACK_TARGETS = ['message', 'agent_run'] as const
export const feedbackTargetSchema = z.enum(FEEDBACK_TARGETS)
export type FeedbackTarget = z.infer<typeof feedbackTargetSchema>

/** `1` = thumbs up, `-1` = thumbs down. There is no neutral vote: withdrawing one is a DELETE. */
export const feedbackRatingSchema = z.union([z.literal(1), z.literal(-1)])
export type FeedbackRating = z.infer<typeof feedbackRatingSchema>

export const FEEDBACK_COMMENT_MAX = 2000

export const createFeedbackRequestSchema = z.object({
  target: feedbackTargetSchema,
  /** An assistant message id (`target: 'message'`) or an agent run id (`'agent_run'`). */
  targetId: z.string().uuid(),
  rating: feedbackRatingSchema,
  comment: z.string().trim().max(FEEDBACK_COMMENT_MAX).optional(),
})
export type CreateFeedbackRequest = z.infer<typeof createFeedbackRequestSchema>

export const feedbackSchema = z.object({
  id: z.string().uuid(),
  target: feedbackTargetSchema,
  targetId: z.string().uuid(),
  rating: feedbackRatingSchema,
  comment: z.string().nullable(),
  userId: z.string().uuid().nullable(),
  /** The trace the rated answer recorded (D32), so `rocketflare traces show` can open it. */
  traceId: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type Feedback = z.infer<typeof feedbackSchema>

export const feedbackListQuerySchema = paginationQuerySchema.extend({
  rating: z.enum(['up', 'down']).optional(),
  target: feedbackTargetSchema.optional(),
})
export type FeedbackListQuery = z.infer<typeof feedbackListQuerySchema>

export const feedbackListResponseSchema = paginatedResponse(feedbackSchema)
export type FeedbackListResponse = z.infer<typeof feedbackListResponseSchema>

/** `DELETE /api/feedback/:target/:targetId` — withdraw your own vote. */
export const feedbackTargetParamSchema = z.object({
  target: feedbackTargetSchema,
  targetId: z.string().uuid(),
})

export const FEEDBACK_MINE_MAX_IDS = 200

/**
 * `GET /api/feedback/mine?target=message&targetIds=a,b,c` — the caller's OWN votes on those targets,
 * which is all the thumbs need to draw their state. Comma-separated so a page of messages is one
 * request with a cacheable URL.
 */
export const feedbackMineQuerySchema = z.object({
  target: feedbackTargetSchema,
  targetIds: z
    .string()
    .transform(value => value.split(',').filter(Boolean))
    .pipe(z.array(z.string().uuid()).max(FEEDBACK_MINE_MAX_IDS)),
})
export type FeedbackMineQuery = z.infer<typeof feedbackMineQuerySchema>

export const feedbackMineResponseSchema = z.object({ items: z.array(feedbackSchema) })
export type FeedbackMineResponse = z.infer<typeof feedbackMineResponseSchema>

// ---- Eval cases ----------------------------------------------------------------------------------

/** A tool the target is expected to call; `arguments` is matched per the scorer's strategy. */
export const evalExpectedToolSchema = z.union([
  z.string().min(1),
  z.object({ name: z.string().min(1), arguments: z.record(z.unknown()).optional() }),
])
export type EvalExpectedTool = z.infer<typeof evalExpectedToolSchema>

/**
 * How `expected.tools` is compared with the tools actually called (agentevals semantics): `strict`
 * same tools in the same order · `unordered` same tools, any order · `subset` nothing outside the
 * expected set · `superset` at least every expected tool. `strict` with `tools: []` = "call none".
 */
export const EVAL_TRAJECTORY_MODES = ['strict', 'unordered', 'subset', 'superset'] as const
export const evalTrajectoryModeSchema = z.enum(EVAL_TRAJECTORY_MODES)
export type EvalTrajectoryMode = z.infer<typeof evalTrajectoryModeSchema>

export const evalMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
})
export type EvalMessage = z.infer<typeof evalMessageSchema>

/** A document the case's tenant holds before the target runs (ingested into the eval tenant). */
export const evalContextDocSchema = z.object({
  title: z.string().min(1).max(200),
  text: z.string().min(1),
})
export type EvalContextDoc = z.infer<typeof evalContextDocSchema>

export const EVAL_CASE_SOURCES = ['hand', 'message', 'agent_run'] as const

export const evalCaseSchema = z.object({
  /** Stable within its dataset — baselines and comparisons key on it. */
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase letters, digits, . _ -'),
  /** The chat turn (a string) or the agent's input object. */
  input: z.union([z.string().min(1), z.record(z.unknown())]),
  /** Earlier turns of the conversation, oldest first (chat only). */
  messages: z.array(evalMessageSchema).default([]),
  context: z.array(evalContextDocSchema).default([]),
  expected: z
    .object({
      /** A reference answer: what a judge compares against, or a regex/substring source. */
      output: z.unknown().optional(),
      /** Plain-language criteria a rubric judge grades against. */
      rubric: z.string().optional(),
      tools: z.array(evalExpectedToolSchema).optional(),
      /** Overrides the suite's trajectory mode for this case. */
      toolsMatch: evalTrajectoryModeSchema.optional(),
      /** Substrings the output must contain (case-insensitive) — the cheapest deterministic check. */
      contains: z.array(z.string()).optional(),
    })
    .default({}),
  tags: z.array(z.string()).default([]),
  /** Where the case came from. A promoted case names the message/run, never the tenant. */
  source: z
    .object({
      kind: z.enum(EVAL_CASE_SOURCES),
      id: z.string().uuid().optional(),
      promotedAt: z.coerce.date().optional(),
      feedback: z
        .object({ rating: feedbackRatingSchema, comment: z.string().nullable() })
        .nullable()
        .optional(),
    })
    .default({ kind: 'hand' }),
  /** The agent a run-sourced case exercises (`summarize-text`); absent for chat. */
  agentKey: z.string().optional(),
})
export type EvalCase = z.infer<typeof evalCaseSchema>
export type EvalCaseInput = z.input<typeof evalCaseSchema>

/** `GET /api/evals/export` — exactly one of the two. */
export const evalExportQuerySchema = z
  .object({
    messageId: z.string().uuid().optional(),
    runId: z.string().uuid().optional(),
  })
  .refine(q => Boolean(q.messageId) !== Boolean(q.runId), {
    message: 'Pass exactly one of messageId or runId',
  })
export type EvalExportQuery = z.infer<typeof evalExportQuerySchema>

export const evalExportResponseSchema = z.object({
  case: evalCaseSchema,
  /** Said out loud by every reader: this candidate is tenant data. */
  containsTenantData: z.literal(true),
})
export type EvalExportResponse = z.infer<typeof evalExportResponseSchema>
