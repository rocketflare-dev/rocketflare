/**
 * Hono typing (04 §2, D13): bindings come from `wrangler types` (`Cloudflare.Env` in
 * worker-configuration.d.ts), variables are declared once here, and every `Hono` instance is
 * `Hono<AppEnv>` via `utils/routes/router.ts`. No `declare module 'hono'` augmentation.
 */
import type { Context } from 'hono'
import type { PinoLogger } from 'hono-pino'
import type { AppConfig } from '../config'
import type { Database } from '../db/client'

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
  /** Set by `authMiddleware` (Phase 1). */
  auth?: unknown
}

export type AppEnv = { Bindings: AppBindings; Variables: AppVariables }
export type AppContext = Context<AppEnv>
