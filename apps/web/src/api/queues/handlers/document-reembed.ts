/**
 * `document.reembed`: one bounded batch of a tenant's stale documents (`reembedBatch` in
 * `services/ai/reindex.ts` — rules there), then the SAME payload is enqueued again while any
 * remain, so no single message outgrows a queue invocation. A message for a model the tenant no
 * longer resolves is acked: the chain for the new model, enqueued by the config change, owns the
 * work. A transient failure throws and the consumer retries; the old chunks stay searchable.
 */
import type { JobOf } from '@rocketflare/shared/jobs'
import { noopTracer } from '../../observability/tracer'
import { withAgentTrace } from '../../observability/tracing'
import { enqueueReembed, reembedBatch } from '../../services/ai/reindex'
import type { JobContext } from '../jobs'

export async function handleDocumentReembed(
  job: JobOf<'document.reembed'>,
  ctx: JobContext
): Promise<void> {
  const { tenantId, model } = job.payload
  // A `job document.reembed` span, so each document's embeddings batches nest under something.
  const result = await withAgentTrace(
    'document.reembed',
    {
      tracer: ctx.tracer ?? noopTracer,
      tenantId,
      kind: 'job',
      spanName: 'job document.reembed',
      metadata: { model },
    },
    () => reembedBatch(ctx.db, ctx.config, ctx.env, ctx.logger, tenantId, model)
  )
  if (result.status === 'more') await enqueueReembed(ctx.env.JOBS_QUEUE, tenantId, model)
  ctx.logger.info({ tenantId, model, ...result }, 'document.reembed: batch done')
}
