/**
 * CORS (04 §4): function origin because config is per-isolate, not import-time. In production
 * the SPA is same-origin (ASSETS) so only `APP_URL` is allowed; outside production the default
 * dev origins (:3000 Vite, :3001 `wrangler dev`) are added, plus the loopback twin of `APP_URL`
 * and of the request's own loopback origin — so custom dev ports (`DEV_UI_PORT` / `DEV_API_PORT`,
 * `scripts/lib/dev-ports.mjs`) work with only `APP_URL` following the UI port: the Worker cannot
 * read the shell's environment. A tunnel's origin arrives as `APP_URL` (`--var`). Runs BEFORE
 * csrf so preflights are answered.
 * WebSocket upgrades (`/ws`, D8) bypass it: CORS does not govern the handshake (the route checks
 * membership), and the DO's 101 response has immutable headers that `cors()` would try to set.
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

const LOOPBACK = ['localhost', '127.0.0.1']

/** `http://localhost:5199` → both it and `http://127.0.0.1:5199`; a non-loopback URL → []. */
function loopbackOrigins(value: string): string[] {
  try {
    const url = new URL(value)
    if (!LOOPBACK.includes(url.hostname)) return []
    return LOOPBACK.map(host => {
      const twin = new URL(url.origin)
      twin.hostname = host
      return twin.origin
    })
  } catch {
    return []
  }
}

/**
 * Allowed browser origins: APP_URL's origin; outside production also the default dev origins,
 * APP_URL's loopback twin and — given `requestUrl` — the request's own loopback origin (a browser
 * on `wrangler dev`'s port, whatever it is).
 */
export function allowedOrigins(cfg: AppConfig, requestUrl?: string): Set<string> {
  const allowed = new Set<string>()
  try {
    allowed.add(new URL(cfg.APP_URL).origin)
  } catch {
    // APP_URL is validated as a URL by the config schema; defensive only.
  }
  if (cfg.APP_ENV === 'production') return allowed
  for (const o of DEV_ORIGINS) allowed.add(o)
  for (const o of loopbackOrigins(cfg.APP_URL)) allowed.add(o)
  if (requestUrl) for (const o of loopbackOrigins(requestUrl)) allowed.add(o)
  return allowed
}

const corsHandler = cors({
  origin: (origin, c) => (allowedOrigins(c.get('config'), c.req.url).has(origin) ? origin : null),
  credentials: true,
  allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  exposeHeaders: ['X-Request-Id'],
  maxAge: 600,
})

export function isWebSocketUpgrade(c: { req: { header(name: string): string | undefined } }) {
  return c.req.header('Upgrade')?.toLowerCase() === 'websocket'
}

export const corsMiddleware = createMiddleware<AppEnv>((c, next) =>
  isWebSocketUpgrade(c) ? next() : corsHandler(c, next)
)
