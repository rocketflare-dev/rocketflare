/**
 * `document.index`: index a `documents` row too large to embed inline at ingest. The
 * same `indexDocument` the route path uses — it re-reads the text from the row, so the message
 * carries only ids. A provider failure marks the row `failed` and throws, so the consumer retries
 * with backoff; a missing row (deleted meanwhile) is logged and acked. Once indexed, it enqueues
 * `knowledge.extract` (when the tenant has it) unless `skipExtraction` says the text is unchanged.
 */
import type { JobOf } from '@rocketflare/shared/jobs'
import { and, eq } from 'drizzle-orm'
import { documents } from '../../../db/schema'
import { noopTracer } from '../../observability/tracer'
import { withAgentTrace } from '../../observability/tracing'
import { afterTextIndexed, indexDocument } from '../../services/ai/ingest'
import type { JobContext } from '../jobs'

export async function handleDocumentIndex(
  job: JobOf<'document.index'>,
  ctx: JobContext
): Promise<void> {
  const { tenantId, documentId } = job.payload
  const row = await ctx.db.query.documents.findFirst({
    columns: { id: true },
    where: and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)),
  })
  if (!row) {
    ctx.logger.warn({ tenantId, documentId }, 'document.index: document no longer exists')
    return
  }
  // A `invoke_workflow document.index` span, so each embeddings batch nests under something.
  const indexed = await withAgentTrace(
    'document.index',
    {
      tracer: ctx.tracer ?? noopTracer,
      tenantId,
      kind: 'job',
      spanName: 'invoke_workflow document.index',
      metadata: { documentId },
    },
    () => indexDocument(ctx.db, ctx.config, ctx.env, tenantId, documentId)
  )
  ctx.logger.info(
    { tenantId, documentId, chunkCount: indexed.chunkCount, model: indexed.embeddingModel },
    'document.index: indexed'
  )
  // Knowledge facts (D43): the text is new (a large ingest, a retried failure) unless the producer
  // said it only re-embedded. Never throws; the index stands either way.
  if (!job.payload.skipExtraction) {
    await afterTextIndexed(ctx.db, ctx.config, ctx.env.JOBS_QUEUE, indexed)
  }
}
