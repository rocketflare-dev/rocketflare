/**
 * An organisation's MCP settings, and the one rule for which tools a client may see.
 *
 * No row means every default — off, all read-only tools, everyone may connect — so a tenant that
 * never opened the page has nothing to migrate. `exposedOverMcp` is pure and is the ONLY exposure
 * decision: the `/mcp` server and the settings page's "exposed" column both call it, so the page
 * can never claim a tool is hidden that a client can call.
 */
import type {
  McpConnectPolicy,
  McpSettings,
  UpdateMcpSettingsRequest,
} from '@rocketflare/shared/mcp'
import type { MembershipRole } from '@rocketflare/shared/tenants'
import { eq } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type McpSettingsRow, mcpSettings } from '../../../db/schema'
import { mcpToolProfile, mcpUnavailableReason } from '../agents/tools/surfaces'
import type { Tool } from '../ai/agent-loop'

export const DEFAULT_MCP_SETTINGS: McpSettings = {
  enabled: false,
  exposure: 'read_only',
  exposedTools: [],
  connectPolicy: 'everyone',
  connectGroupIds: [],
  updatedAt: null,
  updatedByUserId: null,
}

export function toMcpSettings(row: McpSettingsRow | undefined): McpSettings {
  if (!row) return DEFAULT_MCP_SETTINGS
  return {
    enabled: row.enabled,
    exposure: row.exposure,
    exposedTools: row.exposedTools,
    connectPolicy: row.connectPolicy,
    connectGroupIds: row.connectGroupIds,
    updatedAt: row.updatedAt,
    updatedByUserId: row.updatedByUserId,
  }
}

export async function getMcpSettings(db: Database, tenantId: string): Promise<McpSettings> {
  const [row] = await db.select().from(mcpSettings).where(eq(mcpSettings.tenantId, tenantId))
  return toMcpSettings(row)
}

/** Upsert the fields given; returns the settings before and after (for the activity rows). */
export async function updateMcpSettings(
  db: Database,
  tenantId: string,
  userId: string,
  patch: UpdateMcpSettingsRequest
): Promise<{ before: McpSettings; after: McpSettings }> {
  const before = await getMcpSettings(db, tenantId)
  const merged = { ...before, ...patch }
  const values = {
    enabled: merged.enabled,
    exposure: merged.exposure,
    exposedTools: [...new Set(merged.exposedTools)],
    connectPolicy: merged.connectPolicy,
    connectGroupIds: [...new Set(merged.connectGroupIds)],
    updatedByUserId: userId,
  }
  const [row] = await db
    .insert(mcpSettings)
    .values({ tenantId, ...values })
    .onConflictDoUpdate({ target: mcpSettings.tenantId, set: { ...values, updatedAt: new Date() } })
    .returning()
  return { before, after: toMcpSettings(row) }
}

/** A tool that changes nothing: no `sideEffects`, and its MCP scope is the read one. */
export function isReadOnlyTool(tool: Tool): boolean {
  return tool.sideEffects !== true && mcpToolProfile(tool).scope === 'mcp:read'
}

/**
 * Would a client see `tool` under `settings`? Never one that cannot reach MCP at all (not on the
 * surface, terminal, approval-gated); otherwise the exposure mode decides. A write tool that is
 * exposed is still listed to a read-only token — calling it answers 403 `insufficient_scope`,
 * which is how a client learns to ask for `mcp:write`.
 */
export function exposedOverMcp(
  tool: Tool,
  settings: Pick<McpSettings, 'exposure' | 'exposedTools'>
) {
  if (mcpUnavailableReason(tool)) return false
  switch (settings.exposure) {
    case 'read_only':
      return isReadOnlyTool(tool)
    case 'all':
      return true
    case 'selected':
      return settings.exposedTools.includes(tool.name)
  }
}

/**
 * May a person with this role and these groups connect a client under `policy`? Owners and admins
 * always may (they set the policy); `support` never — a visiting support role acts for the
 * platform, and a client acting as one would carry that reach out of the app.
 */
export function mayConnect(
  policy: { connectPolicy: McpConnectPolicy; connectGroupIds: readonly string[] },
  role: MembershipRole,
  groupIds: readonly string[]
): boolean {
  if (role === 'support') return false
  if (role === 'owner' || role === 'admin') return true
  switch (policy.connectPolicy) {
    case 'everyone':
      return true
    case 'admins':
      return false
    case 'groups':
      return groupIds.some(id => policy.connectGroupIds.includes(id))
  }
}
