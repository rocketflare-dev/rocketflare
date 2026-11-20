/**
 * AI-client connections, as the people involved see them.
 *
 * - `mcpConnectionsRouter` at `/api/mcp-connections` — a person's OWN connections across every
 *   organisation (Profile → Connected apps): `GET /` and `DELETE /:id`. Only the deployment gate:
 *   a person can always see and end their own, even in an organisation that has since turned MCP
 *   off. Account-wide, so a session only: an API key acts within its one organisation (403).
 * - `mcpTenantConnectionsRouter` under `/api/mcp/connections` — every connection in the current
 *   organisation, for whoever may `manage McpSettings`: `GET /`, `DELETE /:id` and
 *   `POST /revoke-all`.
 */
import {
  type McpConnectionListResponse,
  type McpRevokeAllResponse,
  mcpConnectionListQuerySchema,
} from '@rocketflare/shared/oauth'
import { guardPermission } from '../middleware/permissions'
import {
  listMcpConnections,
  revokeAllTenantConnections,
  revokeOwnConnection,
  revokeTenantConnection,
} from '../services/mcp/connections'
import { uuidParam, withAccountAuth, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const mcpConnectionsRouter = createRouter()

mcpConnectionsRouter.get('/', validate('query', mcpConnectionListQuerySchema), async c => {
  const { db, cfg, auth } = withAccountAuth(c)
  const { status } = c.req.valid('query')
  const body: McpConnectionListResponse = {
    items: await listMcpConnections(db, cfg, { userId: auth.user.id, status }),
  }
  return c.json(body)
})

mcpConnectionsRouter.delete('/:id', async c => {
  const { db, auth } = withAccountAuth(c)
  await revokeOwnConnection(db, { userId: auth.user.id, grantId: uuidParam(c, 'id') })
  return c.body(null, 204)
})

export const mcpTenantConnectionsRouter = createRouter()

mcpTenantConnectionsRouter.get('/', validate('query', mcpConnectionListQuerySchema), async c => {
  const { db, cfg, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'McpSettings')
  const { status } = c.req.valid('query')
  const body: McpConnectionListResponse = {
    items: await listMcpConnections(db, cfg, { tenantId, status }),
  }
  return c.json(body)
})

mcpTenantConnectionsRouter.delete('/:id', async c => {
  const { db, tenantId, auth } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'McpSettings')
  await revokeTenantConnection(db, {
    tenantId,
    grantId: uuidParam(c, 'id'),
    actorUserId: auth.user.id,
  })
  return c.body(null, 204)
})

mcpTenantConnectionsRouter.post('/revoke-all', async c => {
  const { db, tenantId, auth } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'McpSettings')
  const body: McpRevokeAllResponse = {
    revoked: await revokeAllTenantConnections(db, { tenantId, actorUserId: auth.user.id }),
  }
  return c.json(body)
})
