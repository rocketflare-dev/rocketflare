/**
 * `memory.retain` (D36) — learn durable facts from a conversation's newest user turns into its
 * owner's memory. A job, never part of the turn, for the reason `chat.compact` is: it is a whole
 * extra model call, and a chat reply is the latency a person feels. Everything that matters —
 * the watermark, the partition, the off-means-never-learned rule — is in `retainConversation`.
 *
 * A provider failure throws and is retried with backoff; the watermark has not moved, so the retry
 * reads the same turns. No provider at all is acked: nothing will change on a retry.
 */
import type { JobOf } from '@rocketflare/shared/jobs'
import { noopTracer } from '../../observability/tracer'
import { retainConversation } from '../../services/ai/memory/retain'
import type { JobContext } from '../jobs'

export async function handleMemoryRetain(
  job: JobOf<'memory.retain'>,
  ctx: JobContext
): Promise<void> {
  const outcome = await retainConversation(
    {
      db: ctx.db,
      cfg: ctx.config,
      env: ctx.env,
      logger: ctx.logger,
      tracer: ctx.tracer ?? noopTracer,
    },
    job.payload
  )
  ctx.logger.debug({ conversationId: job.payload.conversationId, outcome }, 'memory.retain: done')
}
