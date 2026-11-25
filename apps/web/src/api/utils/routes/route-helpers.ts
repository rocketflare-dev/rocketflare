/**
 * The ONLY sanctioned way to read auth in a route.
 *   `const { db, tenantId, user } = withAuthAndDb(c)`  — tenant required: 403 `no_tenant` /
 *                                                        `pending_approval` when there is none
 *   `const { db, user } = withAuth(c)`                  — tenant-free (the caller's profile,
 *                                                        /admin)
 *   `const { db, user } = withAccountAuth(c)`           — tenant-free AND about the person's
 *                                                        whole account (create an organisation,
 *                                                        pending invitations, access requests):
 *                                                        403 `insufficient_scope` for an API key,
 *                                                        which acts only within its organisation
 * Never `c.get('auth' | 'db')` by hand in a route. `defer(fn)` runs a side effect through
 * `waitUntil` (awaited inline when there is no ExecutionContext — tests, Node tooling) and logs
 * instead of throwing, so an email or activity write can never fail the response. `realtime`
 * bundles that `defer` with the hub binding for `services/realtime.ts` nudges — routes pass
 * it to services, never touch `NOTIFICATIONS_HUB` themselves. `tracer` is the request's
 * Langfuse batcher (or the no-op) for `withAgentTrace` / `traceChatClient`.
 */
import { ERROR_CODES } from '@rocketflare/shared/errors'
import type { PinoLogger } from 'hono-pino'
import type { AppConfig } from '../../../config'
import { type Database, type DatabaseHandle, openDatabase } from '../../../db/client'
import type { User } from '../../../db/schema'
import { isApiKeySession } from '../../auth/api-key-session'
import { deferOrAwait } from '../../middleware/database'
import { requireAuth } from '../../middleware/permissions'
import { noopTracer, type Tracer } from '../../observability/tracer'
import type { Realtime } from '../../services/realtime'
import type { AppContext, AuthContext } from '../../types'
import { ForbiddenError, NotFoundError } from '../../utils/core/errors'

export type Defer = (fn: () => Promise<unknown>) => void

export interface TenantFreeRouteContext {
  auth: AuthContext
  user: User
  /** Null when the session has no membership — use `withAuthAndDb` to require one. */
  tenantId: string | null
  db: Database
  cfg: AppConfig
  logger: PinoLogger
  defer: Defer
  realtime: Realtime
  /** Per-request tracer; flushed by `tracerMiddleware` after the handler (streams flush themselves). */
  tracer: Tracer
}

export interface RouteContext extends TenantFreeRouteContext {
  tenantId: string
}

export function makeDefer(c: AppContext): Defer {
  return fn => {
    void deferOrAwait(c, () =>
      fn().catch(err => {
        c.get('logger').warn({ err }, 'Deferred side effect failed')
      })
    )
  }
}

export function withAuth(c: AppContext): TenantFreeRouteContext {
  const auth = requireAuth(c)
  const defer = makeDefer(c)
  return {
    auth,
    user: auth.user,
    tenantId: auth.tenantId,
    db: c.get('db'),
    cfg: c.get('config'),
    logger: c.get('logger'),
    defer,
    realtime: { defer, env: c.env },
    tracer: safeTracer(c),
  }
}

/**
 * Tenant-free, and reaching past the current organisation into the person's account. An API key
 * belongs to ONE organisation: it may act there and on its creator's own profile, never on the
 * creator's other organisations, invitations or access requests — so a key is refused here.
 */
export function withAccountAuth(c: AppContext): TenantFreeRouteContext {
  const ctx = withAuth(c)
  if (isApiKeySession(ctx.auth)) {
    throw new ForbiddenError(
      'An API key acts only within its own organisation; sign in to do this',
      ERROR_CODES.insufficientScope
    )
  }
  return ctx
}

/** A router mounted without `tracerMiddleware` (tests of a bare router) still gets a tracer. */
function safeTracer(c: AppContext): Tracer {
  try {
    return c.get('tracer') ?? noopTracer
  } catch {
    return noopTracer
  }
}

export function withAuthAndDb(c: AppContext): RouteContext {
  const ctx = withAuth(c)
  if (!ctx.tenantId) {
    if (ctx.auth.accessRequestStatus === 'pending') {
      throw new ForbiddenError(
        'Your access request is awaiting approval',
        ERROR_CODES.pendingApproval
      )
    }
    throw new ForbiddenError('No organisation selected', ERROR_CODES.noTenant)
  }
  return { ...ctx, tenantId: ctx.tenantId }
}

/** Routes that only make sense multi-tenant answer 404 `tenancy_mode_single` in `single`. */
export function requireMultiTenant(cfg: AppConfig): void {
  if (cfg.TENANCY_MODE === 'single') {
    throw new NotFoundError('Not available in single-tenant mode', ERROR_CODES.tenancyModeSingle)
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A `:id`-style param that must be a UUID; anything else is a 404 (never a DB error). */
export function uuidParam(c: AppContext, name: string): string {
  const value = c.req.param(name)
  if (!value || !UUID_RE.test(value)) throw new NotFoundError(`Not found: ${name}`)
  return value
}

/**
 * A SECOND database client for a streaming response (SSE). `databaseMiddleware` ends the request's
 * client in `waitUntil` as soon as the handler returns the Response — which for `streamSSE` is
 * before the stream body runs — so writes made while streaming need their own handle, closed in the
 * stream's `finally`. Same driver and URL as the middleware.
 */
export function streamDatabase(c: AppContext): DatabaseHandle {
  const cfg = c.get('config')
  return openDatabase({ ...cfg, HYPERDRIVE: c.env.HYPERDRIVE })
}
