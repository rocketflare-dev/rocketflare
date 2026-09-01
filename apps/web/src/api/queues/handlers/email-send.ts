/**
 * `email.send` (D7): deliver a pre-rendered email through `services/email.ts`. A provider
 * failure is thrown so the consumer retries with backoff; the "no RESEND_API_KEY" dev fallback is
 * a successful outcome (logged, `delivered: false`, no error) and is acked.
 */
import type { JobOf } from '@gmgo/shared/jobs'
import { sendEmail } from '../../services/email'
import type { JobContext } from '../jobs'

export async function handleEmailSend(job: JobOf<'email.send'>, ctx: JobContext): Promise<void> {
  const { to, subject, html, text, link, reason, tenantId } = job.payload
  const logger = ctx.logger.child({ reason, tenantId })
  const result = await sendEmail(ctx.config, logger, { to, subject, html, text: text ?? '', link })
  if (result.error) {
    throw new Error(`email.send failed: ${result.error}`)
  }
  logger.info({ delivered: result.delivered, providerId: result.id }, 'email.send: sent')
}
