/**
 * Hono app assembly (04 §10, D5, D13). Middleware order is load-bearing — see
 * middleware/CLAUDE.md before reordering. `export { app }` only: the Worker entry
 * (`src/worker.ts`) adds `queue`/`scheduled`, and tests drive `app.request(path, init, env, ctx)`
 * without dragging Worker-only classes into Node.
 */

import { jsonBodyLimit } from './middleware/body-limit'
import { configMiddleware } from './middleware/config'
import { corsMiddleware } from './middleware/cors'
import { csrfProtection } from './middleware/csrf'
import { databaseMiddleware } from './middleware/database'
import { errorHandler, notFoundBody, notFoundHandler } from './middleware/error-handler'
import { requestIdMiddleware, requestLogger } from './middleware/request-logger'
import { securityHeaders } from './middleware/security-headers'
import { healthRouter } from './routes/health'
import { createRouter } from './utils/routes/router'

/**
 * Prefixes the Worker owns. An unmatched path under one of these is a JSON 404, never the SPA
 * `index.html`. `/cubejs-api` and `/mcp` (Phase 4) and `/ws` (Phase 2) are reserved now so the
 * catch-all does not have to change when they mount (D19).
 */
const API_PREFIXES = ['/api', '/auth', '/cubejs-api', '/mcp', '/ws'] as const

function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some(p => pathname === p || pathname.startsWith(`${p}/`))
}

const app = createRouter()

// 1. Error envelope first so every later failure (including config validation) uses it.
app.onError(errorHandler)
app.notFound(notFoundHandler)

// 2–4. Request id + logger → validated config → security headers (wraps everything below).
app.use('*', requestIdMiddleware, requestLogger)
app.use('*', configMiddleware)
app.use('*', securityHeaders)

// 5. Reject oversized bodies before any parsing or DB work.
app.use('/api/*', jsonBodyLimit)
app.use('/auth/*', jsonBodyLimit)

// 6–7. CORS answers preflights before CSRF can reject them; CSRF is cookie-only, no DB.
app.use('*', corsMiddleware)
app.use('*', csrfProtection)

// 8. Per-request DB client — last of the globals because it is the first thing with real cost.
app.use('*', databaseMiddleware)

// 9. Mounts. Public probes first; Phase 1 adds `/auth`, `/api/invite`, `/api/admin/*`
//    (globalAdminMiddleware) and every other `/api/<prefix>/*` with `authMiddleware` AT THE MOUNT.
app.route('/api', healthRouter)

// 10. SPA via Workers Static Assets. Hashed files are served by the assets layer before the
//     Worker runs; only navigations reach here. `not_found_handling = "single-page-application"`
//     makes ASSETS return index.html for client routes. API-shaped paths must 404 as JSON.
app.all('*', c => {
  const { pathname } = new URL(c.req.url)
  if (isApiPath(pathname)) return c.json(notFoundBody(pathname), 404)
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw)
  // No ASSETS binding (Vite serves the UI in dev, or a bare `app.request` in tests).
  return c.text('Not Found', 404)
})

export { app }
