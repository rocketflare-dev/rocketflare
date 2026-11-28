/**
 * `example_hr_availability` — HR's tool on every surface (chat, agent runs, MCP): who of a set of
 * people is on approved leave on a day. `example-sales`' qualify agent calls it in the same run as
 * its own leads tool, which is the point of one tool registry across domains.
 */
import {
  EXAMPLE_HR_AVAILABILITY_TOOL,
  EXAMPLE_HR_FLAG,
  EXAMPLE_LEAVE_SUBJECT,
} from '@rocketflare/shared/example-hr/index'
import { z } from 'zod'
import type { Tool, ToolCtx } from '@/plugins/api'
import { defineTool } from '@/plugins/api'
import { today, usersOnLeave } from './leave'

export const availabilityInputSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(50).describe('The people to check, by user id'),
  on: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('The day to check, YYYY-MM-DD (default today)'),
})
export type AvailabilityInput = z.infer<typeof availabilityInputSchema>

/** The tool while the organisation has the flag and the requester may read leave; else nothing. */
export async function exampleHrTools(ctx: ToolCtx): Promise<Tool[]> {
  const features = await ctx.features()
  if (!features.includes(EXAMPLE_HR_FLAG) || !ctx.can('read', EXAMPLE_LEAVE_SUBJECT)) return []
  return [availabilityTool(ctx) as Tool]
}

export function availabilityTool(ctx: ToolCtx): Tool<AvailabilityInput> {
  return defineTool({
    name: EXAMPLE_HR_AVAILABILITY_TOOL,
    description:
      'Say which of the given people are on approved leave on a day (default today). Call it ' +
      'before assigning work to someone or promising when they will reply.',
    schema: availabilityInputSchema,
    // Reads this organisation's own leave rows; nothing leaves. It returns user ids only, no text.
    egress: false,
    readsContent: false,
    mcp: { title: 'Who is on leave', annotations: { openWorldHint: false } },
    async handler(input) {
      const on = input.on ?? today()
      const away = await usersOnLeave(ctx.db, ctx.tenantId, input.userIds, on)
      return JSON.stringify({
        on,
        onLeave: away,
        available: input.userIds.filter(u => !away.includes(u)),
      })
    },
  })
}
