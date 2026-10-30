/**
 * Inbound email dispatcher: the Worker's `email` handler, reached through Cloudflare Email
 * Routing when a rule's action is "Send to a Worker". Core handles no address itself — every
 * handler comes from an installed plugin's `ServerPlugin.emailHandlers`, keyed by the LOCAL PART of
 * the recipient (`receipts` takes `receipts@…` and `receipts+anything@…`), with `*` as the
 * catch-all. A message no handler claims is rejected with a permanent SMTP error, so a typo'd
 * address bounces rather than vanishing.
 *
 * The context is the cron's `TaskContext` shape on purpose — config validated as `fetch` does it,
 * one DB client per message closed in `waitUntil`, a logger tagged with the handler — so a
 * plugin adapts it with `emailCtx` exactly as it adapts a cron with `cronCtx`. Keep the handler
 * itself short: store the raw message, write a row, enqueue the real work. Email Workers run under
 * the ordinary CPU limit, and a message the handler throws on is retried by the sending server
 * (a temporary failure), never silently dropped.
 *
 * Local testing against `wrangler dev` (port 3001):
 *   curl -X POST 'http://localhost:3001/cdn-cgi/handler/email?from=me@example.com&to=receipts@example.com' \
 *     --data-binary @message.eml
 */
import { loadConfig } from '../config'
import { openDatabase } from '../db/client'
import { serverPlugins } from '../plugins/server'
import { EMAIL_CATCH_ALL, emailLocalPart } from './email-address'
import type { TaskContext } from './scheduled'
import type { AppBindings } from './types'
import { loggerFor } from './utils/core/logger'

export { EMAIL_CATCH_ALL, emailLocalPart, emailSubaddress } from './email-address'

/** What an email handler is given — the cron's context, for the same reasons. */
export type EmailContext = TaskContext

export interface EmailHandler {
  /**
   * The recipient's local part this handler owns, lower-case and without a `+tag` (`receipts`), or
   * `*` for every address no other handler claims. Two plugins claiming one local part is a
   * `tests/config/plugins.test.ts` failure; at runtime the first installed wins.
   */
  localPart: string
  /** A name for the logs. */
  name: string
  handle(message: ForwardableEmailMessage, ctx: EmailContext): Promise<void>
}

/** The handler for `to`: an exact local-part match first, then the catch-all, else undefined. */
export function resolveEmailHandler(
  to: string,
  registry: readonly EmailHandler[]
): EmailHandler | undefined {
  const local = emailLocalPart(to)
  return (
    registry.find(h => h.localPart === local) ?? registry.find(h => h.localPart === EMAIL_CATCH_ALL)
  )
}

/** Every installed plugin's handlers, in barrel order. */
export const EMAIL_HANDLERS: readonly EmailHandler[] = serverPlugins.flatMap(
  p => p.emailHandlers ?? []
)

/** Routes one message. Exported with an injectable registry for tests. */
export async function dispatchEmail(
  message: ForwardableEmailMessage,
  env: AppBindings,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  registry: readonly EmailHandler[] = EMAIL_HANDLERS
): Promise<void> {
  const config = loadConfig(env)
  const logger = loggerFor(config, { handler: 'email' })
  const handler = resolveEmailHandler(message.to, registry)
  if (!handler) {
    // Addresses only, never the body or subject: a log line is not a mail archive.
    logger.warn({ to: message.to, from: message.from }, 'email: no handler for this recipient')
    message.setReject('Unknown recipient')
    return
  }

  const handle = openDatabase({ ...config, HYPERDRIVE: env.HYPERDRIVE })
  const handlerLogger = logger.child({ emailHandler: handler.name })
  try {
    await handler.handle(message, {
      env,
      config,
      db: handle.db,
      logger: handlerLogger,
      waitUntil: p => ctx.waitUntil(p),
    })
  } catch (error) {
    // Rethrown: an exception is a temporary failure, so the sending server retries. Rejecting here
    // would turn a database blip into a permanent bounce.
    handlerLogger.error({ err: error, to: message.to }, 'email: handler failed')
    throw error
  } finally {
    ctx.waitUntil(handle.close())
  }
}

/** The Worker `email` handler (src/worker.ts). */
export async function email(
  message: ForwardableEmailMessage,
  env: AppBindings,
  ctx: ExecutionContext
): Promise<void> {
  await dispatchEmail(message, env, ctx)
}
