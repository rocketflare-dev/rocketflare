/**
 * The run inspector's contract: `GET /api/agents/runs/:id/timeline`, read by
 * `rocketflare agents inspect <runId>` and the admin run-timeline page.
 *
 * One chronological list built from every record a run leaves — events, model turns and tool
 * calls, `ctx.once` effects, decisions, asks, child runs — plus what the timeline cannot show as a
 * row: the versions it ran under, and its spend against its budget (its own, and with every
 * child's included, which is what the budget meters).
 */
import { z } from 'zod'
import { agentKeySchema, agentRunSchema, agentRunStatusSchema } from './agents'

export const AGENT_TIMELINE_ENTRY_KINDS = [
  'event',
  'turn',
  'tool',
  'effect',
  'decision',
  'interrupt',
  'child',
] as const
export type AgentTimelineEntryKind = (typeof AGENT_TIMELINE_ENTRY_KINDS)[number]

export const agentTimelineEntrySchema = z.object({
  at: z.coerce.date(),
  kind: z.enum(AGENT_TIMELINE_ENTRY_KINDS),
  /** One line a person reads: `status running`, `turn 2 (research)`, `once search`… */
  label: z.string(),
  /** The id or key the entry points at — a child's run id, an ask's id, an effect's key. */
  ref: z.string().nullable().default(null),
  /** The record itself, trimmed: an event's data, a tool's result, an ask's answer. */
  detail: z.unknown().optional(),
})
export type AgentTimelineEntry = z.infer<typeof agentTimelineEntrySchema>

const spendSchema = z.object({
  calls: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
})

export const agentRunTimelineSchema = z.object({
  run: agentRunSchema,
  versions: z.object({
    /** The `meta.version` the run last ran under, and today's. They differ for a run in flight. */
    agentVersion: z.number().int().positive(),
    currentAgentVersion: z.number().int().positive().nullable(),
    workerVersionId: z.string().nullable(),
  }),
  spend: z.object({
    own: spendSchema,
    /** The run and every run it spawned — what its budget is checked against. */
    tree: spendSchema,
    budget: z.object({
      maxTokens: z.number().int().nonnegative().optional(),
      maxCostUsd: z.number().nonnegative().optional(),
    }),
  }),
  children: z.array(
    z.object({
      id: z.string().uuid(),
      agentKey: agentKeySchema,
      status: agentRunStatusSchema,
      createdAt: z.coerce.date(),
      finishedAt: z.coerce.date().nullable(),
    })
  ),
  entries: z.array(agentTimelineEntrySchema),
})
export type AgentRunTimeline = z.infer<typeof agentRunTimelineSchema>
