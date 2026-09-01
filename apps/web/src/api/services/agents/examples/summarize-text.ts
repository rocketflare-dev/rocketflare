/**
 * `summarize-text` — the kit's ONE example agent (D7, D17, 09 (c)), shaped like the simplest real
 * definition: exclusive per tenant, a precheck, ONE terminal tool (`submit_summary`) forced through
 * `callStructuredTool`, output persisted by the runtime, usage recorded under
 * `feature: 'agent:summarize-text'`. Emits `step` / `tool.start` / `tool.end` / `text` events and
 * polls for cancellation before and after the model call. With `input.index: true` it also stores
 * the summary as a searchable document through `ingestText` — the reason retrieval is never dead
 * code (00 §1.3). Copy this file to start a real agent.
 */
import {
  type SummarizeTextInput,
  type SummarizeTextOutput,
  summarizeTextInputSchema,
  summarizeTextOutputSchema,
} from '@rocketflare/shared/ai/agents'
import { z } from 'zod'
import { ingestText } from '../../ai/ingest'
import { callStructuredTool } from '../../ai/kit'
import { recordUsage } from '../../ai/usage'
import type { AgentDefinition } from '../registry'

export const SUBMIT_SUMMARY_TOOL = 'submit_summary'

/** What the model returns — the `documentId` is added by the agent, not the model. */
const submitSummarySchema = z.object({
  summary: z.string().min(1).describe('The summary, in the requested style.'),
  keyPoints: z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .describe('The most important points as short, self-contained sentences.'),
})

export const summarizeTextAgent: AgentDefinition<SummarizeTextInput, SummarizeTextOutput> = {
  meta: {
    key: 'summarize-text',
    title: 'Summarize text',
    description:
      'Summarises a block of text into a summary and key points with one forced tool call; optionally indexes the result for search.',
    inputSchema: summarizeTextInputSchema,
    outputSchema: summarizeTextOutputSchema,
    promptKey: 'summarize-text',
    exclusive: true,
  },

  async run(ctx) {
    const { input } = ctx

    // Precheck — defence in depth behind the route's schema validation.
    await ctx.step('precheck', 'Checking the input', 'running')
    const text = input.text.trim()
    if (!text) throw new Error('Nothing to summarise: the text is empty')
    await ctx.step('precheck', 'Checking the input', 'done', `${text.length} characters`)
    await ctx.checkCancelled()

    // One forced tool call. `callStructuredTool` re-asks once on invalid input.
    await ctx.step('summarize', 'Summarising', 'running')
    const system = await ctx.prompt({ style: input.style })
    await ctx.emit({ type: 'tool.start', data: { name: SUBMIT_SUMMARY_TOOL, style: input.style } })
    const result = await callStructuredTool(ctx.chat.client, {
      model: ctx.chat.model,
      maxTokens: ctx.chat.maxOutputTokens,
      system,
      messages: [{ role: 'user', content: `Summarise the following text:\n\n${text}` }],
      tool: {
        name: SUBMIT_SUMMARY_TOOL,
        description: 'Submit the summary and its key points. Call exactly once.',
        schema: submitSummarySchema,
      },
      onUsage: usage =>
        void recordUsage(ctx.db, {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          feature: 'agent:summarize-text',
          provider: ctx.chat.client.provider,
          model: ctx.chat.model,
          usage,
        }).catch(err => ctx.logger.warn({ err }, 'summarize-text: usage write failed')),
    })
    await ctx.emit({
      type: 'tool.end',
      data: { name: SUBMIT_SUMMARY_TOOL, keyPoints: result.keyPoints.length },
    })
    await ctx.emit({ type: 'text', data: { text: result.summary } })
    await ctx.step('summarize', 'Summarising', 'done', `${result.keyPoints.length} key points`)
    await ctx.checkCancelled()

    const output: SummarizeTextOutput = { summary: result.summary, keyPoints: result.keyPoints }

    if (input.index) {
      await ctx.step('index', 'Indexing the summary for search', 'running')
      const { document } = await ingestText(
        ctx.db,
        ctx.cfg,
        ctx.env,
        {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          title: `Summary ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
          text: [result.summary, ...result.keyPoints.map(p => `- ${p}`)].join('\n\n'),
          source: 'agent:summarize-text',
        },
        { jobs: ctx.env.JOBS_QUEUE }
      )
      output.documentId = document.id
      await ctx.step(
        'index',
        'Indexing the summary for search',
        document.status === 'failed' ? 'error' : 'done',
        document.status === 'failed'
          ? (document.error ?? 'indexing failed')
          : `${document.chunkCount} chunks`
      )
    }
    return output
  },
}
