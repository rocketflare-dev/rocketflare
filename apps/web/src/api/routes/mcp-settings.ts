/**
 * `/api/mcp`: the organisation's MCP settings, for its owners and admins (`manage McpSettings`).
 * Mounted with `requireFeature('mcp')`, so a deployment that does not ship the server has no such
 * routes at all (404 `feature_disabled`).
 *
 * - `GET  /settings` — the settings and the URLs to paste into a client.
 * - `PUT  /settings` — any subset; each change of the switch, the exposure or the policy is an
 *   activity row (`mcp.enabled|disabled|exposure_changed|connect_policy_changed`).
 * - `GET  /tools`    — every tool, whether it can reach a client and whether it is exposed now.
 * - `GET  /calls`    — the newest calls from the log (never their arguments).
 */
import {
  type McpSettingsResponse,
  type McpToolCallListResponse,
  type McpToolListResponse,
  mcpToolCallListQuerySchema,
  updateMcpSettingsRequestSchema,
} from '@rocketflare/shared/mcp'
import { and, desc, eq } from 'drizzle-orm'
import { mcpToolCalls } from '../../db/schema'
import { guardPermission } from '../middleware/permissions'
import { accessScopeOf } from '../services/access'
import { recordActivity } from '../services/activity'
import { assertGroupsInTenant } from '../services/groups'
import { listMcpTools } from '../services/mcp/listing'
import { getMcpSettings, updateMcpSettings } from '../services/mcp/settings'
import { mcpResourceUrl } from '../services/mcp/tokens'
import { withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const mcpSettingsRouter = createRouter()

mcpSettingsRouter.get('/settings', async c => {
  const { db, tenantId, cfg, auth } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'McpSettings')
  const body: McpSettingsResponse = {
    settings: await getMcpSettings(db, tenantId),
    serverUrl: mcpResourceUrl(cfg),
    organisationServerUrl: mcpResourceUrl(cfg, auth.tenant?.slug),
    serverName: cfg.APP_NAME,
  }
  return c.json(body)
})

mcpSettingsRouter.put('/settings', validate('json', updateMcpSettingsRequestSchema), async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'McpSettings')
  const patch = c.req.valid('json')
  if (patch.connectGroupIds) {
    patch.connectGroupIds = await assertGroupsInTenant(db, tenantId, patch.connectGroupIds)
  }
  const { before, after } = await updateMcpSettings(db, tenantId, user.id, patch)
  const events: { type: string; metadata: Record<string, unknown> }[] = []
  if (before.enabled !== after.enabled) {
    events.push({ type: after.enabled ? 'mcp.enabled' : 'mcp.disabled', metadata: {} })
  }
  if (
    before.exposure !== after.exposure ||
    (after.exposure === 'selected' &&
      before.exposedTools.join(',') !== after.exposedTools.join(','))
  ) {
    events.push({
      type: 'mcp.exposure_changed',
      metadata: {
        from: before.exposure,
        to: after.exposure,
        ...(after.exposure === 'selected' && { tools: after.exposedTools }),
      },
    })
  }
  if (
    before.connectPolicy !== after.connectPolicy ||
    (after.connectPolicy === 'groups' &&
      before.connectGroupIds.join(',') !== after.connectGroupIds.join(','))
  ) {
    events.push({
      type: 'mcp.connect_policy_changed',
      metadata: {
        from: before.connectPolicy,
        to: after.connectPolicy,
        ...(after.connectPolicy === 'groups' && { groupIds: after.connectGroupIds }),
      },
    })
  }
  for (const event of events) {
    defer(() =>
      recordActivity(db, {
        tenantId,
        userId: user.id,
        type: event.type,
        subjectType: 'McpSettings',
        subjectId: tenantId,
        metadata: event.metadata,
      })
    )
  }
  return c.json(after)
})

mcpSettingsRouter.get('/tools', async c => {
  const { db, tenantId, cfg, auth } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'McpSettings')
  const settings = await getMcpSettings(db, tenantId)
  const tools = await listMcpTools(
    db,
    {
      db,
      cfg,
      env: c.env,
      scope: accessScopeOf(auth),
      can: (action, subject) => auth.ability.can(action, subject),
      features: auth.features,
    },
    settings
  )
  const body: McpToolListResponse = { tools }
  return c.json(body)
})

mcpSettingsRouter.get('/calls', validate('query', mcpToolCallListQuerySchema), async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'McpSettings')
  const query = c.req.valid('query')
  const rows = await db
    .select()
    .from(mcpToolCalls)
    .where(
      and(
        eq(mcpToolCalls.tenantId, tenantId),
        query.tool ? eq(mcpToolCalls.tool, query.tool) : undefined,
        query.userId ? eq(mcpToolCalls.userId, query.userId) : undefined
      )
    )
    .orderBy(desc(mcpToolCalls.createdAt))
    .limit(query.limit)
  const body: McpToolCallListResponse = {
    items: rows.map(row => ({
      id: row.id,
      userId: row.userId,
      grantId: row.grantId,
      clientId: row.clientId,
      tool: row.tool,
      outcome: row.outcome,
      code: row.code,
      durationMs: row.durationMs,
      costMicrocents: row.costMicrocents,
      createdAt: row.createdAt,
    })),
  }
  return c.json(body)
})
