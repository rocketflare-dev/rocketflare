/**
 * The drizzle-cube API (D19): `/cubejs-api/v1/{load,meta,sql,batch,dry-run}` and `/mcp`, both
 * served by ONE router mounted twice in `index.ts` behind `authMiddleware`. A fresh
 * `createCubeApp` is built per request because the drizzle handle comes from the request's
 * Hyperdrive-backed client (`c.get('db')`), which does not exist at module scope in Workers; the
 * adapter registers absolute paths, so the raw request is forwarded rather than a prefix-stripped
 * one. Access = tenant membership + `read Analytics`; row scoping happens inside every cube via
 * `extractSecurityContext` (`cubes/security.ts`) — see `cubes/CLAUDE.md`. CORS is the app's own
 * middleware (already ran); MCP origin policy is drizzle-cube's default (loopback + no-Origin
 * clients such as the Claude connector), tightened per deployment via `mcp.allowedOrigins`.
 */
import { createCubeApp } from 'drizzle-cube/adapters/hono'
import * as schema from '../../db/schema'
import { allCubes, extractSecurityContext } from '../cubes'
import { guardPermission } from '../middleware/permissions'
import { withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'

export const cubeApiRouter = createRouter()

cubeApiRouter.all('*', async c => {
  const { db } = withAuthAndDb(c) // 401 / 403 no_tenant before any cube work
  guardPermission(c, 'read', 'Analytics')
  const securityContext = extractSecurityContext(c)
  const cubeApp = createCubeApp({
    cubes: allCubes,
    drizzle: db,
    schema,
    engineType: 'postgres',
    extractSecurityContext: () => securityContext,
    mcp: { enabled: true },
  })
  return cubeApp.fetch(c.req.raw)
})
