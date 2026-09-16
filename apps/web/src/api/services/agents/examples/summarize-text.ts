/**
 * `summarize-text` — the kit's ONE example agent (D7, D17, 09 (c)), shaped like the simplest real
 * definition: exclusive per tenant, a precheck, ONE terminal tool (`submit_summary`) forced through
 * `callStructuredTool`, output persisted by the runtime, usage recorded under
 * `feature: 'agent:summarize-text'`. Emits `step` / `tool.start` / `tool.end` / `text` events and
 * polls for cancellation before and after the model call. With `input.index: true` it also stores
 * the summary as a searchable document through `ingestText` — the reason retrieval is never dead
 * code (00 §1.3) — wrapped in `ctx.once` so a retried attempt replays the recorded document instead
 * of indexing a second copy. Copy this file to start a real agent.
 *
 * It is also the kit's simplest **human-in-the-loop** example (issue #17), and deliberately uses
 * `ctx.interrupt` rather than a gated tool. This agent has no tool loop — it is one
 * `callStructuredTool`, and the write is straight-line code — so `Tool.requiresApproval` has
 * nothing to attach to. Bolting a loop onto the file every adopter copies, purely to demonstrate a
 * flag, would make the simplest agent the most complicated one. The contrast is the lesson:
 *
 * | The write is… | Ask with |
 * |---|---|
 * | straight-line code the agent runs itself | `ctx.interrupt({ key, spec })` — here |
 * | a tool the MODEL decides to call | `Tool.requiresApproval` — `research-topic` |
 *
 * Both park the same way and resume the same way; only who decided to do the thing differs.
 */
import {
  type SummarizeTextInput,
  type SummarizeTextOutput,
  summarizeTextInputSchema,
  summarizeTextOutputSchema,
} from '@rocketflare/shared/ai/agents'
import { approvalPayloadSchema } from '@rocketflare/shared/ai/interrupts'
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
    //
    // The whole phase sits inside `ctx.once` because a run that PARKS on the approval below
    // re-enters `run()` from the top when a person answers — possibly days later. Tokens are a side
    // effect like any other, so without this the summary is paid for twice and the timeline shows
    // the phase twice. The recorded value is jsonb, which is exactly what this returns.
    const result = await ctx.once('summary', async () => {
      await ctx.step('summarize', 'Summarising', 'running')
      const system = await ctx.prompt({ style: input.style })
      await ctx.emit({
        type: 'tool.start',
        data: { name: SUBMIT_SUMMARY_TOOL, style: input.style },
      })
      const summary = await callStructuredTool(ctx.chat.client, {
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
        data: { name: SUBMIT_SUMMARY_TOOL, keyPoints: summary.keyPoints.length },
      })
      await ctx.emit({ type: 'text', data: { text: summary.summary } })
      await ctx.step('summarize', 'Summarising', 'done', `${summary.keyPoints.length} key points`)
      // Recorded BEFORE the ask below, deliberately: the person being asked whether to index this
      // is being asked about something they have to be able to read first. It sits inside the
      // `once` with the rest of the phase, so the re-entered attempt neither rewrites the artifact
      // nor adds a second `artifact` row to the timeline.
      await ctx.artifact({
        key: 'summary',
        title: 'Summary',
        data: {
          kind: 'markdown',
          markdown: [summary.summary, ...summary.keyPoints.map(point => `- ${point}`)].join('\n\n'),
        },
      })
      return summary
    })
    await ctx.checkCancelled()

    const output: SummarizeTextOutput = { summary: result.summary, keyPoints: result.keyPoints }

    if (input.index) {
      // The human-in-the-loop line. Three things about it are load-bearing:
      //
      // 1. `key` is OURS and is stable across attempts. The resumed `execute` step re-enters
      //    `run()` from the top and reaches this line again; `UNIQUE (run_id, key)` is what makes
      //    the second call find the ANSWER instead of asking a second time, forever.
      // 2. Everything after it is on the far side of a park that may last days and a Worker
      //    deploy. That is why the write below is already behind `ctx.once` — the same rule as
      //    any retry, for the same reason.
      // 3. A declined `approval` does not return here at all: the default rejection is
      //    `cancel_run`, so `ctx.interrupt` throws `InterruptDeclinedError` and the runtime
      //    settles the run `cancelled` with `error` NULL. A refusal is a status, not a fault.
      const approval = await ctx.interrupt({
        key: 'approve-index',
        spec: {
          kind: 'approval',
          title: 'Index this summary?',
          message:
            'Add this summary to the knowledge base as a searchable document? It becomes findable in Search and readable by every agent in this workspace.',
          confirmLabel: 'Index it',
          rejectLabel: 'Cancel the run',
        },
      })
      const note = approvalPayloadSchema.safeParse(approval.payload)
      await ctx.step(
        'index',
        'Indexing the summary for search',
        'running',
        note.success && note.data.note ? `approved: ${note.data.note}` : 'approved'
      )
      // `ctx.once` is why a retried run cannot leave two copies of this summary in the knowledge
      // base: an `execute` retry re-enters `run()` from the top, and `ingestText` is a write. The
      // recorded value is jsonb, so this returns the ids and scalars the step needs — never the row.
      const document = await ctx.once('index-summary', async () => {
        const { document: row } = await ingestText(
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
        return {
          id: row.id,
          status: row.status,
          chunkCount: row.chunkCount,
          error: row.error ?? null,
        }
      })
      output.documentId = document.id
      await ctx.artifact({
        key: 'summary-document',
        title: 'Indexed document',
        description: 'The summary, stored in the knowledge base.',
        data: { kind: 'document', documentId: document.id },
      })
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
