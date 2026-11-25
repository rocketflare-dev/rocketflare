/**
 * The producer half of `knowledge.extract` (D43): after an index whose TEXT changed, enqueue an
 * extraction when the tenant has the `knowledge-facts` flag and an entity type is registered. The
 * job checks both again, because either can change before it runs.
 *
 * **Never throws.** Extraction is derived from a document that is already indexed and searchable;
 * a missing `JOBS_QUEUE` or a failed send is logged and the ingest stands. That is not the silent
 * inline fallback the queue rule forbids — nothing runs inline, the extraction simply does not
 * happen, and the warning says why.
 *
 * Ingest loads this module lazily (`await import`), so `services/ai/ingest.ts` — which
 * `@/plugins/api` reaches — gains no static path to the plugin barrel the registry reads.
 */
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { tenantFeatures } from '../features'
import { enqueueJob, type JobsQueue } from '../jobs'
import { knowledgeEntityTypes } from './registry'

export async function enqueueKnowledgeExtraction(
  db: Database,
  cfg: AppConfig,
  jobs: JobsQueue | null | undefined,
  input: { tenantId: string; documentId: string; contentHash: string | null }
): Promise<boolean> {
  try {
    if (knowledgeEntityTypes().length === 0) return false
    const features = await tenantFeatures(db, cfg, input.tenantId)
    if (!features.includes('knowledge-facts')) return false
    if (!jobs) {
      console.warn(
        JSON.stringify({
          msg: 'knowledge extraction not enqueued: JOBS_QUEUE is not configured',
          tenantId: input.tenantId,
          documentId: input.documentId,
        })
      )
      return false
    }
    await enqueueJob(jobs, {
      type: 'knowledge.extract',
      payload: {
        tenantId: input.tenantId,
        documentId: input.documentId,
        contentHash: input.contentHash ?? undefined,
      },
    })
    return true
  } catch (err) {
    console.warn(
      JSON.stringify({
        msg: 'knowledge extraction not enqueued',
        tenantId: input.tenantId,
        documentId: input.documentId,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      })
    )
    return false
  }
}
