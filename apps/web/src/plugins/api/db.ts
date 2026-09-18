/**
 * Database access and the lifecycle contexts that have a `db` but no request (D31).
 *
 * The kit's connection rule is unchanged: **one client per unit of work, closed by whoever opened
 * it.** A plugin never opens one — every context below already carries the right handle — which is
 * also what stops the commonest plugin bug, a handle captured in a module-scope variable and reused
 * after the request that owned it has closed it.
 *
 * The SCHEMA half of database access is deliberately not here: build-time symbols like
 * `tenantRef`, `timestamps` and `tenantIsolation` are needed at module scope by a table file, so
 * they cannot come from an injected context and cannot come from a module that reads the plugin
 * barrel. They live at `apps/web/src/db/schema/kit.ts` — beside `rls.ts`, below the barrel.
 */

import type { Tenant } from '../../db/schema'
import type { PluginContext } from './types'

export type { Tenant } from '../../db/schema'
export type { Database, DatabaseHandle } from './types'

/**
 * A lifecycle hook: `onTenantCreated`, `onTenantDeleted`, `seedDemo`.
 *
 * Every one of them is **post-commit, idempotent and best-effort**, each try/caught by the host.
 * Two consequences a plugin author has to hold on to: a hook that throws must never break sign-up,
 * so **nothing a tenant NEEDS may arrive only this way** (give it a lazy repair path on first
 * read); and it may run twice, so fixed ids and `onConflictDoNothing` are not decoration.
 *
 * There is no `logger` and no `env`: a hook runs inside somebody else's transaction boundary and
 * has no business enqueuing or nudging. If it needs to, it is not a hook.
 */
export interface HookCtx extends Pick<PluginContext, 'db'> {
  tenant: Tenant
  tenantId: string
  /** Who caused it — the signing-up user, the approving admin. Null for a system path. */
  userId: string | null
  /**
   * The features this DEPLOYMENT ships (D30). A hook that CREATES rows is the sharpest feature door
   * there is, because it has no nav entry to hide behind: seed nothing for a surface this
   * deployment does not have.
   */
  features: readonly string[]
}

/**
 * `pnpm seed --demo`, after the kit's own block.
 *
 * `demoId(key)` is already namespaced with the plugin's id, so two plugins that both seed `note:1`
 * cannot collide and re-running the seed adds nothing.
 */
export interface SeedCtx extends Pick<PluginContext, 'db'> {
  tenantId: string
  ownerId: string
  demoId: (key: string) => string
  log: (line: string) => void
}

/**
 * Run several writes as one transaction.
 *
 * Keep it SHORT. Hyperdrive is a transaction-mode pooler and cannot reuse a connection mid
 * transaction, so a long one holds a real connection out of the pool for its whole life. It is
 * also why there is no nudge or enqueue inside: those go after the commit, or a listener re-queries
 * for a row that is not there yet.
 */
export async function transaction<T>(
  db: PluginContext['db'],
  fn: (tx: PluginContext['db']) => Promise<T>
): Promise<T> {
  return db.transaction(tx => fn(tx as unknown as PluginContext['db']))
}
