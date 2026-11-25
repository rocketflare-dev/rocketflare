/**
 * Inbound email: `EmailCtx` for a `ServerPlugin.emailHandlers` entry.
 *
 * It is `CronCtx` under another name, because the host builds it the same way — config validated,
 * one DB client for the message, a `waitUntil` that genuinely exists — and it keeps the cron's rule
 * that there is NO ambient tenant: an inbound message names an address, not an organisation, and
 * which tenant it belongs to is the handler's decision (a per-tenant token in the subaddress, a
 * settings row), made before any write.
 *
 * The handler itself stays short: store the raw message (`message.raw`, at most 25 MiB), write a
 * row, `ctx.enqueue` the parsing. A throw is a temporary failure the sending server retries; a
 * message the handler wants bounced is `message.setReject(reason)`.
 */

import type { EmailContext } from '../../api/email'
import { type BackgroundMethods, backgroundMethods } from './jobs'
import type { PluginContext } from './types'

export type { EmailContext, EmailHandler } from '../../api/email'
export { EMAIL_CATCH_ALL, emailLocalPart, emailSubaddress } from '../../api/email-address'

/** One inbound message's context. */
export interface EmailCtx extends PluginContext, BackgroundMethods {
  waitUntil(promise: Promise<unknown>): void
}

/** Adapt the core `EmailContext`. The only place a plugin's email half names a core internal. */
export function emailCtx(ctx: EmailContext): EmailCtx {
  return {
    db: ctx.db,
    config: ctx.config,
    logger: ctx.logger,
    env: ctx.env,
    waitUntil: ctx.waitUntil,
    ...backgroundMethods(ctx),
  }
}
