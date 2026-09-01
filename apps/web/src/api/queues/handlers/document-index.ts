/**
 * `document.index` (D7, D18): index a `documents` row too large to embed inline at ingest. The
 * same `indexDocument` the route path uses — it re-reads the text from the row, so the message
 * carries only ids. A provider failure marks the row `failed` and throws, so the consumer retries
 * with backoff; a missing row (deleted meanwhile) is logged and acked.
 */
import type { JobOf } from '@rocketflare/shared/jobs'
import { and, eq } from 'drizzle-orm'
import { documents } from '../../../db/schema'
import { indexDocument } from '../../services/ai/ingest'
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
  const indexed = await indexDocument(ctx.db, ctx.config, ctx.env, tenantId, documentId)
  ctx.logger.info(
    { tenantId, documentId, chunkCount: indexed.chunkCount, model: indexed.embeddingModel },
    'document.index: indexed'
  )
}
