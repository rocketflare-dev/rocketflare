/**
 * The cube security context (D19) — the ONLY bridge between the request's `AuthContext` and cube
 * SQL. `createCubeApp` calls `extractSecurityContext` for every `/cubejs-api` and `/mcp` request;
 * every cube's `sql()` then scopes its base query with `tenantIdOf(ctx)`. The route is mounted
 * behind `authMiddleware`, so a missing auth here is a wiring bug, not an expected path — it throws.
 */
import type { QueryContext, SecurityContext } from 'drizzle-cube/server'
import type { Context } from 'hono'
import type { AppEnv, AuthContext } from '../types'

export interface AnalyticsSecurityContext extends SecurityContext {
  tenantId: string
  userId: string
  /** Membership role; `null` never reaches a cube (no tenant → 403 before the cube app runs). */
  role: string | null
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
  return { tenantId: auth.tenantId, userId: auth.user.id, role: auth.tenantUser?.role ?? null }
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
