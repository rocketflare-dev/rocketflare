/**
 * `example-sales` — an example APP DOMAIN, shared half: leads, their owner and a qualify agent.
 *
 * It depends on `example-hr` (`dependsOn` in `apps/web/src/example-sales/index.ts`): assigning a lead
 * asks HR whether the new owner is on leave through `example-hr`'s `public.ts`, an approved leave
 * hands that person's open leads back to the pool (an event handler), and the qualify agent uses
 * this domain's leads tool and HR's availability tool in one run. docs/CONCEPTS.md §20.
 */
import { z } from 'zod'
import type { FeatureDefinition } from '../features'
import { paginatedResponse, paginationQuerySchema } from '../pagination'
import type { SharedDomain } from '../plugins/types'

export const EXAMPLE_SALES_ID = 'example-sales'

/** Gates the nav item, the page, the mount, the tool and the agent. `pnpm seed` turns it on. */
export const EXAMPLE_SALES_FLAG = 'example-sales'

export const EXAMPLE_LEAD_SUBJECT = 'ExampleLead'

/** The lead-qualify agent: reads the lead and its owner's availability, and scores it. */
export const EXAMPLE_QUALIFY_LEAD_AGENT = 'example-sales.qualify-lead'
export const EXAMPLE_QUALIFY_LEAD_PROMPT = 'example-sales-qualify-lead'

/** Emitted when the agent scores a lead. */
export const EXAMPLE_LEAD_QUALIFIED_EVENT = 'example-sales.lead.qualified'

/** The realtime entity a lead change nudges — also the UI's query-key root. */
export const EXAMPLE_SALES_LEADS_ENTITY = 'example-sales:leads'

/** The leads tool's name, on every surface. */
export const EXAMPLE_SALES_LEADS_TOOL = 'example_sales_leads'

export const EXAMPLE_LEAD_NAME_MAX = 200

export const leadStatusSchema = z.enum(['new', 'qualified', 'disqualified'])
export type LeadStatus = z.infer<typeof leadStatusSchema>

export const leadSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string(),
  company: z.string(),
  notes: z.string(),
  status: leadStatusSchema,
  score: z.number().int().min(0).max(100).nullable(),
  ownerUserId: z.string().uuid().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type Lead = z.infer<typeof leadSchema>

export const leadListResponseSchema = paginatedResponse(leadSchema)
export type LeadListResponse = z.infer<typeof leadListResponseSchema>

export const leadListQuerySchema = paginationQuerySchema
export type LeadListQuery = z.infer<typeof leadListQuerySchema>

export const createLeadSchema = z.object({
  name: z.string().trim().min(1).max(EXAMPLE_LEAD_NAME_MAX),
  company: z.string().trim().max(EXAMPLE_LEAD_NAME_MAX).default(''),
  notes: z.string().trim().max(4_000).default(''),
})
export type CreateLead = z.infer<typeof createLeadSchema>

export const assignLeadSchema = z.object({ ownerUserId: z.string().uuid().nullable() })
export type AssignLead = z.infer<typeof assignLeadSchema>

export const qualifyLeadInputSchema = z.object({ leadId: z.string().uuid() })
export const qualifyLeadOutputSchema = z.object({
  leadId: z.string().uuid(),
  score: z.number().int().min(0).max(100),
  status: leadStatusSchema,
  /** Whether the owner is on approved leave today — read with `example-hr`'s tool. */
  ownerOnLeave: z.boolean(),
  reasons: z.array(z.string()),
})
export type QualifyLeadOutput = z.infer<typeof qualifyLeadOutputSchema>

export const leadQualifiedPayloadSchema = z.object({
  leadId: z.string().uuid(),
  score: z.number().int().min(0).max(100),
  status: leadStatusSchema,
})
export type LeadQualifiedPayload = z.infer<typeof leadQualifiedPayloadSchema>

export const exampleSalesShared = {
  id: EXAMPLE_SALES_ID,
  label: 'Sales (example)',
  subjects: [EXAMPLE_LEAD_SUBJECT],
  agentKeys: [EXAMPLE_QUALIFY_LEAD_AGENT],
  promptKeys: [EXAMPLE_QUALIFY_LEAD_PROMPT],
  events: { [EXAMPLE_LEAD_QUALIFIED_EVENT]: leadQualifiedPayloadSchema },
  features: {
    [EXAMPLE_SALES_FLAG]: {
      label: 'Sales (example domain)',
      description:
        'The example sales domain: leads, assignment that asks HR who is on leave, and a ' +
        'lead-qualify agent. Gates its nav item, page, /api/example-sales mount, tool and agent. ' +
        'Safe to delete.',
      defaultState: 'off',
      defaultRolloutUnit: 'tenant',
      environmentGated: false,
    } satisfies FeatureDefinition,
  },
} as const satisfies SharedDomain
