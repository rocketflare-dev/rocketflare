/**
 * The plugin context family (D31) — the base every execution context extends, and the handful of
 * types a plugin must be able to NAME rather than receive.
 *
 * **Why this layer exists.** The documented plugin contract is "four published entries per plugin".
 * The measured reality across the two plugins that existed when this was written was 128 distinct
 * (module, symbol) pairs reaching into 55 kit modules, some of them six relative levels deep into
 * `apps/web/tests/**`. None of that was carelessness: the kit had no other way to hand a plugin a
 * database handle, a logger, a tenant id or a `guardPermission`.
 *
 * The fix is not a longer allow-list. Nearly every one of those symbols already took an execution
 * context as its FIRST argument — `guardPermission(c, …)`, `uuidParam(c, 'id')`, `nudge(realtime,
 * …)`, `enqueueJob(env.JOBS_QUEUE, …)` — so nearly every one was a method in waiting. The kit was
 * already injecting context in five places nobody had recognised as a family, and they had drifted
 * accordingly: `cfg` in `RouteContext` and `AgentContext`, `config` in `JobContext` and
 * `TaskContext`. This module names the family, and every context below standardises on `config`.
 *
 * **These are thin ADAPTERS over the kit's internal contexts, not the same objects.** That is
 * load-bearing twice over. It lets kit internals move — rename a field, split a context, add one —
 * without moving a plugin's ground. And it is what let this land additively: the adapter is the
 * only place that names `cfg`, so the plugin surface reads `config` while not one kit route
 * changed.
 *
 * The adapter being the ONLY place kit internals are named is also what makes the enforcement rule
 * (`tests/helpers/plugins.ts`) one sentence rather than a table: *a plugin imports only from
 * declared entries, and receives everything else as injected context.*
 */

import type { AppBindings } from '../../api/types'
import type { Logger } from '../../api/utils/core/logger'
import type { AppConfig } from '../../config'
import type { Database, DatabaseHandle } from '../../db/client'

/**
 * The four things every execution context carries, whatever invoked it.
 *
 * `config`, not `cfg` — one spelling across all seven contexts. The kit's own `RouteContext` and
 * `AgentContext` still say `cfg` internally and are not being churned for this; the adapters map
 * it, which is the whole point of there being adapters.
 */
export interface PluginContext {
  /**
   * The drizzle handle for THIS unit of work, and never a value to store: a request's client is
   * closed in `waitUntil` the moment the Response is returned, a job's in the consumer's
   * `finally`, and a Workflow step's when that step ends.
   */
  db: Database
  /** Validated config, including whatever this plugin's `SharedPlugin.config` added to the schema. */
  config: PluginConfig
  logger: PluginLogger
  /**
   * The Worker bindings. A plugin reads the ones its own `plugin.json` declares; reaching for a
   * kit binding directly is usually the sign that a method is missing from this surface.
   */
  env: PluginBindings
}

// ---- Bare types a plugin NAMES rather than receives ----------------------------------------------

/**
 * The types below are not obtained from a context, and that is not an oversight.
 *
 * They are the PARAMETER types of a plugin's own internal service functions — the `(db, tenantId,
 * …)` modules the kit's service rule asks for, which one plugin calls from a route, a job, a hook
 * and an agent tool alike. Such a function cannot take "whichever context this is"; it takes a
 * `Database` and a `Logger`. So they have to stay nameable standalone, from a declared entry.
 *
 * `Database` and `Logger` are the two the measurement actually found being imported for exactly
 * this reason. The other two are here because the same argument covers them.
 */
export type { Database, DatabaseHandle, Logger }

/** What `ctx.config` is, named so a plugin's own function signature can take it. */
export type PluginConfig = AppConfig

/**
 * The four level methods, and deliberately no more.
 *
 * A request carries hono-pino's `PinoLogger` while a job, a cron task and a Workflow step carry a
 * plain pino `Logger`, and the two are NOT the same type — the request one has no `level`, `silent`
 * or `msgPrefix`. Typing the family as either would force a cast at one of the adapters, and a cast
 * in an adapter is exactly the kind of small lie this layer exists to avoid. Narrowing to what the
 * two genuinely share costs a plugin nothing: everything logs, nothing reconfigures a logger it did
 * not create.
 *
 * `child()` is absent for the same reason — the request logger is already bound to its request id,
 * and a plugin re-binding it would detach its lines from the request they belong to.
 */
export type PluginLogger = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>

/** What `ctx.env` is (`Cloudflare.Env`), named for the same reason. */
export type PluginBindings = AppBindings
