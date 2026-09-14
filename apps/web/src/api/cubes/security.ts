/**
 * The cube security context (D19) — the ONLY bridge between the request's `AuthContext` and cube
 * SQL. `createCubeApp` calls `extractSecurityContext` for every `/cubejs-api` and `/mcp` request;
 * every cube's `sql()` then scopes its base query with `tenantIdOf(ctx)`. The route is mounted
 * behind `authMiddleware`, so a missing auth here is a wiring bug, not an expected path — it throws.
 */
import type { QueryContext, SecurityContext } from 'drizzle-cube/server'
import { inArray, type SQL, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { Context } from 'hono'
import { isAdminLevel } from '../middleware/permissions'
import type { AppEnv, AuthContext } from '../types'

export interface AnalyticsSecurityContext extends SecurityContext {
  tenantId: string
  userId: string
  /** Membership role; `null` never reaches a cube (no tenant → 403 before the cube app runs). */
  role: string | null
  /** D29 — every group this person is in, by id. What `groupFilter` matches on. */
  groupIds: string[]
  /** The same groups by TYPE name (`{ Department: ['Finance'] }`) — for readability, not matching. */
  groups: Record<string, string[]>
  /** Ids by type name — what `groupFilter` narrows on, because a rename must not move rows. */
  groupIdsByType: Record<string, string[]>
  /** Admin-level readers are not narrowed by `groupFilter`. */
  isAdmin: boolean
}

export class AnalyticsAuthError extends Error {
  constructor(message = 'Authentication required for analytics access') {
    super(message)
    this.name = 'AnalyticsAuthError'
  }
}

/** `c.get('auth')` → `{ tenantId, userId, role }`; throws without an authenticated tenant member. */
export function extractSecurityContext(c: Pick<Context<AppEnv>, 'get'>): AnalyticsSecurityContext {
  const auth = c.get('auth') as AuthContext | undefined
  if (!auth?.tenantId) throw new AnalyticsAuthError()
  const groups: Record<string, string[]> = {}
  const groupIdsByType: Record<string, string[]> = {}
  for (const group of auth.groups) {
    groups[group.typeName] = [...(groups[group.typeName] ?? []), group.name]
    groupIdsByType[group.typeName] = [...(groupIdsByType[group.typeName] ?? []), group.id]
  }
  return {
    tenantId: auth.tenantId,
    userId: auth.user.id,
    role: auth.tenantUser?.role ?? null,
    groupIds: auth.groups.map(g => g.id),
    groups,
    groupIdsByType,
    isAdmin: isAdminLevel(auth),
  }
}

/**
 * Narrow a cube's rows to the reader's groups of one TYPE (D29) — the pattern an app uses when its
 * own fact table carries a group dimension. No kit cube uses it, because no kit table has one.
 *
 *   sql: ctx => ({
 *     from: orders,
 *     where: and(eq(orders.tenantId, tenantIdOf(ctx)), groupFilter(ctx, 'Department', orders.departmentGroupId)),
 *   })
 *
 * Three behaviours, and the third is the important one:
 *   - admin-level reader → `undefined`, i.e. no narrowing at all;
 *   - reader with groups of that type → `column in (...their ids)`;
 *   - reader with NO group of that type → **`false`**, so they see nothing rather than everything.
 *
 * That last case is why this matches on IDS: matching on group NAMES means renaming a group
 * silently changes which rows a person sees, with nothing to catch it. Names are in the context
 * for labels and debugging.
 */
export function groupFilter(
  ctx: QueryContext,
  typeName: string,
  column: AnyPgColumn
): SQL | undefined {
  const security = ctx.securityContext as Partial<AnalyticsSecurityContext>
  if (security.isAdmin) return undefined
  const ids = security.groupIdsByType?.[typeName] ?? []
  if (ids.length === 0) return sql`false`
  return inArray(column, ids)
}

/**
 * The tenant every cube filters by. Cubes call this instead of reading `securityContext.tenantId`
 * directly so a context without a tenant fails loudly instead of compiling `tenant_id = NULL`
 * (which would match nothing — safe, but silent).
 */
export function tenantIdOf(ctx: QueryContext): string {
  const tenantId = ctx.securityContext.tenantId
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new AnalyticsAuthError('Cube query without a tenant in the security context')
  }
  return tenantId
}
