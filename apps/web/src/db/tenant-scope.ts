/**
 * Tenant scoping (D1). `off` (default): predicates-only, `fn` gets the handle it was given.
 * `enforce`: run `fn` inside a transaction that first sets the transaction-local GUC
 * `app.tenant_id`, so RLS policies (schema/rls.ts) apply on a connection that is NOT the
 * table owner. Transaction-local because Hyperdrive is a transaction-mode pooler — session
 * state does not survive between statements (03 §3.6).
 *
 * Ported from the Node reference app's `src/db/tenant-scope.ts` without the AsyncLocalStorage-pinned
 * connection: there is no connection to pin here, the transaction IS the scope.
 */
import { sql } from 'drizzle-orm'
import type { Database } from './client'

export type TenantScopeMode = 'off' | 'enforce'

/**
 * A nested `withTenantScope` asked for a DIFFERENT tenant than the enclosing one.
 *
 * Refused rather than served: reusing the open transaction would run the inner work under
 * the outer tenant's GUC (silently wrong). There is exactly one tenant per request —
 * cross-tenant work belongs on the unscoped handle (`/api/admin/*`), the only place it is allowed.
 */
export class TenantScopeConflictError extends Error {
  constructor(outer: string, inner: string) {
    super(`nested tenant scope for '${inner}' inside an open scope for '${outer}'`)
    this.name = 'TenantScopeConflictError'
  }
}

/**
 * Which tenant a scoped transaction handle is stamped with. A WeakMap on the handle object
 * replaces the Node app's AsyncLocalStorage: re-entrancy is detected when a caller passes a
 * scoped handle back in, which is the only way nested scopes arise without ambient state.
 */
const scopedHandles = new WeakMap<object, string>()

/** The tenant a handle is scoped to, if it came out of `withTenantScope` in `enforce` mode. */
export function scopedTenantOf(db: object): string | undefined {
  return scopedHandles.get(db)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Run `fn` scoped to `tenantId`.
 *
 * Re-entrant for the same tenant (the inner call reuses the open transaction); a different
 * tenant throws `TenantScopeConflictError`. The tenant id is bound as a parameter, never
 * interpolated; `set_config(..., true)` makes it transaction-local so nothing leaks to the
 * next borrower of the pooled connection.
 */
export async function withTenantScope<T>(
  db: Database,
  tenantId: string,
  mode: TenantScopeMode,
  fn: (db: Database) => Promise<T>
): Promise<T> {
  if (mode === 'off') return fn(db)

  const outer = scopedHandles.get(db)
  if (outer !== undefined) {
    if (outer !== tenantId) throw new TenantScopeConflictError(outer, tenantId)
    return fn(db)
  }

  if (!UUID_RE.test(tenantId)) throw new Error(`withTenantScope: '${tenantId}' is not a UUID`)

  return db.transaction(async tx => {
    scopedHandles.set(tx, tenantId)
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`)
    // drizzle's transaction handle has the same query surface as `Database`; the cast keeps
    // every service signature `(db: Database)` without a second type.
    return fn(tx as unknown as Database)
  })
}
