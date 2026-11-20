/**
 * `lookup_facts` — the typed facts extracted from the knowledge base (D43): what is held about an
 * entity (a customer, a supplier…), grouped by entity, each fact with its state, its source
 * document and the verbatim quote. Bound to the reader's `AccessScope` like the other knowledge
 * tools: a fact read from a document the reader cannot open does not exist here
 * (`services/knowledge/lookup.ts`).
 *
 * Offered only to a tenant with the `knowledge-facts` flag (`buildAgentTools`), so a model never
 * sees a tool that could only come back empty because the feature is off.
 */
import { KNOWLEDGE_TOOLS } from '@rocketflare/shared/ai/embeddings'
import { z } from 'zod'
import type { Tool } from '../../ai/agent-loop'
import { lookupFacts } from '../../knowledge/lookup'
import type { AgentToolContext } from './search-knowledge'

export const LOOKUP_FACTS_TOOL = KNOWLEDGE_TOOLS.facts

export const lookupFactsInputSchema = z.object({
  entity: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'The name of the entity to look up, as the user said it ("Brightside", "the Old Mill Hotel")'
    ),
  type: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe('Narrow to one entity type ("customer", "supplier") — omit when unsure'),
  key: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .optional()
    .describe(
      'Narrow to one fact key ("monthly_fee_gbp", "primary_contact") — omit to get every fact'
    ),
  asOf: z.iso
    .date()
    .optional()
    .describe('A day (YYYY-MM-DD): what was true then, including values since replaced'),
})
export type LookupFactsInput = z.infer<typeof lookupFactsInputSchema>

export function lookupFactsTool(ctx: AgentToolContext): Tool<LookupFactsInput> {
  return {
    name: LOOKUP_FACTS_TOOL,
    mcp: { title: 'Look up facts' },
    description:
      "Look up the facts this workspace's documents state about an entity — a customer, supplier, service or similar: prices, contacts, dates, terms. Each fact comes with the document it was read from, the exact quote, and a `state`. accepted: state it, citing the document. unconfirmed: use it, and say it is unconfirmed. conflicting: the sources DISAGREE — the other sides are in the same answer (`conflictsWith`); give every side with its value and its document and say they disagree, never pick one silently (you may lead with the one marked `preferred`). Use it for questions about a specific entity's details; use search_knowledge for everything else, or to read the surrounding passage.",
    schema: lookupFactsInputSchema,
    async handler(input) {
      return JSON.stringify(await lookupFacts(ctx.db, ctx.scope, input))
    },
  }
}
