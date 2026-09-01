/**
 * Hono typing (04 §2, D13): bindings come from `wrangler types` (`Cloudflare.Env` in
 * worker-configuration.d.ts), variables are declared once here, and every `Hono` instance is
 * `Hono<AppEnv>` via `utils/routes/router.ts`. No `declare module 'hono'` augmentation.
 */
import type { AppAbility } from '@gmgo/shared/permissions'
import type { MembershipRole } from '@gmgo/shared/tenants'
import type { Context } from 'hono'
import type { PinoLogger } from 'hono-pino'
import type { AppConfig } from '../config'
import type { Database } from '../db/client'
import type { User } from '../db/schema'

/**
 * What `authMiddleware` sets (D10, D25). Read ONLY through `withAuthAndDb` in routes and the
 * helpers in `middleware/permissions.ts`. `tenantId`/`tenantUser` are null for a user with no
 * membership (pending approval) — routes that need a tenant get 403 `no_tenant` before they run.
 */
export interface AuthContext {
  user: User
  /** The active tenant — the ONLY tenant id a query may filter by. */
  tenantId: string | null
  tenantUser: { role: MembershipRole } | null
  /** Resolved tenant summary for `tenantId`; null when there is no membership. */
  tenant: { id: string; name: string; slug: string } | null
  /**
   * The DB session row behind the cookie. Bearer (API-key) auth has no session row, so `id` is
   * `api-key:<keyId>` — `isApiKeySession(auth)` tells the two apart (select-tenant is cookie-only).
   */
  session: { id: string }
  /** Latest access request for the user's email — drives 403 `pending_approval` vs `no_tenant`. */
  accessRequestStatus: 'pending' | 'approved' | 'rejected' | null
  /** `buildAbility({ role, isGlobalAdmin, features })` for this request. */
  ability: AppAbility
  isGlobalAdmin: boolean
  /** Feature flags on for the active tenant → `can('access', 'Feature:<f>')`. */
  features: string[]
}

export type AppBindings = Cloudflare.Env

export interface AppVariables {
  /** Validated config — routes read this, never `c.env` (D3). */
  config: AppConfig
  /** Per-request drizzle handle (owner connection). */
  db: Database
  /** Ends the request's DB client; the database middleware schedules it in `waitUntil`. */
  dbClose?: () => Promise<void>
  logger: PinoLogger
  requestId: string
  /** Set by `authMiddleware`; absent on public routes. */
  auth?: AuthContext
}

export type AppEnv = { Bindings: AppBindings; Variables: AppVariables }
export type AppContext = Context<AppEnv>
