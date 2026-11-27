/**
 * Public probes, mounted at `/api` (kept under `/api/` so they never collide with an
 * SPA route). `/health` = liveness (config + version), `/ready` = readiness (SELECT 1 through
 * the request's DB handle; 503 envelope when the database is unreachable).
 */
import type { Branding } from '@rocketflare/shared/branding'
import { sql } from 'drizzle-orm'
import { createRouter } from '../utils/routes/router'

export const healthRouter = createRouter()

healthRouter.get('/health', c => {
  const cfg = c.get('config')
  const branding: Branding = {
    name: cfg.APP_NAME,
    tagline: cfg.APP_TAGLINE,
    loginPanelArt: cfg.LOGIN_PANEL_ART,
    logoUrl: cfg.APP_LOGO_URL,
    faviconUrl: cfg.APP_FAVICON_URL,
  }
  return c.json({ status: 'ok', version: cfg.RELEASE_VERSION, env: cfg.APP_ENV, ...branding })
})

healthRouter.get('/ready', async c => {
  try {
    await c.get('db').execute(sql`SELECT 1`)
    return c.json({ status: 'ready' })
  } catch (err) {
    c.get('logger').error({ err }, 'Readiness check failed')
    return c.json(
      { error: 'Database unavailable', statusCode: 503, code: 'database_unavailable' },
      503
    )
  }
})
