/**
 * The tools a member's client sees: `toolsFor('mcp')` built from THEIR access scope and CASL
 * grant, then the organisation's exposure. One function, so the `/mcp` server and the consent
 * screen ("the tools that will be available") can never disagree.
 */
import type { McpSettings } from '@rocketflare/shared/mcp'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import type { AuthContext } from '../../types'
import { accessScopeOf } from '../access'
import { toolsFor } from '../agents/tools'
import type { Tool } from '../ai/agent-loop'
import { authRequester } from '../member-ability'
import { MCP_GET_DOCUMENT_MAX_CHARS } from './server'
import { exposedOverMcp } from './settings'

export async function mcpToolsFor(input: {
  /** A handle scoped to the member's tenant (`withTenantScope`). */
  db: Database
  cfg: AppConfig
  env: Cloudflare.Env
  auth: AuthContext & { tenantId: string }
  settings: Pick<McpSettings, 'exposure' | 'exposedTools'>
}): Promise<Tool[]> {
  const { auth } = input
  const tools = await toolsFor('mcp', {
    db: input.db,
    cfg: input.cfg,
    env: input.env,
    scope: accessScopeOf(auth),
    can: (action, subject) => auth.ability.can(action, subject),
    features: auth.features,
    requester: authRequester(auth),
    maxDocumentChars: MCP_GET_DOCUMENT_MAX_CHARS,
    // The client's model typed every argument; no URL here was written by a person in our UI.
    requesterUrls: new Set(),
  })
  return tools.filter(tool => exposedOverMcp(tool, input.settings))
}
