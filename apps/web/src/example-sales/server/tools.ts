/**
 * `example_sales_leads` — the sales domain's tool on every surface: one lead, or the newest few.
 * Read-only. The qualify agent calls it in the same run as `example-hr`'s availability tool.
 */
import {
  EXAMPLE_LEAD_SUBJECT,
  EXAMPLE_SALES_FLAG,
  EXAMPLE_SALES_LEADS_TOOL,
} from '@rocketflare/shared/example-sales/index'
import { z } from 'zod'
import type { Tool, ToolCtx } from '@/plugins/api'
import { defineTool } from '@/plugins/api'
import { getLead, listLeads } from './leads'

export const leadsInputSchema = z.object({
  leadId: z.string().uuid().optional().describe('One lead by id; omit to list the newest'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('How many to list (default 10)'),
})
export type LeadsInput = z.infer<typeof leadsInputSchema>

export async function exampleSalesTools(ctx: ToolCtx): Promise<Tool[]> {
  const features = await ctx.features()
  if (!features.includes(EXAMPLE_SALES_FLAG) || !ctx.can('read', EXAMPLE_LEAD_SUBJECT)) return []
  return [leadsTool(ctx) as Tool]
}

export function leadsTool(ctx: ToolCtx): Tool<LeadsInput> {
  return defineTool({
    name: EXAMPLE_SALES_LEADS_TOOL,
    description:
      'Read sales leads in this workspace: one by id, or the newest few, with their company, ' +
      'notes, status, score and owner.',
    schema: leadsInputSchema,
    mcp: { title: 'Sales leads', annotations: { openWorldHint: false } },
    async handler(input) {
      if (input.leadId) {
        const lead = await getLead(ctx.db, ctx.tenantId, input.leadId)
        return JSON.stringify(lead ? { lead } : { lead: null, hint: 'No lead has that id here.' })
      }
      const { items, total } = await listLeads(ctx.db, ctx.tenantId, {
        page: 1,
        pageSize: input.limit ?? 10,
      })
      return JSON.stringify({ total, leads: items })
    },
  })
}
