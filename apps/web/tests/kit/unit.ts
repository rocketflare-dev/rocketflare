/**
 * `@testkit/unit` — builders for the plugin context family (D31).
 *
 * Every execution context a plugin is handed (`RequestCtx`, `JobCtx`, `CronCtx`, `WorkflowCtx`,
 * `ToolCtx`) is built here from plain options, so a test can exercise a handler's BRANCHING without
 * standing up a request: the feature gate, the ownership check, the 404 versus the 403, the shape of
 * what comes back.
 *
 * **Every builder requires a `db` the integration harness handed out, and that is the load-bearing
 * rule of this file.** See `./real-db.ts` for why: injection is exactly what makes it easy to write
 * a test that looks like an isolation proof and proves nothing, because a stub returning `[]`
 * satisfies "tenant B sees no rows" whatever the query actually said. So a fake context may test
 * branching, guards and response shape; **anything that touches data is on real Postgres by
 * construction.**
 *
 * The accepted cost, stated rather than discovered later: **there is no fast, database-free test of
 * a data-touching handler.** A slower suite is the price of an isolation case that cannot be faked
 * into passing, and a plugin's isolation case is the one thing the kit treats as non-negotiable —
 * it drives the real mount through `request(...)` from `@testkit/integration` as a second tenant.
 *
 * These are the kit's own adapters (`requestCtx`, `jobCtx`, `cronCtx`, `workflowCtx`, `toolCtx`)
 * wherever one can be reached without a Hono context, so a builder cannot drift from the thing it
 * builds. `makeRequestCtx` is the exception and says so on itself.
 */

import type { GroupRef } from '@rocketflare/shared/groups'
import type { PaginationQuery } from '@rocketflare/shared/pagination'
import type { Actions, Subjects } from '@rocketflare/shared/permissions'
import type { MembershipRole } from '@rocketflare/shared/tenants'
import type { AgentToolContext } from '@/api/services/agents/tools'
import { createR2Storage } from '@/api/services/storage'
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '@/api/utils/core/errors'
import { createLogger, type Logger } from '@/api/utils/core/logger'
import { paginated } from '@/api/utils/routes/pagination'
import { type AppConfig, loadConfig } from '@/config'
import type { Database } from '@/db/client'
import type { User } from '@/db/schema'
import { buildAbility } from '@/permissions'
import type { AccessScope } from '@/plugins/api'
import { durableObject, nudgeEntity } from '@/plugins/api'
import type { ToolCtx } from '@/plugins/api/ai'
import { toolCtx } from '@/plugins/api/ai'
import type { RequestCtx } from '@/plugins/api/http'
import type { CronCtx, JobCtx } from '@/plugins/api/jobs'
import { cronCtx, jobCtx } from '@/plugins/api/jobs'
import type { PluginLogger } from '@/plugins/api/types'
import type { WorkflowCtx } from '@/plugins/api/workflow'
import { workflowCtx } from '@/plugins/api/workflow'
import { createTestEnv, type TestEnv } from '../mocks/bindings'
import { createFakeWorkflowStep } from '../mocks/cloudflare-workers'
import { assertRealDatabase } from './real-db'

/** Everything every builder needs: a real handle, and optionally the env and config around it. */
interface BaseOptions {
  /** From `setupTestDatabase()` — see the file header. A handle built by hand is refused. */
  db: Database
  /** Defaults to a fresh `createTestEnv()`. Keep a reference to read `stubs(env)` afterwards. */
  env?: TestEnv
  config?: AppConfig
  logger?: PluginLogger
}

/** Silent by default: a builder is used in tests that assert on values, not on log lines. */
function silentLogger(): Logger {
  return createLogger({ level: 'silent' })
}

function baseParts(options: BaseOptions, builder: string) {
  assertRealDatabase(options.db, builder)
  const env = options.env ?? createTestEnv()
  const config = options.config ?? loadConfig(env)
  const logger = options.logger ?? silentLogger()
  return { db: options.db, env, config, logger }
}

// ---- RequestCtx --------------------------------------------------------------------------------

export interface RequestCtxOptions extends BaseOptions {
  /** The active organisation — the only tenant id a query may filter by. */
  tenantId: string
  userId?: string
  /** A real row when the test has one; otherwise a plausible one is built from `userId`. */
  user?: User
  role?: MembershipRole | null
  isGlobalAdmin?: boolean
  /** Flags ON for this organisation — what `ctx.hasFeature` reads, never the ability (D30). */
  features?: readonly string[]
  /** Group memberships, for a visibility predicate (D29). */
  groupIds?: string[]
  /**
   * The same memberships WITH their type names — what `ctx.groups` answers, and what anything
   * narrowing or labelling by group TYPE needs. Give these instead of `groupIds` and the ids are
   * taken from them, so the two halves cannot disagree in a test the way they could in a session.
   */
  groups?: readonly GroupRef[]
  /** What `ctx.valid('json' | 'query' | …)` answers — the values `validate()` would have parsed. */
  valid?: Partial<Record<'json' | 'query' | 'param' | 'form' | 'header' | 'cookie', unknown>>
  /** What `ctx.uuid(name)` answers. A name that is absent or not a UUID is a 404, as in a route. */
  params?: Record<string, string>
}

/**
 * What a fake request context carries beyond the real one: the deferred work it collected.
 *
 * A route's `defer` goes through `waitUntil`, which a builder has no invocation to hang on — so it
 * collects instead, and `settle()` is the test's stand-in for the platform draining it. Asserting
 * that something WAS deferred (rather than awaited on the response path) is usually the point.
 */
export type FakeRequestCtx = RequestCtx & {
  readonly deferred: ReadonlyArray<() => Promise<unknown>>
  /** Run everything deferred so far, swallowing failures exactly as `defer` does. */
  settle(): Promise<void>
}

/**
 * A plausible `users` row, for a test that has a tenant but no person it cares about.
 *
 * Cast rather than built column by column on purpose: this is a fixture for code that reads `id`
 * and occasionally `email`, and spelling out every column would make an unrelated schema change a
 * failing test in the test kit.
 */
function fakeUser(userId: string, isGlobalAdmin: boolean): User {
  const now = new Date()
  return {
    id: userId,
    email: `fake-${userId}@example.test`,
    name: 'Fake User',
    avatarUrl: null,
    isGlobalAdmin,
    emailVerifiedAt: now,
    lastLoginAt: null,
    blockedAt: null,
    createdAt: now,
    updatedAt: now,
  } as User
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A `RequestCtx` with no request behind it.
 *
 * This one is assembled rather than adapted, because `requestCtx(c)` reads a Hono context and there
 * is not one — and a half-built `AppContext` would be a fake of the kit's internals, which is worse
 * than a fake of its published surface. The consequence is stated plainly: **this is the one builder
 * that can drift from what it models**, so behaviour that depends on the real middleware chain
 * (CSRF, the body limit, `validate()`'s own 400, the feature-gate middleware on the MOUNT) is only
 * ever proven by `request(...)` from `@testkit/integration`.
 *
 * What it does model faithfully: `guard`/`can` run the REAL `buildAbility`, including the plugin
 * grants merged into it, so a permission answer here is the answer the app gives.
 */
export function makeRequestCtx(options: RequestCtxOptions): FakeRequestCtx {
  const { db, env, config, logger } = baseParts(options, 'makeRequestCtx')
  const userId = options.userId ?? options.user?.id ?? crypto.randomUUID()
  const isGlobalAdmin = options.isGlobalAdmin ?? options.user?.isGlobalAdmin ?? false
  const user = options.user ?? fakeUser(userId, isGlobalAdmin)
  const role = options.role === undefined ? 'owner' : options.role
  const features = options.features ?? []
  const ability = buildAbility({ role, isGlobalAdmin, features })
  const isAdmin = isGlobalAdmin || role === 'owner' || role === 'admin' || role === 'support'
  const isOwner = isGlobalAdmin || role === 'owner'

  const deferred: Array<() => Promise<unknown>> = []
  const defer = (fn: () => Promise<unknown>) => {
    deferred.push(fn)
  }
  const realtime = { defer, env }

  const groups = options.groups ?? []
  const scope: AccessScope = {
    tenantId: options.tenantId,
    userId,
    groupIds: options.groupIds ?? groups.map(g => g.id),
    bypass: isAdmin,
  }

  const ctx: FakeRequestCtx = {
    db,
    config,
    logger,
    env,

    user,
    userId,
    tenantId: options.tenantId,
    role,
    isAdmin,
    isOwner,
    isGlobalAdmin,
    features,
    scope,
    groups,
    realtime,

    // Lazily imported for the same reason the real adapter does it: `services/access` composes the
    // visibility registry by reading the plugin barrel. These are the REAL helpers over the real
    // handle, so a test of a plugin's visibility rules is testing the kit's, not a restatement.
    visibility: {
      resolve: async input => {
        const { resolveRequestedVisibility } = await import('@/api/services/access')
        return resolveRequestedVisibility(db, scope, input)
      },
      set: async (kind, resourceId, input) => {
        const { setResourceGroups } = await import('@/api/services/access')
        return setResourceGroups(db, scope, kind, resourceId, input)
      },
      grantsFor: async (kind, resourceIds) => {
        const { grantsForResources } = await import('@/api/services/access')
        return grantsForResources(db, options.tenantId, kind, [...resourceIds])
      },
    },

    guard: (action: Actions, subject: Subjects) => {
      if (!ability.can(action, subject)) {
        throw new ForbiddenError(`You do not have permission to ${action} ${subject}`)
      }
    },
    can: (action: Actions, subject: Subjects) => ability.can(action, subject),
    hasFeature: name => features.includes(name),

    uuid: name => {
      const value = options.params?.[name]
      if (!value || !UUID_RE.test(value)) throw new NotFoundError(`Not found: ${name}`)
      return value
    },
    valid: <T>(target: 'json' | 'query' | 'param' | 'form' | 'header' | 'cookie') => {
      if (!options.valid || !(target in options.valid)) {
        throw new Error(
          `makeRequestCtx: ctx.valid('${target}') was called but no '${target}' value was given — ` +
            `pass it as { valid: { ${target}: … } }.`
        )
      }
      return options.valid[target] as T
    },

    page: <T>(items: T[], total: number, query: PaginationQuery) => paginated(items, total, query),

    defer,
    enqueue: async (input, opts) => {
      const { enqueueJob } = await import('@/api/services/jobs')
      return enqueueJob(env.JOBS_QUEUE, input, opts)
    },
    enqueueMany: async (inputs, opts) => {
      const { enqueueJobs } = await import('@/api/services/jobs')
      await enqueueJobs(env.JOBS_QUEUE, inputs, opts)
    },
    nudge: (entity, id) => nudgeEntity(realtime, options.tenantId, entity, id),
    storage: () => {
      if (!env.FILES) {
        throw new ServiceUnavailableError(
          'File storage is not configured',
          'storage_not_configured'
        )
      }
      return createR2Storage(env.FILES)
    },
    durableObject: (namespace, key) => durableObject(namespace, options.tenantId, key),

    notFound: (message = 'Not found', code?: string) => {
      throw new NotFoundError(message, code)
    },
    badRequest: (message = 'Bad request', code?: string, details?: unknown) => {
      throw new BadRequestError(message, code, details)
    },
    forbidden: (message = 'Forbidden', code?: string) => {
      throw new ForbiddenError(message, code)
    },
    unauthorized: (message = 'Unauthorized') => {
      throw new UnauthorizedError(message)
    },
    conflict: (message = 'Conflict', code?: string, details?: unknown) => {
      throw new ConflictError(message, code, details)
    },
    unavailable: (message = 'Service unavailable', code?: string) => {
      throw new ServiceUnavailableError(message, code)
    },

    detached: () => ({
      db,
      config,
      logger,
      env,
      tenantId: options.tenantId,
      userId,
      role,
      isAdmin,
      features,
      scope,
      groups,
    }),

    deferred,
    settle: async () => {
      const batch = deferred.splice(0, deferred.length)
      await Promise.all(batch.map(fn => fn().catch(() => {})))
    },
  }
  return ctx
}

// ---- JobCtx and CronCtx ------------------------------------------------------------------------

/**
 * One queue message's context, through the kit's own `jobCtx` adapter.
 *
 * Neither background context carries a `tenantId`, deliberately: a job's tenant comes from its
 * PAYLOAD. If a handler under test reaches for one on the context, that is the bug the missing
 * field exists to catch, and no option here will supply it.
 */
export function makeJobCtx(options: BaseOptions): JobCtx {
  const { db, env, config, logger } = baseParts(options, 'makeJobCtx')
  return jobCtx({ db, env, config, logger: logger as Logger })
}

export interface CronCtxOptions extends BaseOptions {
  /** Defaults to collecting; a cron invocation genuinely has a `waitUntil`, unlike a queue one. */
  waitUntil?: (promise: Promise<unknown>) => void
}

export function makeCronCtx(options: CronCtxOptions): CronCtx {
  const { db, env, config, logger } = baseParts(options, 'makeCronCtx')
  const pending: Promise<unknown>[] = []
  return cronCtx({
    db,
    env,
    config,
    logger: logger as Logger,
    waitUntil: options.waitUntil ?? (p => pending.push(p)),
  })
}

// ---- WorkflowCtx -------------------------------------------------------------------------------

/** The fake step recorder, so a test can assert the NAMES a run asked for and their order. */
export type FakeWorkflowCtx = WorkflowCtx & {
  readonly recorded: ReturnType<typeof createFakeWorkflowStep>
}

export interface WorkflowCtxOptions extends BaseOptions {
  /** Payloads for `waitForEvent`, in order. With none, a wait throws the timeout error. */
  events?: unknown[]
  /** The test's stand-in for a person clicking Approve — it must flip the ROW before the wait resolves. */
  onWait?: Parameters<typeof createFakeWorkflowStep>[0] extends infer O
    ? O extends { onWait?: infer F }
      ? F
      : never
    : never
}

/**
 * A `WorkflowCtx` over a recording step.
 *
 * **`db` is required here but is not the handle the steps use**, and that is worth reading rather
 * than working out from a surprise. The kit's rule is one client per STEP, opened when the step body
 * starts and closed when it ends whatever happens — so `workflowCtx` opens its own from
 * `env.HYPERDRIVE`, which `createTestEnv()` already points at the test database. What `db` proves is
 * that the integration harness is RUNNING: a workflow step hits real Postgres the instant it
 * executes, and without this assertion a test that never started the harness fails inside the step
 * body with a connection error instead of here, naming the fix.
 *
 * `recorded.names` is the one property no other fake can check: a step name is that step's identity
 * to the platform, and a repeated one replays the first call's recorded result rather than running
 * again — which reads exactly like "the agent ignored my approval". `workflowCtx` throws
 * `DuplicateStepNameError` on a repeat within one execution; asserting the names are DISTINCT is how
 * a test proves the round number made it into them.
 */
export function makeWorkflowCtx(options: WorkflowCtxOptions): FakeWorkflowCtx {
  const { env, config, logger } = baseParts(options, 'makeWorkflowCtx')
  const recorded = createFakeWorkflowStep({
    ...(options.events && { events: options.events }),
    ...(options.onWait && { onWait: options.onWait }),
  })
  // The fake covers `do` and `waitForEvent`; the platform type declares rollback options and a
  // step context neither the kit's workflow nor a plugin's uses. Same cast, and same reason, as
  // `tests/api/agent-run-workflow.test.ts` — the alias makes them one object at runtime.
  const step = recorded.step as unknown as Parameters<typeof workflowCtx>[0]
  const ctx = workflowCtx(step, env, config, logger as Logger)
  return Object.assign(ctx, { recorded })
}

// ---- ToolCtx -----------------------------------------------------------------------------------

export interface ToolCtxOptions extends BaseOptions {
  tenantId: string
  /** Who the run is FOR. A tool reads what its requester may read, never a tenant it chose itself. */
  userId?: string | null
  groupIds?: string[]
  /** Admin-level requesters are not narrowed by visibility (D29). Defaults to `true`, as a system run. */
  bypass?: boolean
  /** The CALLER's budget for one document window — an agent run's is far larger than a chat turn's. */
  maxDocumentChars?: number
}

/**
 * What `ServerPlugin.agentTools(ctx)` is handed, through the kit's own `toolCtx` adapter.
 *
 * The tenant arrives as part of a `scope`, not as a bare id, and that is the whole safety property:
 * a tool bound to a scope answers what the person who STARTED the run may read. A `tenantId` on a
 * tool's own input schema would be the model choosing its own tenant.
 */
export function makeToolCtx(options: ToolCtxOptions): ToolCtx {
  const { db, env, config } = baseParts(options, 'makeToolCtx')
  const agentToolContext: AgentToolContext = {
    db,
    cfg: config,
    env,
    scope: {
      tenantId: options.tenantId,
      userId: options.userId ?? null,
      groupIds: options.groupIds ?? [],
      bypass: options.bypass ?? true,
    },
    ...(options.maxDocumentChars !== undefined && { maxDocumentChars: options.maxDocumentChars }),
  }
  return toolCtx(agentToolContext)
}
