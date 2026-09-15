/**
 * Hono app assembly (04 §10, D5, D13). Middleware order is load-bearing — see
 * middleware/CLAUDE.md before reordering. `export { app }` only: the Worker entry
 * (`src/worker.ts`) adds `queue`/`scheduled`, and tests drive `app.request(path, init, env, ctx)`
 * without dragging Worker-only classes into Node.
 */

import type { Hono, MiddlewareHandler } from 'hono'
import { authMiddleware, globalAdminMiddleware } from './middleware/auth'
import { isUploadPath, jsonBodyLimit } from './middleware/body-limit'
import { configMiddleware } from './middleware/config'
import { corsMiddleware } from './middleware/cors'
import { csrfProtection } from './middleware/csrf'
import { databaseMiddleware } from './middleware/database'
import { errorHandler, notFoundBody, notFoundHandler } from './middleware/error-handler'
import { authRateLimit } from './middleware/rate-limit'
import { requestIdMiddleware, requestLogger } from './middleware/request-logger'
import { securityHeaders } from './middleware/security-headers'
import { tracerMiddleware } from './middleware/tracing'
import { accessRequestsRouter } from './routes/access-requests'
import { activityRouter } from './routes/activity'
import { adminRouter } from './routes/admin'
import { agentsRouter } from './routes/agents'
import { aguiRouter } from './routes/agui'
import { aiAgentModelsRouter } from './routes/ai-agent-models'
import { aiConfigRouter } from './routes/ai-config'
import { aiDocumentsRouter } from './routes/ai-documents'
import { aiPromptsRouter } from './routes/ai-prompts'
import { aiUsageRouter } from './routes/ai-usage'
import { analyticsPagesRouter } from './routes/analytics-pages'
import { authRouter } from './routes/auth/index'
import { chatRouter } from './routes/chat'
import { cubeApiRouter } from './routes/cube-api'
import { featuresRouter } from './routes/features'
import { filesRouter } from './routes/files'
import { groupsRouter } from './routes/groups'
import { healthRouter } from './routes/health'
import { invitationsRouter } from './routes/invitations'
import { inviteRouter } from './routes/invite'
import { keysRouter } from './routes/keys'
import { meRouter } from './routes/me'
import { membersRouter } from './routes/members'
import { notificationsRouter } from './routes/notifications'
import { tenantRouter } from './routes/tenant'
import { tenantsRouter } from './routes/tenants'
import { wsRouter } from './routes/ws'
import type { AppEnv } from './types'
import { isApiPath } from './utils/routes/api-prefixes'
import { createRouter } from './utils/routes/router'

const app = createRouter()

// 1. Error envelope first so every later failure (including config validation) uses it.
app.onError(errorHandler)
app.notFound(notFoundHandler)

/**
 * The runtime's own namespace, answered BEFORE the logger so it never reaches the app at all.
 * `wrangler dev` sends its reload control to the Worker on `/cdn-cgi/ProxyWorker/pause|play`
 * whenever its internal auth header does not match the ProxyWorker's, and the SPA catch-all used to
 * answer those with `index.html` and a 200 — wrong, and a stream of `GET /cdn-cgi/ProxyWorker/pause
 * 200` lines burying the app's own in the dev log. Cloudflare answers `/cdn-cgi/*` at the edge in
 * production, so nothing legitimate arrives here. Miniflare's own endpoints (`/cdn-cgi/local/…`,
 * the local cron trigger) never reach the Worker — it handles them itself.
 */
app.all('/cdn-cgi/*', c => c.body(null, 404))

// 2–4. Request id + logger → validated config → security headers (wraps everything below).
app.use('*', requestIdMiddleware, requestLogger)
app.use('*', configMiddleware)
app.use('*', securityHeaders)

// 5. Reject oversized bodies before any parsing or DB work. The upload route mounts its own
//    (larger) limit — see middleware/body-limit.ts.
app.use('/api/*', (c, next) => (isUploadPath(c.req.path) ? next() : jsonBodyLimit(c, next)))
app.use('/auth/*', jsonBodyLimit)

// 6–7. CORS answers preflights before CSRF can reject them; CSRF is cookie-only, no DB.
app.use('*', corsMiddleware)
app.use('*', csrfProtection)

// 8. Per-request DB client — last of the globals because it is the first thing with real cost.
app.use('*', databaseMiddleware)

// 9. Per-request tracer (D16): Langfuse batcher when both keys are set, no-op otherwise; flushed in
//    `waitUntil` after the handler. Streaming routes flush again before their stream closes.
app.use('/api/*', tracerMiddleware)

// 10. Mounts — auth is applied PER MOUNT so the public surface is enumerable: health, /auth/*,
//    /api/invite/:token (details; accept resolves the cookie itself). `/api/admin/*` is the only
//    tenant-free cross-tenant path (globalAdminMiddleware); everything else is `authMiddleware`.
app.route('/api', healthRouter)
app.route('/auth', authRouter)
app.use('/api/invite/:token/accept', authRateLimit)
app.route('/api/invite', inviteRouter)
app.use('/api/admin/*', globalAdminMiddleware)
app.route('/api/admin', adminRouter)
// WebSocket upgrade resolves the cookie itself (no authMiddleware: browsers can't set headers here).
app.route('/ws', wsRouter)
// A mount may carry a third element: a feature gate (D30). `requireFeature('x')` 404s
// `feature_disabled` on every route beneath the prefix, so a surface that ships dark is dark as a
// WHOLE rather than route by route — declared once here, like auth, instead of remembered in each
// handler. The kit ships no gated mount; an app adds `['/api/thing', thingRouter, requireFeature('thing')]`.
// Remember the other doors too: the cube registry (`cubesFor`) and the dashboard templates
// (`DashboardTemplate.feature`) have no nav entry and leak independently of this one.
const mounts: readonly (readonly [string, Hono<AppEnv>, MiddlewareHandler?])[] = [
  ['/api/me', meRouter],
  ['/api/tenant', tenantRouter],
  ['/api/tenants', tenantsRouter],
  ['/api/members', membersRouter],
  ['/api/groups', groupsRouter],
  ['/api/features', featuresRouter],
  ['/api/invitations', invitationsRouter],
  ['/api/keys', keysRouter],
  ['/api/notifications', notificationsRouter],
  ['/api/activity', activityRouter],
  ['/api/access-requests', accessRequestsRouter],
  ['/api/files', filesRouter],
  ['/api/ai/config', aiConfigRouter],
  ['/api/ai/prompts', aiPromptsRouter],
  ['/api/ai/usage', aiUsageRouter],
  ['/api/ai/agent-models', aiAgentModelsRouter],
  ['/api/ai/documents', aiDocumentsRouter],
  ['/api/chat', chatRouter],
  // A protocol surface with its own auth story, mounted beside chat rather than under it: this
  // list is the enumerable auth surface (D13).
  ['/api/agui', aguiRouter],
  ['/api/agents', agentsRouter],
  ['/api/analytics', analyticsPagesRouter],
  // drizzle-cube (D19): one router, two prefixes; the adapter registers absolute paths.
  ['/cubejs-api', cubeApiRouter],
  ['/mcp', cubeApiRouter],
]
for (const [prefix, router, gate] of mounts) {
  app.use(prefix, authMiddleware)
  app.use(`${prefix}/*`, authMiddleware)
  // After auth, never before: the gate reads `auth.features`, which `authMiddleware` sets.
  if (gate) {
    app.use(prefix, gate)
    app.use(`${prefix}/*`, gate)
  }
  app.route(prefix, router)
}

// 11. SPA via Workers Static Assets. Hashed files are served by the assets layer before the
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
