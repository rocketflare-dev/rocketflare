/**
 * `knowledge.extract` (D43): read typed facts out of one indexed document
 * (`services/knowledge/extract.ts` — the gates, sections, the model call per section, the verifier,
 * resolution and state). The message carries ids and the content hash only.
 *
 * Outcomes: a gate (document gone or changed again, flag off, no entity types, no chat model) is
 * logged and ACKED — nothing a retry could change; the daily cap re-enqueues the same message for
 * the next UTC day and acks this one; a provider or database failure THROWS and the consumer
 * retries — safe, because every attempt starts by deleting the facts the document's last attempt
 * wrote. The work is one `job knowledge.extract` trace with a span per section.
 */
import type { JobOf } from '@rocketflare/shared/jobs'
import { noopTracer } from '../../observability/tracer'
import { extractDocumentFacts } from '../../services/knowledge/extract'
import type { JobContext } from '../jobs'

export async function handleKnowledgeExtract(
  job: JobOf<'knowledge.extract'>,
  ctx: JobContext
): Promise<void> {
  const report = await extractDocumentFacts(ctx.db, ctx.config, ctx.env, job.payload, {
    jobs: ctx.env.JOBS_QUEUE,
    tracer: ctx.tracer ?? noopTracer,
    logger: ctx.logger,
  })
  if (report.status !== 'extracted') {
    ctx.logger.info(
      { ...job.payload, status: report.status, reason: report.reason },
      'knowledge.extract: nothing extracted'
    )
  }
}
