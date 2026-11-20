/**
 * MCP connections and their tokens — the ONE place a bearer token on `/mcp` becomes a grant.
 *
 * A grant is made by the authorization server once a person consents (`createMcpGrant`), and it
 * gets a token pair (`issueMcpTokenPair`); both store only SHA-256 hashes. `findMcpAccessToken` is
 * the read the `/mcp` route makes on every call: an access token that is known, unexpired and of a
 * live grant, or nothing. Everything about the PERSON (membership, block, role, policy) is checked
 * after it, by `resolveMcpCaller`, because those can change at any moment and are never cached on
 * the grant.
 *
 * Token prefixes are neutral on purpose (`mcpat_` / `mcprt_`): a client shows them in its logs,
 * and they must not name the product.
 */
import type { McpScope } from '@rocketflare/shared/mcp'
import { and, eq, gt, isNull } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { type McpGrantRow, mcpGrants, mcpTokens } from '../../../db/schema'
import { hashToken } from '../../utils/core/hash'
import { randomToken } from '../../utils/core/ids'

export const MCP_ACCESS_TOKEN_PREFIX = 'mcpat_'
export const MCP_REFRESH_TOKEN_PREFIX = 'mcprt_'
/** An access token lives an hour; the client refreshes it. */
export const MCP_ACCESS_TOKEN_TTL_SECONDS = 60 * 60

const DAY_MS = 24 * 60 * 60 * 1000

/** The two URLs a grant may be bound to: the shared one, or the organisation's own. */
export function mcpResourceUrl(cfg: AppConfig, tenantSlug?: string): string {
  const origin = new URL(cfg.APP_URL).origin
  return tenantSlug ? `${origin}/mcp/t/${encodeURIComponent(tenantSlug)}` : `${origin}/mcp`
}

/** RFC 9728 metadata for a resource URL: `/.well-known/oauth-protected-resource<path>`. */
export function mcpResourceMetadataUrl(resource: string): string {
  const url = new URL(resource)
  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`
}

export interface CreateMcpGrantInput {
  tenantId: string
  userId: string
  clientId: string
  scopes: McpScope[]
  resource: string
  /** Defaults to `MCP_GRANT_MAX_DAYS` from now; the authorization server passes a shorter cap. */
  expiresAt?: Date
}

export async function createMcpGrant(
  db: Database,
  cfg: AppConfig,
  input: CreateMcpGrantInput,
  now = new Date()
): Promise<McpGrantRow> {
  const [grant] = await db
    .insert(mcpGrants)
    .values({
      tenantId: input.tenantId,
      userId: input.userId,
      clientId: input.clientId,
      scopes: [...new Set(input.scopes)],
      resource: input.resource,
      expiresAt: input.expiresAt ?? new Date(now.getTime() + cfg.MCP_GRANT_MAX_DAYS * DAY_MS),
      lastUsedAt: now,
    })
    .returning()
  if (!grant) throw new Error('mcp_grants: insert returned no row')
  return grant
}

export interface McpTokenPair {
  accessToken: string
  refreshToken: string
  /** Seconds until the access token expires. */
  expiresIn: number
  accessExpiresAt: Date
}

/** Two new plaintexts — generated before anything is written, so a rotation can seal them. */
export function generateMcpTokenPair(): { accessToken: string; refreshToken: string } {
  return {
    accessToken: `${MCP_ACCESS_TOKEN_PREFIX}${randomToken(32)}`,
    refreshToken: `${MCP_REFRESH_TOKEN_PREFIX}${randomToken(32)}`,
  }
}

/**
 * A fresh access + refresh pair for `grant` (or the `pair` given). The refresh token expires with
 * the grant itself. `rotatedFrom` is the id of the refresh token this pair replaces, when it is a
 * refresh.
 */
export async function issueMcpTokenPair(
  db: Database,
  grant: Pick<McpGrantRow, 'id' | 'tenantId' | 'expiresAt'>,
  options: {
    rotatedFrom?: string
    now?: Date
    pair?: { accessToken: string; refreshToken: string }
  } = {}
): Promise<McpTokenPair> {
  const now = options.now ?? new Date()
  const { accessToken, refreshToken } = options.pair ?? generateMcpTokenPair()
  const accessExpires = new Date(
    Math.min(now.getTime() + MCP_ACCESS_TOKEN_TTL_SECONDS * 1000, grant.expiresAt.getTime())
  )
  await db.insert(mcpTokens).values([
    {
      tenantId: grant.tenantId,
      grantId: grant.id,
      kind: 'access',
      tokenHash: await hashToken(accessToken),
      expiresAt: accessExpires,
      rotatedFrom: options.rotatedFrom ?? null,
    },
    {
      tenantId: grant.tenantId,
      grantId: grant.id,
      kind: 'refresh',
      tokenHash: await hashToken(refreshToken),
      expiresAt: grant.expiresAt,
      rotatedFrom: options.rotatedFrom ?? null,
    },
  ])
  return {
    accessToken,
    refreshToken,
    expiresIn: Math.max(0, Math.floor((accessExpires.getTime() - now.getTime()) / 1000)),
    accessExpiresAt: accessExpires,
  }
}

/** Is this grant past its idle or its absolute limit (or revoked)? */
export function mcpGrantLapsed(
  cfg: AppConfig,
  grant: Pick<McpGrantRow, 'revokedAt' | 'expiresAt' | 'lastUsedAt'>,
  now = new Date()
): boolean {
  if (grant.revokedAt) return true
  if (grant.expiresAt.getTime() <= now.getTime()) return true
  return grant.lastUsedAt.getTime() + cfg.MCP_GRANT_IDLE_DAYS * DAY_MS <= now.getTime()
}

/**
 * The live grant behind an ACCESS token, or null: unknown, a refresh token, expired, or a grant
 * that is revoked or has lapsed. Reads on the handle it is given — the owner connection, as
 * every credential lookup does, because the tenant is what this answer decides.
 */
export async function findMcpAccessToken(
  db: Database,
  cfg: AppConfig,
  plaintext: string,
  now = new Date()
): Promise<McpGrantRow | null> {
  if (!plaintext.startsWith(MCP_ACCESS_TOKEN_PREFIX)) return null
  const [row] = await db
    .select({ grant: mcpGrants })
    .from(mcpTokens)
    .innerJoin(
      mcpGrants,
      and(eq(mcpGrants.id, mcpTokens.grantId), eq(mcpGrants.tenantId, mcpTokens.tenantId))
    )
    .where(
      and(
        eq(mcpTokens.tokenHash, await hashToken(plaintext)),
        eq(mcpTokens.kind, 'access'),
        gt(mcpTokens.expiresAt, now),
        isNull(mcpGrants.revokedAt)
      )
    )
    .limit(1)
  if (!row || mcpGrantLapsed(cfg, row.grant, now)) return null
  return row.grant
}

/** At most once a minute: the idle limit needs minutes, not every call's write. */
export const MCP_TOUCH_INTERVAL_MS = 60_000

export async function touchMcpGrant(db: Database, grant: McpGrantRow, now = new Date()) {
  if (now.getTime() - grant.lastUsedAt.getTime() < MCP_TOUCH_INTERVAL_MS) return
  await db
    .update(mcpGrants)
    .set({ lastUsedAt: now })
    .where(and(eq(mcpGrants.tenantId, grant.tenantId), eq(mcpGrants.id, grant.id)))
}
