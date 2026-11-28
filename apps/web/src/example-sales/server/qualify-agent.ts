/**
 * The lead-qualify agent — one run, two domains' tools. It reads the lead with this domain's
 * `example_sales_leads` tool and asks `example-hr`'s `example_hr_availability` tool whether the
 * owner is on leave, both from the SAME `ctx.tools`: the registry builds one tool list from every
 * unit, bound to the run's requester. Neither domain imports the other's tool.
 *
 * It scores with plain rules and calls no model, so it runs anywhere — swap the scoring for
 * `ctx.toolLoop(...)` or `ctx.decide(...)` and the tools stay exactly where they are.
 */
import { EXAMPLE_HR_AVAILABILITY_TOOL } from '@rocketflare/shared/example-hr/index'
import {
  EXAMPLE_LEAD_QUALIFIED_EVENT,
  EXAMPLE_QUALIFY_LEAD_AGENT,
  EXAMPLE_QUALIFY_LEAD_PROMPT,
  EXAMPLE_SALES_LEADS_TOOL,
  type Lead,
  type QualifyLeadOutput,
  qualifyLeadInputSchema,
  qualifyLeadOutputSchema,
} from '@rocketflare/shared/example-sales/index'
import type { z } from 'zod'
import type { AgentCtx, PluginAgent } from '@/plugins/api'
import { agentCtx } from '@/plugins/api'
import { scoreLead } from './leads'

type Input = z.infer<typeof qualifyLeadInputSchema>

export const qualifyLeadPrompt = {
  key: EXAMPLE_QUALIFY_LEAD_PROMPT,
  title: 'Qualify a lead (example)',
  description:
    'The example sales domain’s qualify agent. It scores with rules; the prompt is unused.',
  variables: ['appName', 'tenantName'],
  defaultText: 'You qualify sales leads inside {{appName}} for {{tenantName}}.',
}

async function callTool(ctx: AgentCtx<Input>, name: string, input: unknown): Promise<unknown> {
  const tool = ctx.tools.find(t => t.name === name)
  if (!tool?.handler) throw new Error(`the ${name} tool is not available to this run`)
  return JSON.parse(await tool.handler(tool.schema.parse(input)))
}

/** The rules: a company and some notes make a lead worth a call; an absent owner costs a little. */
export function scoreOf(lead: Pick<Lead, 'company' | 'notes'>, ownerOnLeave: boolean) {
  const reasons: string[] = []
  let score = 30
  if (lead.company.trim()) {
    score += 30
    reasons.push('has a company')
  }
  if (lead.notes.trim().length >= 20) {
    score += 30
    reasons.push('has notes worth reading')
  }
  if (ownerOnLeave) {
    score -= 10
    reasons.push('owner is on leave today')
  }
  return {
    score,
    status: score >= 60 ? ('qualified' as const) : ('disqualified' as const),
    reasons,
  }
}

export const qualifyLeadAgent: PluginAgent<Input, QualifyLeadOutput> = {
  meta: {
    key: EXAMPLE_QUALIFY_LEAD_AGENT,
    title: 'Qualify a lead (example)',
    description: 'Scores one lead, checking with HR whether its owner is on leave.',
    inputSchema: qualifyLeadInputSchema,
    outputSchema: qualifyLeadOutputSchema,
    promptKey: EXAMPLE_QUALIFY_LEAD_PROMPT,
    exclusive: false,
  },
  run: async runtime => {
    const ctx = agentCtx(runtime)
    const { lead } = (await callTool(ctx, EXAMPLE_SALES_LEADS_TOOL, {
      leadId: ctx.input.leadId,
    })) as { lead: Lead | null }
    if (!lead) throw new Error('lead not found')
    await ctx.step('read', 'Read the lead', 'done', lead.name)
    let ownerOnLeave = false
    if (lead.ownerUserId) {
      const { onLeave } = (await callTool(ctx, EXAMPLE_HR_AVAILABILITY_TOOL, {
        userIds: [lead.ownerUserId],
      })) as { onLeave: string[] }
      ownerOnLeave = onLeave.includes(lead.ownerUserId)
    }
    await ctx.step(
      'availability',
      'Asked HR about the owner',
      'done',
      ownerOnLeave ? 'on leave' : 'available'
    )
    const { score, status, reasons } = scoreOf(lead, ownerOnLeave)
    await scoreLead(ctx.db, ctx.tenantId, lead.id, score, status)
    await ctx.emit(EXAMPLE_LEAD_QUALIFIED_EVENT, {
      payload: { leadId: lead.id, score, status },
      idempotencyKey: `qualified:${ctx.runId}`,
    })
    return { leadId: lead.id, score, status, ownerOnLeave, reasons }
  },
}
