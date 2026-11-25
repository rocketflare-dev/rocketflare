/**
 * `document.contextualize` (`knowledge-context` flag): write each passage's situating context and
 * re-embed it (`services/ai/contextualize.ts`). The message carries ids and the content hash only.
 *
 * Outcomes: a gate (document gone, not indexed or changed since, flag off, no chat model, nothing
 * left to do) is logged and ACKED; the daily knowledge cap re-enqueues the message for the next
 * UTC day and acks this one; a provider or database failure THROWS and the consumer retries —
 * safe, because only passages still without a context are asked about again.
 */
import type { JobOf } from '@rocketflare/shared/jobs'
import { noopTracer } from '../../observability/tracer'
import { contextualizeDocument } from '../../services/ai/contextualize'
import type { JobContext } from '../jobs'

export async function handleDocumentContextualize(
  job: JobOf<'document.contextualize'>,
  ctx: JobContext
): Promise<void> {
  const report = await contextualizeDocument(ctx.db, ctx.config, ctx.env, job.payload, {
    jobs: ctx.env.JOBS_QUEUE,
    tracer: ctx.tracer ?? noopTracer,
    logger: ctx.logger,
  })
  ctx.logger.info(
    {
      ...job.payload,
      status: report.status,
      reason: report.reason,
      pending: report.pending,
      written: report.written,
      empty: report.empty,
    },
    'document.contextualize'
  )
}
