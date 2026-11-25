/**
 * `knowledge.extract` (D43): read typed facts out of one indexed document
 * (`services/knowledge/extract.ts` — the gates, sections, the model call per section, the verifier,
 * resolution and state). The message carries ids and the content hash only.
 *
 * Outcomes: a gate (document gone or changed again, flag off, no entity types, no chat model) is
 * logged and ACKED — nothing a retry could change; the daily cap re-enqueues the same message for
 * the next UTC day and acks this one; a provider or database failure THROWS and the consumer
 * retries — safe, because every attempt starts by deleting the facts the document's last attempt
 * wrote. The work is one `invoke_workflow knowledge.extract` trace with a span per section. A run that wrote or
 * removed facts nudges `entity.changed { entity: 'knowledge' }` tenant-wide, so the review badge,
 * the list and an open entity page refetch.
 */
import type { JobOf } from '@rocketflare/shared/jobs'
import { noopTracer } from '../../observability/tracer'
import { extractDocumentFacts } from '../../services/knowledge/extract'
import { collectingRealtime } from '../../services/realtime'
import type { JobContext } from '../jobs'

export async function handleKnowledgeExtract(
  job: JobOf<'knowledge.extract'>,
  ctx: JobContext
): Promise<void> {
  // A job has no `waitUntil`: the nudge is collected and sent before the handler returns.
  const realtime = collectingRealtime(ctx.env)
  const report = await extractDocumentFacts(ctx.db, ctx.config, ctx.env, job.payload, {
    jobs: ctx.env.JOBS_QUEUE,
    tracer: ctx.tracer ?? noopTracer,
    logger: ctx.logger,
    realtime,
  })
  await realtime.flush()
  if (report.status !== 'extracted') {
    ctx.logger.info(
      { ...job.payload, status: report.status, reason: report.reason },
      'knowledge.extract: nothing extracted'
    )
  }
}
