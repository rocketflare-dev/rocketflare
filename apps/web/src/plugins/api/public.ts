/**
 * `PublicCtx` (D31, D34) — what a plugin's PUBLIC route handler is handed: an admin-consent
 * callback, a webhook, a push endpoint. Anything a third party calls, which carries no session and
 * no API key.
 *
 * A public mount is `ServerPlugin.publicMounts`, at `/api/hooks/<plugin id>` and beneath it, and
 * the host mounts it with NO `authMiddleware` — every other global still applies (request id,
 * logger, config, security headers, the JSON body limit, CORS, cookie-only CSRF, the per-request
 * database, the tracer). The prefix is structural rather than conventional because it is what
 * keeps the unauthenticated surface ENUMERABLE: `tests/config/plugins.test.ts` refuses a public
 * mount anywhere else, and refuses an authed mount under `/api/hooks`.
 *
 * **There is no tenant here, and that is the point of the type.** A request to a public mount has
 * not proved who it is; the handler proves it — a `verifyState` token it minted, a `clientState`
 * it stored, a signature the provider sent — and only THEN knows which organisation the request is
 * about. So nothing on this context is bound to one, every method that needs one takes it, and the
 * database handle is the unscoped one a job gets. A query in a public handler is therefore always
 * `where tenant_id = <the id the handler just proved>`, never an ambient value.
 *
 * Answer fast. A provider that sends webhooks usually wants a 2xx inside a few seconds and treats
 * a slow endpoint as a failing one (Microsoft Graph: 3 s), so the shape is verify → `enqueue` →
 * 202, with the real work in a job. That is the kit's own rule — routes enqueue, never run.
 */

import { ERROR_CODES } from '@rocketflare/shared/errors'
import type { AppContext } from '../../api/types'
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../api/utils/core/errors'
import { makeDefer } from '../../api/utils/routes/route-helpers'
import { type BackgroundMethods, backgroundMethods } from './jobs'
import type { PluginContext } from './types'

/** The prefix every public mount lives under; the plugin's id is the next segment. */
export const PUBLIC_MOUNT_ROOT = '/api/hooks'

export interface PublicCtx extends PluginContext, BackgroundMethods {
  /** `APP_URL` — the origin a third party is told to call back, and to redirect a browser to. */
  readonly appUrl: string
  /** As on `RequestCtx`: through `waitUntil`, never awaited, logged rather than thrown. */
  defer(fn: () => Promise<unknown>): void
  notFound(message?: string, code?: string): never
  badRequest(message?: string, code?: string, details?: unknown): never
  forbidden(message?: string, code?: string): never
  unauthorized(message?: string): never
}

/** Build a public handler's context. The only function here that reads the Hono context. */
export function publicCtx(c: AppContext): PublicCtx {
  const base: PluginContext = {
    db: c.get('db'),
    config: c.get('config'),
    logger: c.get('logger'),
    env: c.env,
  }
  return {
    ...base,
    ...backgroundMethods(base),
    appUrl: base.config.APP_URL,
    defer: makeDefer(c),
    notFound: (message = 'Not found', code = ERROR_CODES.notFound) => {
      throw new NotFoundError(message, code)
    },
    badRequest: (message = 'Bad request', code, details) => {
      throw new BadRequestError(message, code, details)
    },
    forbidden: (message = 'Forbidden', code = ERROR_CODES.forbidden) => {
      throw new ForbiddenError(message, code)
    },
    unauthorized: (message = 'Unauthorized') => {
      throw new UnauthorizedError(message)
    },
  }
}
