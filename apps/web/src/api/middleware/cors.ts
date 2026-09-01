/**
 * CORS (04 §4): function origin because config is per-isolate, not import-time. In production
 * the SPA is same-origin (ASSETS) so only `APP_URL` is allowed; in development the Vite dev
 * server (3000) and tunnel origins are added. Runs BEFORE csrf so preflights are answered.
 */
import { cors } from 'hono/cors'
import { createMiddleware } from 'hono/factory'
import type { AppConfig } from '../../config'
import type { AppEnv } from '../types'

export const DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
]

/** Allowed browser origins: APP_URL's origin, plus the dev origins outside production. */
export function allowedOrigins(cfg: AppConfig): Set<string> {
  const allowed = new Set<string>()
  try {
    allowed.add(new URL(cfg.APP_URL).origin)
  } catch {
    // APP_URL is validated as a URL by the config schema; defensive only.
  }
  if (cfg.APP_ENV !== 'production') for (const o of DEV_ORIGINS) allowed.add(o)
  return allowed
}

const corsHandler = cors({
  origin: (origin, c) => (allowedOrigins(c.get('config')).has(origin) ? origin : null),
  credentials: true,
  allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  exposeHeaders: ['X-Request-Id'],
  maxAge: 600,
})

export const corsMiddleware = createMiddleware<AppEnv>((c, next) => corsHandler(c, next))
