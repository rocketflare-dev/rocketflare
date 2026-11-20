/**
 * The settings page's view of the tools: every tool the organisation has (core and each plugin's),
 * whether it can reach a client at all, whether the current settings expose it, and how often it
 * was called in the last 30 days. Built from the admin's own tool context, so a plugin tool that
 * only exists for some tenants shows exactly when it exists for this one.
 */
import type { McpSettings, McpToolListing } from '@rocketflare/shared/mcp'
import { and, count, eq, gte } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { mcpToolCalls } from '../../../db/schema'
import { serverPlugins } from '../../../plugins/server'
import { buildAgentTools, pluginTools } from '../agents/tools'
import type { AgentToolContext } from '../agents/tools/search-knowledge'
import { mcpToolProfile, mcpUnavailableReason } from '../agents/tools/surfaces'
import type { Tool } from '../ai/agent-loop'
import { exposedOverMcp, isReadOnlyTool } from './settings'

const DAY_MS = 24 * 60 * 60 * 1000

/** Which plugin contributes each tool name; a name no plugin claims is core's. */
async function pluginOfTool(ctx: AgentToolContext): Promise<Map<string, string>> {
  const owners = new Map<string, string>()
  const built = await Promise.allSettled(
    serverPlugins.map(async p => (await pluginTools(p, ctx)) ?? [])
  )
  built.forEach((result, i) => {
    const id = serverPlugins[i]?.shared.id
    if (result.status !== 'fulfilled' || !id) return
    for (const tool of result.value) owners.set(tool.name, id)
  })
  return owners
}

export async function callCountsByTool(
  db: Database,
  tenantId: string,
  now = new Date()
): Promise<Map<string, number>> {
  const rows = await db
    .select({ tool: mcpToolCalls.tool, calls: count() })
    .from(mcpToolCalls)
    .where(
      and(
        eq(mcpToolCalls.tenantId, tenantId),
        gte(mcpToolCalls.createdAt, new Date(now.getTime() - 30 * DAY_MS))
      )
    )
    .groupBy(mcpToolCalls.tool)
  return new Map(rows.map(r => [r.tool, Number(r.calls)]))
}

export function toToolListing(
  tool: Tool,
  settings: McpSettings,
  provider: string,
  calls30d: number
): McpToolListing {
  const profile = mcpToolProfile(tool)
  return {
    name: tool.name,
    provider,
    title: profile.title ?? null,
    description: tool.description,
    scope: profile.scope,
    readOnly: isReadOnlyTool(tool),
    annotations: profile.annotations,
    unavailableReason: mcpUnavailableReason(tool),
    exposed: exposedOverMcp(tool, settings),
    calls30d,
  }
}

export async function listMcpTools(
  db: Database,
  ctx: AgentToolContext,
  settings: McpSettings
): Promise<McpToolListing[]> {
  const [tools, owners, counts] = await Promise.all([
    buildAgentTools(ctx),
    pluginOfTool(ctx),
    callCountsByTool(db, ctx.scope.tenantId),
  ])
  return tools.map(tool =>
    toToolListing(tool, settings, owners.get(tool.name) ?? 'core', counts.get(tool.name) ?? 0)
  )
}
