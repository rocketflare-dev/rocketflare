/**
 * `document.convert` (D7, D18): an uploaded original in R2 → text (Workers AI `toMarkdown`, or a
 * UTF-8 decode for text types) → the same `indexDocument` every other path uses. The message
 * carries only ids; the row and the `files` row say where the bytes are. A permanent conversion
 * refusal (`ConversionFailedError`) marks the row `failed` and is ACKED — retrying a corrupt PDF
 * cannot help; a thrown binding or provider error marks it `failed` and throws so the consumer
 * retries with backoff. A vanished row is logged and acked. A missing `FILES` binding throws —
 * the consumer must not silently drop uploads.
 */
import type { JobOf } from '@rocketflare/shared/jobs'
import { and, eq } from 'drizzle-orm'
import { documents } from '../../../db/schema'
import { ConversionFailedError } from '../../services/ai/convert'
import { convertAndIndexDocument } from '../../services/ai/ingest'
import { createR2Storage } from '../../services/storage'
import type { JobContext } from '../jobs'

export async function handleDocumentConvert(
  job: JobOf<'document.convert'>,
  ctx: JobContext
): Promise<void> {
  const { tenantId, documentId } = job.payload
  const row = await ctx.db.query.documents.findFirst({
    columns: { id: true },
    where: and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)),
  })
  if (!row) {
    ctx.logger.warn({ tenantId, documentId }, 'document.convert: document no longer exists')
    return
  }
  if (!ctx.env.FILES) {
    throw new Error(
      'document.convert: FILES binding is not configured (add [[r2_buckets]] to both tomls)'
    )
  }
  const storage = createR2Storage(ctx.env.FILES)
  try {
    const indexed = await convertAndIndexDocument(
      ctx.db,
      ctx.config,
      ctx.env,
      storage,
      tenantId,
      documentId
    )
    ctx.logger.info(
      { tenantId, documentId, chunkCount: indexed.chunkCount, model: indexed.embeddingModel },
      'document.convert: indexed'
    )
  } catch (err) {
    if (err instanceof ConversionFailedError) {
      ctx.logger.warn({ tenantId, documentId, reason: err.message }, 'document.convert: failed')
      return
    }
    throw err
  }
}
