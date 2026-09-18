/**
 * `RequestCtx` (D13, D31) — everything a plugin's route handler needs, as one injected object.
 *
 * A plugin route is a kit route in every respect: `createRouter()`, `validate()` with a contract
 * from the plugin's own shared entry, an authorisation check, a tenant predicate on every query,
 * typed errors. What differs is only where it is REGISTERED (`ServerPlugin.mounts`) and how it
 * reaches the kit — through this context rather than through nine imports.
 *
 * **The adapter is the seam.** `requestCtx(c)` reads the kit's `RouteContext` and nothing else
 * reads it, which is why `cfg` can stay `cfg` inside the kit while every plugin says `config`.
 *
 * The error helpers return `never` and THROW rather than returning an error to throw, so that
 * `if (!row) ctx.notFound('Note not found')` leaves `row` non-null on the next line —
 * `throw ctx.notFound(...)` narrows too but reads worse, and `return ctx.notFound(...)` does not
 * narrow at all.
 *
 * **That narrowing needs `ctx` to be EXPLICITLY annotated**, which is the one trap in this file:
 *
 *     const ctx: RequestCtx = requestCtx(c)   // narrows
 *     const ctx = requestCtx(c)               // does NOT narrow
 *
 * TypeScript applies never-return narrowing only when every name in the call target is explicitly
 * typed, and an inferred `const` is not. The inferred spelling still throws at runtime, so nothing
 * misbehaves — the compiler simply goes on believing the row may be undefined, and the resulting
 * error surfaces in whatever file next touches it rather than here.
 */

import { ERROR_CODES } from '@rocketflare/shared/errors'
import type { JobEnvelope, JobInput } from '@rocketflare/shared/jobs'
import type { PaginationMeta, PaginationQuery } from '@rocketflare/shared/pagination'
import type { Actions, Subjects } from '@rocketflare/shared/permissions'
import { can as canDo, guardPermission } from '../../api/middleware/permissions'
import type { AccessScope } from '../../api/services/access-sql'
import { accessScopeOf } from '../../api/services/access-sql'
import { enqueueJob, enqueueJobs } from '../../api/services/jobs'
import type { Realtime } from '../../api/services/realtime'
import { createR2Storage, type StorageService } from '../../api/services/storage'
import type { AppContext } from '../../api/types'
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '../../api/utils/core/errors'
import { pageWindow, paginated } from '../../api/utils/routes/pagination'
import { uuidParam, withAuthAndDb } from '../../api/utils/routes/route-helpers'
import { createRouter } from '../../api/utils/routes/router'
import { validate } from '../../api/utils/routes/validate'
import { isAdminLevel, isGlobalAdmin, isOwnerLevel, type PluginAuth } from './auth'
import { durableObject, nudgeEntity } from './events'
import type { PluginContext } from './types'

export type { AppRouter } from '../../api/utils/routes/router'
export type { PluginMount } from '../types'
/**
 * The three things a plugin builds a router out of. They are functions rather than context methods
 * because they run at MODULE scope, when the router is defined and no request exists yet.
 */
/** `{ limit, offset }` from a validated `?page=&pageSize=`, for a plugin's own query module. */
export { createRouter, pageWindow, validate }

/**
 * What a route handler is handed.
 *
 * Everything on it is already bound to THIS request and THIS tenant, which is the property that
 * matters: there is no method here that can be pointed at another organisation by accident, and a
 * `tenantId` parameter arriving from a client is therefore always a bug rather than sometimes one.
 */
export interface RequestCtx extends PluginContext, PluginAuth {
  /** Tenant-wide visibility scope (D29) — hand it to a predicate, never to a query as a tenant id. */
  readonly scope: AccessScope

  // ---- authorisation --------------------------------------------------------------------------

  /** 403 unless this role may `action` the `subject`. The KIND of thing, never the row. */
  guard(action: Actions, subject: Subjects): void
  /** The same question without throwing — for branching, e.g. "may they also see the archived ones". */
  can(action: Actions, subject: Subjects): boolean
  /** `true` when this deployment ships the feature AND this organisation has it (D30). */
  hasFeature(name: string): boolean

  // ---- reading the request ---------------------------------------------------------------------

  /**
   * A `:id`-style parameter that must be a UUID. Anything else is a 404, never a database error —
   * which also stops the route being a probe for which id shapes exist.
   */
  uuid(name: string): string
  /** The value `validate('json' | 'query' | 'param', schema)` already parsed. */
  valid<T>(target: 'json' | 'query' | 'param' | 'form' | 'header' | 'cookie'): T

  // ---- answering ---------------------------------------------------------------------------

  /** `{ items, pagination }` — the one list shape every consumer parses. */
  page<T>(
    items: T[],
    total: number,
    query: PaginationQuery
  ): { items: T[]; pagination: PaginationMeta }

  // ---- side effects ---------------------------------------------------------------------------

  /**
   * Run something that may outlive the response (an email, an audit write, a nudge). It goes
   * through `waitUntil`, is never awaited on the response path, and LOGS rather than throws — so a
   * failed side effect cannot fail a request that already succeeded.
   */
  defer(fn: () => Promise<unknown>): void
  /**
   * Hand work to `JOBS_QUEUE`. **A route never runs long work.** A missing binding throws rather
   * than running inline, because silently doing the work in the request is how a 30-second route
   * gets shipped.
   */
  enqueue(input: JobInput, options?: { delaySeconds?: number }): Promise<JobEnvelope>
  enqueueMany(inputs: readonly JobInput[], options?: { delaySeconds?: number }): Promise<void>
  /**
   * Tell this organisation's open tabs that a family of rows moved. `entity` IS the query-key
   * family root, so declaring it once covers the socket wiring (D8).
   */
  nudge(entity: string, id?: string): void
  /** R2, or a 503 `storage_not_configured` — loud, because a silently absent bucket loses bytes. */
  storage(): StorageService
  /** A per-tenant Durable Object stub. The plugin never spells the name; the prefix is structural. */
  durableObject<T extends Rpc.DurableObjectBranded | undefined = undefined>(
    namespace: DurableObjectNamespace<T>,
    key?: string
  ): DurableObjectStub<T>

  // ---- failing -----------------------------------------------------------------------------

  notFound(message?: string, code?: string): never
  badRequest(message?: string, code?: string, details?: unknown): never
  forbidden(message?: string, code?: string): never
  unauthorized(message?: string): never
  conflict(message?: string, code?: string, details?: unknown): never
  unavailable(message?: string, code?: string): never

  // ---- escaping ------------------------------------------------------------------------------

  /**
   * A snapshot of this context that outlives the handler (D31).
   *
   * There is exactly one situation this is for: a plugin hands a CALLBACK to a library, and the
   * library calls it somewhere no Hono context exists. The analytics plugin's cube security
   * function is the worked example — drizzle-cube invokes it per query, and reaching for
   * `c.get('auth')` in there is reaching for a request that has gone.
   *
   * Build it IN the handler and pass it down. `RequestCtx` itself is deliberately NOT widened to
   * work outside a handler: half its methods are about a request (`valid`, `uuid`, `defer`), and a
   * context that silently half-works is worse than one that is a different type.
   */
  detached(): DetachedCtx
  /** The realtime handle, for a plugin service that takes `realtime?` the way the kit's do. */
  readonly realtime: Realtime
}

/**
 * What survives the handler: data and a database, no request.
 *
 * It carries no `defer` (nothing left to attach the work to), no `valid`/`uuid` (no request to read)
 * and no `guard` (the ability is a request-scoped object). Everything it DOES carry is either a
 * value or a handle the caller is already responsible for.
 */
export interface DetachedCtx extends PluginContext {
  tenantId: string
  userId: string
  role: PluginAuth['role']
  isAdmin: boolean
  features: readonly string[]
  scope: AccessScope
}

/**
 * Build a plugin's request context from the kit's.
 *
 * This is the ONLY function in the plugin surface that names `withAuthAndDb`, `c.get(...)` or
 * `cfg` — which is what makes "a plugin receives everything as injected context" a rule a source
 * scan can enforce rather than a habit.
 */
export function requestCtx(c: AppContext): RequestCtx {
  const route = withAuthAndDb(c)
  const { auth } = route
  let scope: AccessScope | undefined

  const ctx: RequestCtx = {
    db: route.db,
    config: route.cfg,
    logger: route.logger,
    env: c.env,

    user: route.user,
    userId: route.user.id,
    tenantId: route.tenantId,
    role: auth.tenantUser?.role ?? null,
    isAdmin: isAdminLevel(auth),
    isOwner: isOwnerLevel(auth),
    isGlobalAdmin: isGlobalAdmin(auth),
    features: auth.features,

    // Lazy: most routes never ask, and building it walks the session's groups.
    get scope() {
      scope ??= accessScopeOf(auth)
      return scope
    },

    realtime: route.realtime,

    guard: (action, subject) => {
      guardPermission(c, action, subject)
    },
    can: (action, subject) => canDo(c, action, subject),
    hasFeature: name => auth.features.includes(name),

    uuid: name => uuidParam(c, name),
    valid: <T>(target: 'json' | 'query' | 'param' | 'form' | 'header' | 'cookie') =>
      (c.req as unknown as { valid(t: string): T }).valid(target),

    page: (items, total, query) => paginated(items, total, query),

    defer: route.defer,
    enqueue: (input, options) => enqueueJob(c.env.JOBS_QUEUE, input, options),
    enqueueMany: async (inputs, options) => {
      await enqueueJobs(c.env.JOBS_QUEUE, inputs, options)
    },
    nudge: (entity, id) => nudgeEntity(route.realtime, route.tenantId, entity, id),
    storage: () => {
      if (!c.env.FILES) {
        throw new ServiceUnavailableError(
          'File storage is not configured',
          'storage_not_configured'
        )
      }
      return createR2Storage(c.env.FILES)
    },
    durableObject: (namespace, key) => durableObject(namespace, route.tenantId, key),

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
    conflict: (message = 'Conflict', code = ERROR_CODES.conflict, details) => {
      throw new ConflictError(message, code, details)
    },
    unavailable: (message = 'Service unavailable', code) => {
      throw new ServiceUnavailableError(message, code)
    },

    detached: () => ({
      db: route.db,
      config: route.cfg,
      logger: route.logger,
      env: c.env,
      tenantId: route.tenantId,
      userId: route.user.id,
      role: auth.tenantUser?.role ?? null,
      isAdmin: isAdminLevel(auth),
      features: auth.features,
      scope: ctx.scope,
    }),
  }
  return ctx
}
