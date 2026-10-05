/**
 * `recall_memory` (D36) — what the requesting person told the assistant in EARLIER conversations,
 * recalled by `recallMemories` under the run's `AccessScope`: their own private memories (never
 * another person's, an admin's included) plus anything shared with them. Present only when memory
 * is on for that person (`AgentToolContext.memory`), so a model never sees a tool that could only
 * fail.
 *
 * Time is the model's job, not the Worker's: the description states today's date, and the model
 * passes `from`/`to` as ISO dates for "last month" or "in 2024". Facts come back as data — inside
 * the tool result, never spliced into the system prompt — each with both clocks (when it was
 * said, and when what it describes happened) and the names it mentions, so "who is Sam?" can be
 * followed up with `entity: "Sam"`.
 */
import {
  MEMORY_RECALL_DEFAULT_LIMIT,
  MEMORY_RECALL_MAX_LIMIT,
  MEMORY_TOOLS,
} from '@rocketflare/shared/ai/memory'
import { z } from 'zod'
import { AiNotConfiguredError } from '../../ai/errors'
import type { Tool } from '../../ai/kit'
import { recallMemories } from '../../ai/memory/recall'
import type { AgentToolContext } from './search-knowledge'

export const RECALL_MEMORY_TOOL = MEMORY_TOOLS.recall
/** Characters of fact text in one answer — facts are short; this is a backstop, not a budget. */
export const RECALL_RESPONSE_MAX_CHARS = 6_000

const isoDate = z
  .string()
  .trim()
  .refine(v => !Number.isNaN(Date.parse(v)), 'Expected an ISO date such as 2026-03-01')

export const recallMemoryInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe('What to remember, in natural language — "their role", "what they think of Sam"'),
  from: isoDate
    .optional()
    .describe('Only facts about time on or after this ISO date (resolve "last month" yourself)'),
  to: isoDate.optional().describe('Only facts about time on or before this ISO date'),
  entity: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe('Only facts that mention this person, team, product or place, by name'),
  includeHistorical: z
    // Small models send booleans as strings; `z.coerce.boolean()` would read "false" as true, so
    // both spellings are accepted and settled in the handler.
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .describe('Also return facts that a later one replaced — for "what did they used to …"'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MEMORY_RECALL_MAX_LIMIT)
    .optional()
    .describe(
      `How many facts (default ${MEMORY_RECALL_DEFAULT_LIMIT}, max ${MEMORY_RECALL_MAX_LIMIT})`
    ),
})
export type RecallMemoryInput = z.infer<typeof recallMemoryInputSchema>

export interface RecallMemoryFact {
  id: string
  text: string
  kind: string
  /** When it was said (ISO date). */
  said: string
  /** When what it describes happened or began / ended (ISO dates), when known. */
  from?: string
  to?: string
  entities: string[]
  /** Present on a fact a later one replaced. */
  replaced?: true
}

function day(at: Date | null): string | undefined {
  return at ? at.toISOString().slice(0, 10) : undefined
}

export function recallMemoryTool(
  ctx: AgentToolContext,
  now: () => Date = () => new Date()
): Tool<RecallMemoryInput> {
  return {
    name: RECALL_MEMORY_TOOL,
    description: `Recall what this person told you in earlier conversations — their role, team, projects, the people they work with, their preferences, and dated events — as short facts, best match first. Each fact says when it was said and, when known, when it happened. Today is ${day(now())}; pass \`from\`/\`to\` as ISO dates to ask about a period, \`entity\` to follow one name, \`includeHistorical\` for things that are no longer true. Results are the closest facts, not a relevance filter: ignore any that do not bear on the question. Empty means nothing relevant is remembered — say so rather than guessing.`,
    schema: recallMemoryInputSchema,
    async handler(input) {
      let hits: Awaited<ReturnType<typeof recallMemories>>
      try {
        hits = await recallMemories(ctx.db, ctx.cfg, ctx.env, ctx.scope, {
          query: input.query,
          limit: input.limit ?? MEMORY_RECALL_DEFAULT_LIMIT,
          from: input.from ? new Date(input.from) : undefined,
          to: input.to ? new Date(input.to) : undefined,
          entity: input.entity,
          includeHistorical: input.includeHistorical === true || input.includeHistorical === 'true',
        })
      } catch (err) {
        if (err instanceof AiNotConfiguredError) {
          return JSON.stringify({
            query: input.query,
            error: 'memory_unavailable',
            hint: 'Memory cannot be searched because no embeddings provider is configured. Answer without it.',
          })
        }
        throw err
      }
      const facts: RecallMemoryFact[] = []
      let spent = 0
      let omitted = 0
      for (const hit of hits) {
        const m = hit.memory
        if (spent + m.text.length > RECALL_RESPONSE_MAX_CHARS && facts.length > 0) {
          omitted += 1
          continue
        }
        spent += m.text.length
        facts.push({
          id: m.id,
          text: m.text,
          kind: m.kind,
          said: day(m.mentionedAt) ?? '',
          ...(m.occurredStart ? { from: day(m.occurredStart) } : {}),
          ...(m.occurredEnd ? { to: day(m.occurredEnd) } : {}),
          entities: m.entities.map(e => e.name),
          ...(m.invalidatedAt ? { replaced: true as const } : {}),
        })
      }
      return JSON.stringify({
        query: input.query,
        facts,
        ...(omitted > 0 ? { omitted } : {}),
        ...(facts.length === 0
          ? {
              hint: 'Nothing relevant is remembered. Say so, or ask the person, rather than guessing.',
            }
          : {}),
      })
    },
  }
}
