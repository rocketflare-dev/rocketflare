/**
 * The OAuth 2.1 authorization server behind `/mcp`: authorization requests, consent, the
 * authorization code, and the token endpoint's two grants. The routes (`routes/oauth.ts`) are thin;
 * every rule is here.
 *
 * The flow, and what each step holds to:
 *
 * 1. **Authorize** (`startAuthorization`) — the client is resolved from its metadata document
 *    (`cimd.ts`) and `redirect_uri` checked against it BEFORE anything is redirected anywhere: until
 *    then every error is a page on our own origin, never a redirect (no open redirect). After it,
 *    an error goes back to the client with `error`, `state` and `iss`. PKCE S256 is mandatory;
 *    `resource` must be one of our two MCP URLs (RFC 8707) — `/mcp/t/<slug>` fixes the
 *    organisation. The request is stored for ten minutes.
 * 2. **Sign-in** — nothing here. No session sends the browser to the app's own `/login`, so every
 *    sign-in method, its single-sign-on policy, the sign-up mode and blocking apply unchanged.
 * 3. **Consent** — the organisations offered are exactly the ones where `resolveMcpMember` admits
 *    the person (MCP on, the connect policy met, never a support role), and approving re-checks it.
 *    A live connection for the same client, organisation and URL that already covers the scopes is
 *    REMEMBERED: the click is skipped and the code is issued against it.
 * 4. **Code** — the SHA-256 of a random value, sixty seconds, single-use, bound to the client,
 *    the redirect URI, the PKCE challenge, the resource and the grant. A second exchange of the
 *    same code is treated as interception and revokes the grant (RFC 6749 §4.1.2).
 * 5. **Refresh** — rotates on every use. A spent refresh token presented again is reuse, and
 *    revokes the grant — except inside `MCP_REFRESH_RETRY_GRACE_MS` while its successor is unused,
 *    where it answers the same successor pair (`seal.ts` says how, without storing a plaintext).
 */
import type { McpScope } from '@rocketflare/shared/mcp'
import { MCP_SCOPES } from '@rocketflare/shared/mcp'
import type { ConsentDetails, ConsentOrganisation } from '@rocketflare/shared/oauth'
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import { type AppConfig, isIdpManaged } from '../../../config'
import type { Database } from '../../../db/client'
import {
  type McpGrantRow,
  mcpGrants,
  mcpTokens,
  type OAuthClientRow,
  type OAuthRequestRow,
  oauthClients,
  oauthRequests,
  tenants,
  tenantUsers,
} from '../../../db/schema'
import { withTenantScope } from '../../../db/tenant-scope'
import { hashToken, safeEqual } from '../../utils/core/hash'
import { randomToken, toBase64Url } from '../../utils/core/ids'
import { recordActivity } from '../activity'
import { mcpToolProfile } from '../agents/tools/surfaces'
import { resolveMcpMember } from './caller'
import {
  isLoopbackRedirect,
  OAuthClientError,
  REDIRECT_NOT_REGISTERED,
  redirectUriAllowed,
  resolveOAuthClient,
} from './cimd'
import { openWith, sealWith } from './seal'
import {
  createMcpGrant,
  generateMcpTokenPair,
  issueMcpTokenPair,
  MCP_REFRESH_TOKEN_PREFIX,
  type McpTokenPair,
  mcpGrantLapsed,
  mcpResourceUrl,
} from './tokens'
import { mcpToolsFor } from './tools'

export const OAUTH_REQUEST_TTL_MS = 10 * 60 * 1000
export const OAUTH_CODE_TTL_MS = 60 * 1000
export const MCP_REFRESH_RETRY_GRACE_MS = 30 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** The issuer: the app's origin. Every authorization response carries it as `iss` (RFC 9207). */
export function oauthIssuer(cfg: AppConfig): string {
  return new URL(cfg.APP_URL).origin
}

/**
 * An OAuth error with its RFC code — what the token endpoint answers as JSON, and what an
 * authorization response carries back to the client.
 */
export class OAuthError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'invalid_grant'
      | 'invalid_scope'
      | 'invalid_target'
      | 'unsupported_grant_type'
      | 'unsupported_response_type'
      | 'access_denied'
      | 'server_error',
    readonly description: string,
    readonly status = 400
  ) {
    super(description)
    this.name = 'OAuthError'
  }
}

/** `redirect_uri` plus the authorization response's parameters and `iss`. */
export function authorizationRedirect(
  cfg: AppConfig,
  redirectUri: string,
  params: Record<string, string | null | undefined>
): string {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, value)
  }
  url.searchParams.set('iss', oauthIssuer(cfg))
  return url.toString()
}

/** Split a space-delimited `scope`; an absent one is the baseline read scope. */
export function parseScopes(value: string | undefined | null): McpScope[] | null {
  if (value == null || value.trim() === '') return ['mcp:read']
  const asked = [...new Set(value.trim().split(/\s+/))]
  if (!asked.every((s): s is McpScope => (MCP_SCOPES as readonly string[]).includes(s))) return null
  // Asking to make changes implies reading: a write-only client would see no tools to write with.
  return asked.includes('mcp:write') ? ['mcp:read', 'mcp:write'] : ['mcp:read']
}

/**
 * Which organisation a `resource` fixes: `undefined` for the shared `/mcp` (chosen at consent),
 * the tenant for `/mcp/t/<slug>`, or null when it is not one of our MCP URLs at all.
 */
export async function resourceTarget(
  db: Database,
  cfg: AppConfig,
  resource: string | undefined
): Promise<{ resource: string; tenantId?: string } | null> {
  if (!resource) return null
  if (resource === mcpResourceUrl(cfg)) return { resource }
  const prefix = `${mcpResourceUrl(cfg)}/t/`
  if (!resource.startsWith(prefix)) return null
  let slug: string
  try {
    slug = decodeURIComponent(resource.slice(prefix.length))
  } catch {
    return null // a malformed `%` sequence names no organisation
  }
  if (!slug || slug.includes('/')) return null
  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug))
  if (!tenant || resource !== mcpResourceUrl(cfg, slug)) return null
  return { resource, tenantId: tenant.id }
}

const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/

async function pkceS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return toBase64Url(new Uint8Array(digest))
}

export type AuthorizeOutcome =
  /**
   * Rendered on our own origin — the client or its redirect could not be trusted. `reason` is
   * the specific cause behind a uniform description, for the server log only.
   */
  | { kind: 'page'; description: string; reason?: string }
  /** Back to the client with an error. */
  | { kind: 'redirect'; location: string }
  /** A pending request, waiting for sign-in and consent. */
  | { kind: 'pending'; request: OAuthRequestRow; client: OAuthClientRow }

/** `GET /oauth/authorize`'s checks, in the order the spec says errors may be reported. */
export async function startAuthorization(
  db: Database,
  cfg: AppConfig,
  query: Record<string, string | undefined>,
  now = new Date()
): Promise<AuthorizeOutcome> {
  let client: OAuthClientRow
  try {
    client = await resolveOAuthClient(db, query.client_id, {
      now,
      forRedirect: { uri: query.redirect_uri },
    })
  } catch (err) {
    if (err instanceof OAuthClientError) {
      return {
        kind: 'page',
        description: err.description,
        ...(err.reason && { reason: err.reason }),
      }
    }
    throw err
  }
  const redirectUri = query.redirect_uri
  if (!redirectUri || !redirectUriAllowed(client, redirectUri)) {
    return { kind: 'page', description: REDIRECT_NOT_REGISTERED }
  }
  const state = query.state
  const fail = (error: string, description: string): AuthorizeOutcome => ({
    kind: 'redirect',
    location: authorizationRedirect(cfg, redirectUri, {
      error,
      error_description: description,
      state,
    }),
  })
  if (state && state.length > 1024) return fail('invalid_request', 'state is too long')
  if (query.response_type !== 'code') {
    return fail('unsupported_response_type', 'response_type must be "code"')
  }
  if (query.code_challenge_method !== 'S256' || !PKCE_CHALLENGE.test(query.code_challenge ?? '')) {
    return fail(
      'invalid_request',
      'PKCE is required: code_challenge with code_challenge_method S256'
    )
  }
  const scopes = parseScopes(query.scope)
  if (!scopes) return fail('invalid_scope', 'scope may name only mcp:read and mcp:write')
  const target = await resourceTarget(db, cfg, query.resource)
  if (!target) {
    return fail('invalid_target', `resource must be this server's MCP URL (${mcpResourceUrl(cfg)})`)
  }
  const [request] = await db
    .insert(oauthRequests)
    .values({
      clientId: client.clientId,
      redirectUri,
      scopes,
      resource: target.resource,
      codeChallenge: query.code_challenge as string,
      state: state ?? null,
      expiresAt: new Date(now.getTime() + OAUTH_REQUEST_TTL_MS),
    })
    .returning()
  if (!request) throw new Error('oauth_requests: insert returned no row')
  return { kind: 'pending', request, client }
}

/** A request still waiting for its decision, or null (unknown, expired, decided). */
export async function pendingRequest(
  db: Database,
  requestId: string,
  now = new Date()
): Promise<{ request: OAuthRequestRow; client: OAuthClientRow } | null> {
  const [row] = await db
    .select({ request: oauthRequests, client: oauthClients })
    .from(oauthRequests)
    .innerJoin(oauthClients, eq(oauthClients.clientId, oauthRequests.clientId))
    .where(
      and(
        eq(oauthRequests.id, requestId),
        gt(oauthRequests.expiresAt, now),
        isNull(oauthRequests.consumedAt),
        isNull(oauthRequests.codeHash)
      )
    )
  if (!row) return null
  // The client's document may have changed since: the redirect must still be one it registers.
  if (!redirectUriAllowed(row.client, row.request.redirectUri)) return null
  return row
}

/** The grant's absolute end: `MCP_GRANT_MAX_DAYS`, never past an IdP-managed session's cap. */
export function grantExpiry(cfg: AppConfig, now = new Date()): Date {
  const days = isIdpManaged(cfg)
    ? Math.min(cfg.MCP_GRANT_MAX_DAYS, cfg.OIDC_SESSION_MAX_AGE_DAYS)
    : cfg.MCP_GRANT_MAX_DAYS
  return new Date(now.getTime() + days * DAY_MS)
}

/** The live grant for exactly this person, organisation, client and URL, if there is one. */
export async function liveGrantFor(
  db: Database,
  cfg: AppConfig,
  input: { tenantId: string; userId: string; clientId: string; resource: string },
  now = new Date()
): Promise<McpGrantRow | null> {
  const rows = await db
    .select()
    .from(mcpGrants)
    .where(
      and(
        eq(mcpGrants.tenantId, input.tenantId),
        eq(mcpGrants.userId, input.userId),
        eq(mcpGrants.clientId, input.clientId),
        eq(mcpGrants.resource, input.resource),
        isNull(mcpGrants.revokedAt),
        gt(mcpGrants.expiresAt, now)
      )
    )
  return rows.find(g => !mcpGrantLapsed(cfg, g, now)) ?? null
}

/** The organisations a person belongs to that a request could be approved for. */
async function candidateTenants(db: Database, userId: string, fixedTenantId?: string) {
  return db
    .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
    .from(tenantUsers)
    .innerJoin(tenants, eq(tenants.id, tenantUsers.tenantId))
    .where(
      and(
        eq(tenantUsers.userId, userId),
        fixedTenantId ? eq(tenantUsers.tenantId, fixedTenantId) : undefined
      )
    )
    .orderBy(tenants.name)
}

/**
 * Every organisation the person may connect this request's client to, with the tools it would see
 * there. An organisation where `resolveMcpMember` refuses them is simply not offered.
 */
export async function eligibleOrganisations(
  db: Database,
  cfg: AppConfig,
  env: Cloudflare.Env,
  input: { userId: string; request: OAuthRequestRow },
  now = new Date()
): Promise<ConsentOrganisation[]> {
  const target = await resourceTarget(db, cfg, input.request.resource)
  if (!target) return []
  const out: ConsentOrganisation[] = []
  for (const tenant of await candidateTenants(db, input.userId, target.tenantId)) {
    const member = await resolveMcpMember(db, cfg, {
      userId: input.userId,
      tenantId: tenant.id,
      sessionId: `oauth:${input.request.id}`,
    }).catch(() => null)
    if (!member) continue
    const tools = await withTenantScope(db, tenant.id, cfg.TENANT_SCOPE_MODE, sdb =>
      mcpToolsFor({ db: sdb, cfg, env, auth: member.auth, settings: member.settings })
    )
    const live = await liveGrantFor(
      db,
      cfg,
      {
        tenantId: tenant.id,
        userId: input.userId,
        clientId: input.request.clientId,
        resource: input.request.resource,
      },
      now
    )
    out.push({
      ...tenant,
      tools: tools.map(t => ({ name: t.name, title: mcpToolProfile(t).title ?? null })),
      connected: live?.activatedAt != null,
    })
  }
  return out
}

/** Everything the consent page shows for a pending request. */
export async function consentDetails(
  db: Database,
  cfg: AppConfig,
  env: Cloudflare.Env,
  input: { userId: string; request: OAuthRequestRow; client: OAuthClientRow }
): Promise<ConsentDetails> {
  const { request, client } = input
  const target = await resourceTarget(db, cfg, request.resource)
  return {
    requestId: request.id,
    appName: cfg.APP_NAME,
    client: {
      claimedName: client.clientName,
      claimedLogoUri: client.logoUri,
      verifiedHost: new URL(client.clientId).host,
      clientId: client.clientId,
    },
    redirectHost: new URL(request.redirectUri).host,
    loopbackOnly: client.redirectUris.every(isLoopbackRedirect),
    scopes: request.scopes,
    organisations: await eligibleOrganisations(db, cfg, env, { userId: input.userId, request }),
    organisationFixed: Boolean(target?.tenantId),
    singleTenant: cfg.TENANCY_MODE === 'single',
  }
}

/**
 * Issue the authorization code for an approved request against `grant`, and answer the client's
 * redirect. The request row now carries the code (hash only) and can never be approved again.
 */
async function issueCode(
  db: Database,
  cfg: AppConfig,
  request: OAuthRequestRow,
  input: { userId: string; grant: McpGrantRow },
  now: Date
): Promise<string> {
  const code = randomToken(32)
  const [issued] = await db
    .update(oauthRequests)
    .set({
      userId: input.userId,
      grantId: input.grant.id,
      codeHash: await hashToken(code),
      codeExpiresAt: new Date(now.getTime() + OAUTH_CODE_TTL_MS),
    })
    .where(
      and(
        eq(oauthRequests.id, request.id),
        isNull(oauthRequests.codeHash),
        isNull(oauthRequests.consumedAt)
      )
    )
    .returning({ id: oauthRequests.id })
  if (!issued) throw new OAuthError('invalid_request', 'This request was already decided')
  return authorizationRedirect(cfg, request.redirectUri, { code, state: request.state })
}

/**
 * A remembered consent: the request fixes ONE organisation (its URL does, or the person has only
 * one they may connect), a live connection there from this client covers every scope asked, and
 * the person is still admitted. Answers the client redirect with a code, or null for the page.
 */
export async function rememberedConsent(
  db: Database,
  cfg: AppConfig,
  input: { userId: string; request: OAuthRequestRow },
  now = new Date()
): Promise<string | null> {
  const { request } = input
  const target = await resourceTarget(db, cfg, request.resource)
  if (!target) return null
  const candidates = await candidateTenants(db, input.userId, target.tenantId)
  if (candidates.length !== 1) return null
  const tenantId = candidates[0]?.id as string
  const grant = await liveGrantFor(
    db,
    cfg,
    { tenantId, userId: input.userId, clientId: request.clientId, resource: request.resource },
    now
  )
  if (!grant || !request.scopes.every(s => grant.scopes.includes(s))) return null
  const member = await resolveMcpMember(db, cfg, {
    userId: input.userId,
    tenantId,
    sessionId: `oauth:${request.id}`,
  }).catch(() => null)
  if (!member) return null
  return issueCode(db, cfg, request, { userId: input.userId, grant }, now)
}

/**
 * The person's decision. Deny → `access_denied`. Approve → the organisation is admitted again
 * (`resolveMcpMember` throws the 403 when not), a URL that fixes the organisation must be matched,
 * the grant is made (or the live one for this client, organisation and URL reused, its scopes set
 * to what was just approved), and the code issued.
 */
export async function decideConsent(
  db: Database,
  cfg: AppConfig,
  input: {
    userId: string
    request: OAuthRequestRow
    client: OAuthClientRow
    approve: boolean
    tenantId?: string
  },
  now = new Date()
): Promise<string> {
  const { request } = input
  if (!input.approve || !input.tenantId) {
    await db
      .update(oauthRequests)
      .set({ consumedAt: now })
      .where(and(eq(oauthRequests.id, request.id), isNull(oauthRequests.consumedAt)))
    return authorizationRedirect(cfg, request.redirectUri, {
      error: 'access_denied',
      error_description: 'The person declined to connect',
      state: request.state,
    })
  }
  const target = await resourceTarget(db, cfg, request.resource)
  if (!target || (target.tenantId && target.tenantId !== input.tenantId)) {
    throw new OAuthError('invalid_target', 'This connection is for another organisation', 403)
  }
  const member = await resolveMcpMember(db, cfg, {
    userId: input.userId,
    tenantId: input.tenantId,
    sessionId: `oauth:${request.id}`,
  })
  if (!member) throw new OAuthError('access_denied', 'Unknown person', 403)

  return db.transaction(async txh => {
    const tx = txh as unknown as Database
    const existing = await liveGrantFor(
      tx,
      cfg,
      {
        tenantId: input.tenantId as string,
        userId: input.userId,
        clientId: request.clientId,
        resource: request.resource,
      },
      now
    )
    let grant: McpGrantRow
    if (existing) {
      const [updated] = await tx
        .update(mcpGrants)
        .set({ scopes: request.scopes, lastUsedAt: now })
        .where(and(eq(mcpGrants.tenantId, existing.tenantId), eq(mcpGrants.id, existing.id)))
        .returning()
      grant = updated ?? existing
    } else {
      grant = await createMcpGrant(
        tx,
        cfg,
        {
          tenantId: input.tenantId as string,
          userId: input.userId,
          clientId: request.clientId,
          scopes: request.scopes,
          resource: request.resource,
          expiresAt: grantExpiry(cfg, now),
        },
        now
      )
    }
    return issueCode(tx, cfg, request, { userId: input.userId, grant }, now)
  })
}

export interface TokenAnswer {
  pair: McpTokenPair
  scopes: McpScope[]
  grant: McpGrantRow
}

/** Revoke one grant; true when this call ended it. */
export async function revokeGrant(
  db: Database,
  grant: Pick<McpGrantRow, 'id' | 'tenantId'>,
  input: { byUserId?: string | null; reason: string },
  now = new Date()
): Promise<boolean> {
  const ended = await db
    .update(mcpGrants)
    .set({ revokedAt: now, revokedByUserId: input.byUserId ?? null, revokeReason: input.reason })
    .where(
      and(
        eq(mcpGrants.tenantId, grant.tenantId),
        eq(mcpGrants.id, grant.id),
        isNull(mcpGrants.revokedAt)
      )
    )
    .returning({ id: mcpGrants.id })
  return ended.length > 0
}

/** A grant that has ended (revoked, past its absolute end, idle) answers `invalid_grant`. */
const GRANT_ENDED = () => new OAuthError('invalid_grant', 'The connection has ended; connect again')

/** `grant_type=authorization_code`. */
export async function exchangeCode(
  db: Database,
  cfg: AppConfig,
  form: Record<string, string | undefined>,
  now = new Date()
): Promise<TokenAnswer> {
  const { code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri } = form
  if (!code || !verifier || !clientId || !redirectUri) {
    throw new OAuthError(
      'invalid_request',
      'code, code_verifier, client_id and redirect_uri are required'
    )
  }
  if (!PKCE_VERIFIER.test(verifier)) {
    throw new OAuthError('invalid_request', 'code_verifier is malformed')
  }
  // Every failure after the claim still COMMITS the claim (and any revocation): a code that was
  // presented wrongly is spent, so it cannot be tried again with another verifier.
  const outcome = await db.transaction(async (txh): Promise<TokenAnswer | OAuthError> => {
    const tx = txh as unknown as Database
    const [row] = await tx
      .select({ request: oauthRequests, grant: mcpGrants })
      .from(oauthRequests)
      .innerJoin(mcpGrants, eq(mcpGrants.id, oauthRequests.grantId))
      .where(eq(oauthRequests.codeHash, await hashToken(code)))
    if (!row) return new OAuthError('invalid_grant', 'The authorization code is invalid')
    const { request, grant } = row
    // Single use: claim it, or it was used before — which means it was intercepted.
    const [claimed] = await tx
      .update(oauthRequests)
      .set({ consumedAt: now })
      .where(and(eq(oauthRequests.id, request.id), isNull(oauthRequests.consumedAt)))
      .returning({ id: oauthRequests.id })
    if (!claimed) {
      await revokeGrant(tx, grant, { reason: 'code_replayed' }, now)
      return new OAuthError('invalid_grant', 'The authorization code was already used')
    }
    if (!request.codeExpiresAt || request.codeExpiresAt.getTime() <= now.getTime()) {
      return new OAuthError('invalid_grant', 'The authorization code has expired')
    }
    if (request.clientId !== clientId || request.redirectUri !== redirectUri) {
      return new OAuthError('invalid_grant', 'client_id or redirect_uri does not match the code')
    }
    if (form.resource && form.resource !== request.resource) {
      return new OAuthError('invalid_target', 'resource does not match the authorization request')
    }
    if (!safeEqual(await pkceS256(verifier), request.codeChallenge)) {
      return new OAuthError('invalid_grant', 'code_verifier does not match the code_challenge')
    }
    if (mcpGrantLapsed(cfg, grant, now)) return GRANT_ENDED()
    const pair = await issueMcpTokenPair(tx, grant, { now })
    await tx
      .update(mcpGrants)
      .set({ lastUsedAt: now, activatedAt: grant.activatedAt ?? now })
      .where(and(eq(mcpGrants.tenantId, grant.tenantId), eq(mcpGrants.id, grant.id)))
    const [client] = await tx
      .update(oauthClients)
      .set({ lastUsedAt: now })
      .where(eq(oauthClients.clientId, grant.clientId))
      .returning({ clientName: oauthClients.clientName })
    // The connection exists from its first redeemed code — a consent whose code is never
    // exchanged leaves no connection behind (the nightly retention sweeps that grant).
    if (!grant.activatedAt) {
      await recordActivity(tx, {
        tenantId: grant.tenantId,
        userId: grant.userId,
        type: 'mcp.client_connected',
        subjectType: 'McpGrant',
        subjectId: grant.id,
        metadata: {
          clientId: grant.clientId,
          clientName: client?.clientName ?? null,
          scopes: grant.scopes,
        },
      })
    }
    return {
      pair,
      scopes: grant.scopes,
      grant: { ...grant, activatedAt: grant.activatedAt ?? now },
    }
  })
  if (outcome instanceof OAuthError) throw outcome
  return outcome
}

interface SealedSuccessor {
  accessToken: string
  refreshToken: string
  accessExpiresAt: string
}

/** The refresh token row and its grant, by plaintext — or null. Owner connection. */
async function findRefreshToken(db: Database, plaintext: string) {
  if (!plaintext.startsWith(MCP_REFRESH_TOKEN_PREFIX)) return null
  const [row] = await db
    .select({ token: mcpTokens, grant: mcpGrants })
    .from(mcpTokens)
    .innerJoin(
      mcpGrants,
      and(eq(mcpGrants.id, mcpTokens.grantId), eq(mcpGrants.tenantId, mcpTokens.tenantId))
    )
    .where(and(eq(mcpTokens.tokenHash, await hashToken(plaintext)), eq(mcpTokens.kind, 'refresh')))
  return row ?? null
}

/**
 * The grant a token-endpoint request is about, before anything is decided — what the per-grant
 * rate limit is keyed on. Null for anything unknown.
 */
export async function grantOfTokenRequest(
  db: Database,
  form: Record<string, string | undefined>
): Promise<string | null> {
  if (form.grant_type === 'refresh_token' && form.refresh_token) {
    return (await findRefreshToken(db, form.refresh_token))?.grant.id ?? null
  }
  if (form.grant_type === 'authorization_code' && form.code) {
    const [row] = await db
      .select({ grantId: oauthRequests.grantId })
      .from(oauthRequests)
      .where(eq(oauthRequests.codeHash, await hashToken(form.code)))
    return row?.grantId ?? null
  }
  return null
}

/** `grant_type=refresh_token`: rotate, or answer a retry inside the grace, or detect reuse. */
export async function refreshTokens(
  db: Database,
  cfg: AppConfig,
  form: Record<string, string | undefined>,
  now = new Date()
): Promise<TokenAnswer> {
  const presented = form.refresh_token
  if (!presented || !form.client_id) {
    throw new OAuthError('invalid_request', 'refresh_token and client_id are required')
  }
  const scopesAsked = form.scope ? parseScopes(form.scope) : null
  if (form.scope && !scopesAsked) {
    throw new OAuthError('invalid_scope', 'scope may name only mcp:read and mcp:write')
  }
  // A detected reuse must COMMIT its revocation, so failures are returned out of the
  // transaction and thrown after it.
  const outcome = await db.transaction(async (txh): Promise<TokenAnswer | OAuthError> => {
    const tx = txh as unknown as Database
    const found = await findRefreshToken(tx, presented)
    if (!found) return new OAuthError('invalid_grant', 'The refresh token is invalid')
    const { token, grant } = found
    if (grant.clientId !== form.client_id) {
      return new OAuthError('invalid_grant', 'The refresh token was issued to another client')
    }
    if (form.resource && form.resource !== grant.resource) {
      return new OAuthError('invalid_target', 'resource does not match the connection')
    }
    if (scopesAsked && !scopesAsked.every(s => grant.scopes.includes(s))) {
      return new OAuthError('invalid_scope', 'A refresh cannot widen the scopes; connect again')
    }
    if (mcpGrantLapsed(cfg, grant, now)) return GRANT_ENDED()
    if (token.expiresAt.getTime() <= now.getTime()) {
      return new OAuthError('invalid_grant', 'The refresh token has expired')
    }

    const pair = generateMcpTokenPair()
    const sealed = await sealWith(presented, {
      ...pair,
      // Fixed here so a retry answers the same expiry the first answer did.
      accessExpiresAt: new Date(
        Math.min(now.getTime() + 60 * 60 * 1000, grant.expiresAt.getTime())
      ).toISOString(),
    } satisfies SealedSuccessor)
    // Spend it — or learn that it was spent already (by this request's twin, or by a thief).
    const [spent] = await tx
      .update(mcpTokens)
      .set({ usedAt: now, successorSealed: sealed })
      .where(and(eq(mcpTokens.id, token.id), isNull(mcpTokens.usedAt)))
      .returning({ id: mcpTokens.id })
    if (!spent) return retryOrReuse(tx, { presented, grant, tokenId: token.id }, now)

    const issued = await issueMcpTokenPair(tx, grant, { now, rotatedFrom: token.id, pair })
    await tx
      .update(mcpGrants)
      .set({ lastUsedAt: now })
      .where(and(eq(mcpGrants.tenantId, grant.tenantId), eq(mcpGrants.id, grant.id)))
    // Older spent tokens of this grant are past any retry: drop what they sealed.
    await tx
      .update(mcpTokens)
      .set({ successorSealed: null })
      .where(
        and(
          eq(mcpTokens.tenantId, grant.tenantId),
          eq(mcpTokens.grantId, grant.id),
          lt(mcpTokens.usedAt, new Date(now.getTime() - MCP_REFRESH_RETRY_GRACE_MS))
        )
      )
    return { pair: issued, scopes: grant.scopes, grant }
  })
  if (outcome instanceof OAuthError) throw outcome
  return outcome
}

/**
 * A spent refresh token presented again. Inside the grace, while its successor is still unused,
 * the same successor pair; otherwise it is reuse, and the whole grant is revoked.
 */
async function retryOrReuse(
  tx: Database,
  input: { presented: string; grant: McpGrantRow; tokenId: string },
  now: Date
): Promise<TokenAnswer | OAuthError> {
  const [token] = await tx.select().from(mcpTokens).where(eq(mcpTokens.id, input.tokenId))
  const withinGrace =
    token?.usedAt && now.getTime() - token.usedAt.getTime() <= MCP_REFRESH_RETRY_GRACE_MS
  if (withinGrace && token?.successorSealed) {
    const successor = await openWith<SealedSuccessor>(input.presented, token.successorSealed)
    if (successor) {
      const [next] = await tx
        .select({ usedAt: mcpTokens.usedAt })
        .from(mcpTokens)
        .where(eq(mcpTokens.tokenHash, await hashToken(successor.refreshToken)))
      const accessExpiresAt = new Date(successor.accessExpiresAt)
      if (next && !next.usedAt && accessExpiresAt.getTime() > now.getTime()) {
        return {
          pair: {
            accessToken: successor.accessToken,
            refreshToken: successor.refreshToken,
            expiresIn: Math.floor((accessExpiresAt.getTime() - now.getTime()) / 1000),
            accessExpiresAt,
          },
          scopes: input.grant.scopes,
          grant: input.grant,
        }
      }
    }
  }
  // Committed even though the request fails: the revocation is the point.
  await revokeGrant(tx, input.grant, { reason: 'refresh_token_reused' }, now)
  await tx
    .update(mcpTokens)
    .set({ successorSealed: null })
    .where(and(eq(mcpTokens.tenantId, input.grant.tenantId), eq(mcpTokens.grantId, input.grant.id)))
  return new OAuthError(
    'invalid_grant',
    'The refresh token was already used; the connection has been revoked'
  )
}

/**
 * RFC 7009. A refresh token ends the whole connection; an access token ends just itself. Always
 * succeeds from the caller's point of view — an unknown token, or one of another client, is
 * silently ignored, so the endpoint cannot be used to test tokens.
 */
export async function revokeToken(
  db: Database,
  form: Record<string, string | undefined>,
  now = new Date()
): Promise<void> {
  const { token, client_id: clientId } = form
  if (!token) return
  const [row] = await db
    .select({ token: mcpTokens, grant: mcpGrants })
    .from(mcpTokens)
    .innerJoin(
      mcpGrants,
      and(eq(mcpGrants.id, mcpTokens.grantId), eq(mcpGrants.tenantId, mcpTokens.tenantId))
    )
    .where(eq(mcpTokens.tokenHash, await hashToken(token)))
  if (!row || (clientId && row.grant.clientId !== clientId)) return
  if (row.token.kind === 'refresh') {
    if (
      await revokeGrant(
        db,
        row.grant,
        { byUserId: row.grant.userId, reason: 'client_revoked' },
        now
      )
    ) {
      await recordActivity(db, {
        tenantId: row.grant.tenantId,
        userId: row.grant.userId,
        type: 'mcp.client_revoked',
        subjectType: 'McpGrant',
        subjectId: row.grant.id,
        metadata: { clientId: row.grant.clientId, reason: 'client_revoked', by: 'client' },
      })
    }
    return
  }
  await db
    .update(mcpTokens)
    .set({ expiresAt: now })
    .where(and(eq(mcpTokens.tenantId, row.token.tenantId), eq(mcpTokens.id, row.token.id)))
}

/** The nightly sweep: requests and codes past their deadline (and a day of slack). */
export async function pruneOAuthRequests(db: Database, now = new Date()) {
  const cutoff = new Date(now.getTime() - DAY_MS)
  const removed = await db
    .delete(oauthRequests)
    .where(
      or(
        lt(oauthRequests.expiresAt, cutoff),
        and(
          sql`${oauthRequests.codeExpiresAt} is not null`,
          lt(oauthRequests.codeExpiresAt, cutoff)
        )
      )
    )
    .returning({ id: oauthRequests.id })
  return removed.length
}
