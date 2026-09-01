/**
 * Hono app assembly (04 §10, D5, D13). Middleware order is load-bearing — see
 * middleware/CLAUDE.md before reordering. `export { app }` only: the Worker entry
 * (`src/worker.ts`) adds `queue`/`scheduled`, and tests drive `app.request(path, init, env, ctx)`
 * without dragging Worker-only classes into Node.
 */

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
import { aiAgentModelsRouter } from './routes/ai-agent-models'
import { aiConfigRouter } from './routes/ai-config'
import { aiDocumentsRouter } from './routes/ai-documents'
import { aiPromptsRouter } from './routes/ai-prompts'
import { aiUsageRouter } from './routes/ai-usage'
import { analyticsPagesRouter } from './routes/analytics-pages'
import { authRouter } from './routes/auth/index'
import { chatRouter } from './routes/chat'
import { cubeApiRouter } from './routes/cube-api'
import { filesRouter } from './routes/files'
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
import { createRouter } from './utils/routes/router'

/**
 * Prefixes the Worker owns. An unmatched path under one of these is a JSON 404, never the SPA
 * `index.html`. `/cubejs-api` and `/mcp` are the drizzle-cube API (D19, mounted below behind
 * `authMiddleware`), `/ws` the realtime upgrade (Phase 2).
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
for (const [prefix, router] of [
  ['/api/me', meRouter],
  ['/api/tenant', tenantRouter],
  ['/api/tenants', tenantsRouter],
  ['/api/members', membersRouter],
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
  ['/api/agents', agentsRouter],
  ['/api/analytics', analyticsPagesRouter],
  // drizzle-cube (D19): one router, two prefixes; the adapter registers absolute paths.
  ['/cubejs-api', cubeApiRouter],
  ['/mcp', cubeApiRouter],
] as const) {
  app.use(prefix, authMiddleware)
  app.use(`${prefix}/*`, authMiddleware)
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
