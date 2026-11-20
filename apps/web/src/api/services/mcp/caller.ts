/**
 * Who is calling `/mcp`: an access token → its grant → the person, as a member of the grant's
 * organisation, right now.
 *
 * Every check is re-read on every call, because each can change between two calls and none of
 * them may be cached on the grant: the membership and its role, the block, the tenant's status,
 * the tenant's MCP switch and its "who can connect" policy, the groups (visibility), the feature
 * flags. The answer is the same `AuthContext` a cookie request gets, with one deliberate
 * narrowing: **`isGlobalAdmin` is always false**. A client acts as the person's MEMBERSHIP — a
 * platform admin's cross-tenant reach never leaves the app through an AI client.
 *
 * Failure modes, which a client treats differently, so they are never mixed up:
 * - **401 `invalid_token`** + the `WWW-Authenticate` challenge — the TOKEN is the problem (none,
 *   unknown, expired, revoked, lapsed, or issued for another URL). The client signs in again.
 * - **403** — the token is fine and the PERSON may not use it here (blocked, not a member, support,
 *   outside the policy, the tenant suspended, MCP off). Signing in again would change nothing, so
 *   it must not send the client round the authorization loop.
 */
import { ERROR_CODES } from '@rocketflare/shared/errors'
import type { McpScope, McpSettings } from '@rocketflare/shared/mcp'
import type { MembershipRole } from '@rocketflare/shared/tenants'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { type McpGrantRow, tenants, tenantUsers, users } from '../../../db/schema'
import { tenantAuthContext } from '../../middleware/auth'
import type { AuthContext } from '../../types'
import { ForbiddenError, UnauthorizedError } from '../../utils/core/errors'
import { listFeatureFlagRows } from '../features'
import { listUserGroups } from '../groups'
import { getMcpSettings, mayConnect } from './settings'
import { findMcpAccessToken, mcpResourceMetadataUrl } from './tokens'

export interface McpCaller {
  grant: McpGrantRow
  scopes: McpScope[]
  auth: AuthContext & { tenantId: string; tenant: { id: string; name: string; slug: string } }
  settings: McpSettings
}

/**
 * The 401 a client acts on: RFC 6750 `Bearer` with RFC 9728's `resource_metadata`, which is how
 * it finds the authorization server. `scope` is the baseline a client should ask for.
 */
export class McpChallengeError extends UnauthorizedError {
  readonly challenge: string
  constructor(resource: string, description?: string) {
    super(description ?? 'An access token is required', ERROR_CODES.invalidToken)
    const parts = [`resource_metadata="${mcpResourceMetadataUrl(resource)}"`, `scope="mcp:read"`]
    if (description) parts.push(`error="invalid_token"`, `error_description="${description}"`)
    this.challenge = `Bearer ${parts.join(', ')}`
  }
}

function bearerOf(header: string | undefined): string | undefined {
  const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null
  return match?.[1]
}

export interface ResolveMcpCallerInput {
  db: Database
  cfg: AppConfig
  authorization: string | undefined
  /** The URL this request arrived on — `/mcp` or `/mcp/t/<slug>`; the grant must be for it. */
  resource: string
  now?: Date
}

export async function resolveMcpCaller(input: ResolveMcpCallerInput): Promise<McpCaller> {
  const { db, cfg, resource } = input
  const now = input.now ?? new Date()
  const token = bearerOf(input.authorization)
  if (!token) throw new McpChallengeError(resource)
  // API keys, CLI keys and session tokens all miss here: only an access token minted for a grant
  // is looked up, and anything else answers exactly like an unknown token.
  const grant = await findMcpAccessToken(db, cfg, token, now)
  if (!grant) throw new McpChallengeError(resource, 'The access token is invalid or expired')
  if (grant.resource !== resource) {
    throw new McpChallengeError(resource, 'The access token was issued for another server URL')
  }

  const member = await resolveMcpMember(db, cfg, {
    userId: grant.userId,
    tenantId: grant.tenantId,
    sessionId: `mcp:${grant.id}`,
  })
  if (!member) throw new McpChallengeError(resource, 'The access token is invalid or expired')
  const { auth, settings } = member
  return {
    grant,
    scopes: grant.scopes.filter((s): s is McpScope => s === 'mcp:read' || s === 'mcp:write'),
    auth,
    settings,
  }
}

export interface McpMember {
  auth: McpCaller['auth']
  settings: McpSettings
  role: MembershipRole
}

/**
 * The person as a member who may use an AI client in this organisation RIGHT NOW, or a 403 naming
 * why not — the one admission rule, shared by `/mcp` (every call) and the consent screen (which
 * organisations it offers, and again when it approves). `null` only when the user row is gone.
 */
export async function resolveMcpMember(
  db: Database,
  cfg: AppConfig,
  input: { userId: string; tenantId: string; sessionId: string }
): Promise<McpMember | null> {
  const [row] = await db
    .select({ user: users, role: tenantUsers.role, tenant: tenants })
    .from(users)
    .leftJoin(
      tenantUsers,
      and(eq(tenantUsers.userId, users.id), eq(tenantUsers.tenantId, input.tenantId))
    )
    .leftJoin(tenants, eq(tenants.id, input.tenantId))
    .where(eq(users.id, input.userId))
    .limit(1)
  if (!row) return null
  if (row.user.blockedAt) throw new ForbiddenError('Account is blocked', ERROR_CODES.blocked)
  if (!row.role || !row.tenant) {
    throw new ForbiddenError(
      'You are no longer a member of this organisation',
      ERROR_CODES.mcpNotAllowed
    )
  }
  if (row.tenant.status === 'suspended') {
    throw new ForbiddenError('Organisation is suspended', ERROR_CODES.tenantSuspended)
  }
  if (row.role === 'support') {
    throw new ForbiddenError(
      'A support role cannot use an AI client in an organisation',
      ERROR_CODES.mcpNotAllowed
    )
  }

  const [groups, flagRows, settings] = await Promise.all([
    listUserGroups(db, input.tenantId, input.userId),
    listFeatureFlagRows(db, input.tenantId),
    getMcpSettings(db, input.tenantId),
  ])
  const tenant = { id: row.tenant.id, name: row.tenant.name, slug: row.tenant.slug }
  const auth = await tenantAuthContext(cfg, {
    user: row.user,
    tenant,
    role: row.role,
    groups,
    flagRows,
    sessionId: input.sessionId,
    isGlobalAdmin: false,
  })
  if (!auth.features.includes('mcp') || !settings.enabled) {
    throw new ForbiddenError(
      'AI clients are turned off for this organisation',
      ERROR_CODES.mcpDisabled
    )
  }
  if (
    !mayConnect(
      settings,
      row.role,
      groups.map(g => g.id)
    )
  ) {
    throw new ForbiddenError(
      'You are not among the people this organisation lets connect an AI client',
      ERROR_CODES.mcpNotAllowed
    )
  }
  return { auth: { ...auth, tenantId: tenant.id, tenant }, settings, role: row.role }
}
