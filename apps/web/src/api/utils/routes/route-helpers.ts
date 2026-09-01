/**
 * The ONLY sanctioned way to read auth in a route (02 §4, D10, D25).
 *   `const { db, tenantId, user } = withAuthAndDb(c)`  — tenant required: 403 `no_tenant` /
 *                                                        `pending_approval` when there is none
 *   `const { db, user } = withAuth(c)`                  — tenant-free (invite accept, pending
 *                                                        invitations, access requests, /admin)
 * Never `c.get('auth' | 'db')` by hand in a route. `defer(fn)` runs a side effect through
 * `waitUntil` (awaited inline when there is no ExecutionContext — tests, Node tooling) and logs
 * instead of throwing, so an email or activity write can never fail the response. `realtime`
 * bundles that `defer` with the hub binding for `services/realtime.ts` nudges (D8) — routes pass
 * it to services, never touch `NOTIFICATIONS_HUB` themselves. `tracer` (D16) is the request's
 * Langfuse batcher (or the no-op) for `withAgentTrace` / `traceChatClient`.
 */
import { ERROR_CODES } from '@rocketflare/shared/errors'
import type { PinoLogger } from 'hono-pino'
import type { AppConfig } from '../../../config'
import {
  createDatabase,
  type Database,
  type DatabaseHandle,
  resolveDatabaseUrl,
} from '../../../db/client'
import type { User } from '../../../db/schema'
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
  /** D16: per-request tracer; flushed by `tracerMiddleware` after the handler (streams flush themselves). */
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

/** D25: routes that only make sense multi-tenant answer 404 `tenancy_mode_single` in `single`. */
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
 * stream's `finally`. Same URL resolution as the middleware (D2).
 */
export function streamDatabase(c: AppContext): DatabaseHandle {
  const cfg = c.get('config')
  return createDatabase(
    resolveDatabaseUrl({
      HYPERDRIVE: c.env.HYPERDRIVE,
      PREVIEW_DATABASE_URL: cfg.PREVIEW_DATABASE_URL,
      DATABASE_URL: cfg.DATABASE_URL,
    })
  )
}
