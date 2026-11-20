/**
 * The authorization server: the discovery documents, `/oauth/authorize`'s checks (and that no
 * error before the redirect is validated is ever a redirect), consent, the code (PKCE, exact
 * redirect, single use, sixty seconds), refresh rotation with its retry grace and reuse
 * detection, revocation, the connection's idle and absolute limits — end to end through `/mcp`.
 *
 * The client's metadata document is seeded in the cache (`tests/helpers/oauth.ts`); the fetch and
 * its guard are unit-tested in `tests/config/mcp-cimd.test.ts`.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { listMcpConnections } from '@/api/services/mcp/connections'
import { runPruneMcp } from '@/api/services/mcp/retention'
import { loadConfig } from '@/config'
import { activityEvents, mcpGrants, mcpTokens, oauthRequests } from '@/db/schema'
import {
  createTestSession,
  createTestTenant,
  createTestUser,
  linkUserToTenant,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { enableMcp, mcpClient, mcpPost, mcpTestEnv } from '../helpers/mcp'
import {
  authorizeAndApprove,
  authorizePath,
  browserGet,
  CLAUDE_LIKE_CLIENT,
  CLAUDE_LIKE_REDIRECT,
  connectViaOAuth,
  consentPost,
  LOOPBACK_CLIENT,
  pkcePair,
  requestIdFrom,
  revokePost,
  seedOAuthClient,
  tokenPost,
  validAuthorize,
} from '../helpers/oauth'
import { request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const env = mcpTestEnv()
const cfg = loadConfig(env)
const ORIGIN = new URL(cfg.APP_URL).origin
const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }

async function member(role: 'owner' | 'admin' | 'member' = 'member') {
  const tenant = await createTestTenant(db)
  const owner = await createTestUser(db)
  await linkUserToTenant(db, owner.id, tenant.id, 'owner')
  await enableMcp(db, tenant.id, owner.id)
  const user = role === 'owner' ? owner : await createTestUser(db)
  if (role !== 'owner') await linkUserToTenant(db, user.id, tenant.id, role)
  const cookie = await createTestSession(db, user.id, tenant.id)
  await seedOAuthClient(db)
  return { tenant, user, owner, cookie }
}

describe('discovery documents', () => {
  it('protected-resource metadata names the exact resource, for /mcp and an organisation URL', async () => {
    for (const [path, resource] of [
      ['/.well-known/oauth-protected-resource', `${ORIGIN}/mcp`],
      ['/.well-known/oauth-protected-resource/mcp', `${ORIGIN}/mcp`],
      ['/.well-known/oauth-protected-resource/mcp/t/acme', `${ORIGIN}/mcp/t/acme`],
    ] as const) {
      const res = await request(path, {}, { env })
      expect(res.status).toBe(200)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
      expect(await res.json()).toEqual({
        resource,
        authorization_servers: [ORIGIN],
        scopes_supported: ['mcp:read', 'mcp:write'],
        bearer_methods_supported: ['header'],
        resource_name: cfg.APP_NAME,
      })
    }
  })

  it('authorization-server metadata: S256, public clients, CIMD, iss, and no registration', async () => {
    for (const path of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
    ]) {
      const doc = (await (await request(path, {}, { env })).json()) as Record<string, unknown>
      expect(doc).toMatchObject({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/oauth/authorize`,
        token_endpoint: `${ORIGIN}/oauth/token`,
        revocation_endpoint: `${ORIGIN}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
      })
      expect(doc).not.toHaveProperty('registration_endpoint')
    }
  })

  it('every document and endpoint is 404 on a deployment that does not ship mcp', async () => {
    const off = createTestEnv()
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
      authorizePath(validAuthorize(off)),
    ]) {
      expect((await request(path, {}, { env: off })).status, path).toBe(404)
    }
    expect((await tokenPost(off, { grant_type: 'refresh_token' })).status).toBe(404)
  })

  it('the /mcp challenge points at the metadata for the URL it was presented on', async () => {
    const res = await mcpPost(env, '/mcp/t/acme', LIST)
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp/t/acme"`
    )
  })
})

describe('authorize: before the redirect is trusted, errors are a page — never a redirect', () => {
  it('a client_id that is not an https metadata URL', async () => {
    for (const client_id of [
      'not-a-url',
      'http://client.example.com/meta.json',
      'https://127.0.0.1/meta.json',
      'https://localhost/meta.json',
      'https://client.example.com:8443/meta.json',
      'https://client.example.com/',
    ]) {
      const res = await browserGet(env, authorizePath(validAuthorize(env, { client_id })))
      expect(res.status, client_id).toBe(400)
      expect(res.headers.get('Location')).toBeNull()
      expect(res.headers.get('Content-Type')).toContain('text/html')
    }
  })

  it('a redirect_uri the client did not register', async () => {
    await seedOAuthClient(db)
    for (const redirect_uri of [
      'https://evil.example/callback',
      `${CLAUDE_LIKE_REDIRECT}/extra`,
      `${CLAUDE_LIKE_REDIRECT}?x=1`,
      'http://127.0.0.1:9999/callback',
    ]) {
      const res = await browserGet(env, authorizePath(validAuthorize(env, { redirect_uri })))
      expect(res.status, redirect_uri).toBe(400)
      expect(res.headers.get('Location')).toBeNull()
    }
  })

  it('a stale cache refetches the document — and a failed fetch fails, it never falls back', async () => {
    // Its own client: the shared one is cached for every file running alongside this one, and
    // backdating it would send their authorizations to the (absent) network too.
    const clientId = `https://stale-${crypto.randomUUID()}.example.com/client.json`
    await seedOAuthClient(db, {
      clientId,
      fetchedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    })
    // The api suites have no network, so the refetch fails exactly as an unreachable host would.
    const res = await browserGet(env, authorizePath(validAuthorize(env, { client_id: clientId })))
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('could not be used')
  })

  it('a loopback redirect may use any port; scheme, host and path must match', async () => {
    await seedOAuthClient(db, {
      clientId: LOOPBACK_CLIENT,
      redirectUris: ['http://127.0.0.1/callback'],
    })
    const ok = await browserGet(
      env,
      authorizePath(
        validAuthorize(env, {
          client_id: LOOPBACK_CLIENT,
          redirect_uri: 'http://127.0.0.1:54321/callback',
        })
      )
    )
    expect(ok.status).toBe(302)
    for (const redirect_uri of [
      'http://127.0.0.1:54321/other',
      'http://localhost:54321/callback',
    ]) {
      const res = await browserGet(
        env,
        authorizePath(validAuthorize(env, { client_id: LOOPBACK_CLIENT, redirect_uri }))
      )
      expect(res.status, redirect_uri).toBe(400)
    }
  })
})

describe('authorize: once the redirect is trusted, errors go back with state and iss', () => {
  async function errorOf(overrides: Parameters<typeof validAuthorize>[1]) {
    await seedOAuthClient(db)
    const res = await browserGet(env, authorizePath(validAuthorize(env, overrides)))
    expect(res.status).toBe(302)
    const url = new URL(res.headers.get('Location') ?? '')
    expect(`${url.origin}${url.pathname}`).toBe(CLAUDE_LIKE_REDIRECT)
    expect(url.searchParams.get('iss')).toBe(ORIGIN)
    expect(url.searchParams.get('state')).toBe('st-123')
    return url.searchParams.get('error')
  }

  it('PKCE is mandatory, and only S256', async () => {
    expect(await errorOf({ code_challenge: '' })).toBe('invalid_request')
    expect(await errorOf({ code_challenge_method: 'plain' })).toBe('invalid_request')
    expect(await errorOf({ code_challenge_method: undefined })).toBe('invalid_request')
  })

  it('response_type must be code', async () => {
    expect(await errorOf({ response_type: 'token' })).toBe('unsupported_response_type')
  })

  it('resource must be one of our MCP URLs (invalid_target)', async () => {
    expect(await errorOf({ resource: undefined })).toBe('invalid_target')
    expect(await errorOf({ resource: 'https://other.example/mcp' })).toBe('invalid_target')
    expect(await errorOf({ resource: `${ORIGIN}/mcp/t/no-such-org` })).toBe('invalid_target')
  })

  it('scopes are mcp:read and mcp:write only', async () => {
    expect(await errorOf({ scope: 'openid' })).toBe('invalid_scope')
  })
})

describe('sign-in goes through the app', () => {
  it('no session → /login with a returnUrl back to the pending request', async () => {
    await seedOAuthClient(db)
    const res = await browserGet(env, authorizePath(validAuthorize(env)))
    expect(res.status).toBe(302)
    const location = res.headers.get('Location') ?? ''
    expect(location).toMatch(/^\/login\?returnUrl=%2Foauth%2Fcontinue%3Frequest%3D/)
    // ...and once signed in, continue lands on the consent page.
    const { user, tenant } = await member()
    const cookie = await createTestSession(db, user.id, tenant.id)
    const cont = await browserGet(env, `/oauth/continue?request=${requestIdFrom(location)}`, cookie)
    expect(cont.headers.get('Location')).toMatch(/^\/consent\?request=/)
  })
})

describe('consent', () => {
  it('shows the claimed client, its verified host, the scopes and the tools — and writes nothing', async () => {
    const { cookie, tenant } = await member()
    const start = await browserGet(
      env,
      authorizePath(validAuthorize(env, { scope: 'mcp:read mcp:write' })),
      cookie
    )
    const id = requestIdFrom(start.headers.get('Location'))
    const res = await request(
      `/oauth/consent/${id}`,
      { headers: { Cookie: `__Host-session=${cookie}` } },
      { env }
    )
    expect(res.status).toBe(200)
    const details = (await res.json()) as Record<string, unknown>
    expect(details).toMatchObject({
      appName: cfg.APP_NAME,
      client: { claimedName: 'Example Client', verifiedHost: 'client.example.com' },
      redirectHost: 'client.example.com',
      loopbackOnly: false,
      scopes: ['mcp:read', 'mcp:write'],
      organisationFixed: false,
    })
    const orgs = details.organisations as { id: string; tools: { name: string }[] }[]
    expect(orgs.map(o => o.id)).toEqual([tenant.id])
    expect(orgs[0]?.tools.map(t => t.name)).toContain('search_knowledge')
    expect(await db.select().from(mcpGrants).where(eq(mcpGrants.tenantId, tenant.id))).toEqual([])
  })

  it('deny goes back with access_denied, state and iss, and the request is spent', async () => {
    const { cookie } = await member()
    const start = await browserGet(env, authorizePath(validAuthorize(env)), cookie)
    const requestId = requestIdFrom(start.headers.get('Location'))
    const res = await consentPost(env, cookie, { requestId, approve: false })
    const url = new URL(((await res.json()) as { redirectTo: string }).redirectTo)
    expect(url.searchParams.get('error')).toBe('access_denied')
    expect(url.searchParams.get('state')).toBe('st-123')
    expect(url.searchParams.get('iss')).toBe(ORIGIN)
    const again = await consentPost(env, cookie, { requestId, approve: false })
    expect(again.status).toBe(404)
  })

  it('approve answers a code with state and iss; the connection exists once the code is redeemed', async () => {
    const { cookie, tenant, user } = await member()
    const approved = await authorizeAndApprove(env, cookie, { tenantId: tenant.id })
    expect(approved.location.searchParams.get('state')).toBe('st-123')
    expect(approved.location.searchParams.get('iss')).toBe(ORIGIN)
    const [grant] = await db.select().from(mcpGrants).where(eq(mcpGrants.userId, user.id))
    expect(grant).toMatchObject({ tenantId: tenant.id, clientId: CLAUDE_LIKE_CLIENT })
    const connected = () =>
      db
        .select()
        .from(activityEvents)
        .where(
          and(
            eq(activityEvents.tenantId, tenant.id),
            eq(activityEvents.type, 'mcp.client_connected')
          )
        )
    const listed = () => listMcpConnections(db, cfg, { tenantId: tenant.id, status: 'all' })
    // Approved but not redeemed: not a connection yet — nothing listed, nothing recorded.
    expect(grant?.activatedAt).toBeNull()
    expect(await connected()).toHaveLength(0)
    expect(await listed()).toEqual([])

    const res = await tokenPost(env, {
      grant_type: 'authorization_code',
      code: approved.code,
      code_verifier: approved.verifier,
      client_id: approved.clientId,
      redirect_uri: approved.redirectUri,
    })
    expect(res.status).toBe(200)
    expect(await connected()).toHaveLength(1)
    expect((await listed()).map(c => c.id)).toEqual([grant?.id])
  })

  it('a consent whose code is never redeemed leaves nothing behind once the sweep runs', async () => {
    const { cookie, tenant, user } = await member()
    await authorizeAndApprove(env, cookie, { tenantId: tenant.id })
    const grants = () => db.select().from(mcpGrants).where(eq(mcpGrants.userId, user.id))
    // A sweep inside the hour leaves it — the code may still be on its way to the token endpoint.
    await runPruneMcp(db, 90)
    expect(await grants()).toHaveLength(1)
    // Backdate this grant rather than run the sweep in the future: a future clock would also
    // expire every other file's live tokens in the shared database.
    await db
      .update(mcpGrants)
      .set({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(mcpGrants.userId, user.id))
    await runPruneMcp(db, 90)
    expect(await grants()).toEqual([])
    expect(await listMcpConnections(db, cfg, { tenantId: tenant.id, status: 'all' })).toEqual([])
  })

  it('reconnecting the same client to the same organisation with no wider scope skips the click', async () => {
    const { cookie, tenant } = await member()
    await authorizeAndApprove(env, cookie, { tenantId: tenant.id })
    const again = await browserGet(env, authorizePath(validAuthorize(env)), cookie)
    expect(again.status).toBe(302)
    const location = new URL(again.headers.get('Location') ?? '', ORIGIN)
    expect(`${location.origin}${location.pathname}`).toBe(CLAUDE_LIKE_REDIRECT)
    expect(location.searchParams.get('code')).toBeTruthy()
    // A wider scope asks again.
    const wider = await browserGet(
      env,
      authorizePath(validAuthorize(env, { scope: 'mcp:read mcp:write' })),
      cookie
    )
    expect(wider.headers.get('Location')).toMatch(/^\/consent\?/)
  })
})

describe('the code', () => {
  async function codeFor() {
    const { cookie, tenant, user } = await member()
    return { ...(await authorizeAndApprove(env, cookie, { tenantId: tenant.id })), tenant, user }
  }
  const exchange = (c: Awaited<ReturnType<typeof codeFor>>, extra: Record<string, string> = {}) =>
    tokenPost(env, {
      grant_type: 'authorization_code',
      code: c.code,
      code_verifier: c.verifier,
      client_id: c.clientId,
      redirect_uri: c.redirectUri,
      ...extra,
    })

  it('exchanges for an access and refresh pair, no-store', async () => {
    const res = await exchange(await codeFor())
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp:read' })
    expect(body.access_token).toMatch(/^mcpat_/)
    expect(body.refresh_token).toMatch(/^mcprt_/)
  })

  it('a wrong verifier is invalid_grant, and spends the code', async () => {
    const c = await codeFor()
    const wrong = await exchange(c, { code_verifier: pkcePair().verifier })
    expect(wrong.status).toBe(400)
    expect(((await wrong.json()) as { error: string }).error).toBe('invalid_grant')
    expect((await exchange(c)).status).toBe(400)
  })

  it('client_id, redirect_uri and resource must match the request', async () => {
    const mismatches: Record<string, string>[] = [
      { client_id: 'https://other.example.com/meta.json' },
      { redirect_uri: `${CLAUDE_LIKE_REDIRECT}2` },
    ]
    for (const extra of mismatches) {
      const res = await exchange(await codeFor(), extra)
      expect(((await res.json()) as { error: string }).error).toBe('invalid_grant')
    }
    const target = await exchange(await codeFor(), { resource: `${ORIGIN}/mcp/t/other` })
    expect(((await target.json()) as { error: string }).error).toBe('invalid_target')
  })

  it('a second exchange is interception: invalid_grant, and the connection is revoked', async () => {
    const c = await codeFor()
    expect((await exchange(c)).status).toBe(200)
    const replay = await exchange(c)
    expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant')
    const [grant] = await db.select().from(mcpGrants).where(eq(mcpGrants.userId, c.user.id))
    expect(grant?.revokedAt).not.toBeNull()
    expect(grant?.revokeReason).toBe('code_replayed')
  })

  it('expires after sixty seconds', async () => {
    const c = await codeFor()
    await db
      .update(oauthRequests)
      .set({ codeExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthRequests.clientId, CLAUDE_LIKE_CLIENT))
    const res = await exchange(c)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant')
  })

  it('refuses anything but a form body, and an unknown grant type', async () => {
    const json = await request(
      '/oauth/token',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      { env }
    )
    expect(json.status).toBe(400)
    const odd = await tokenPost(env, { grant_type: 'client_credentials' })
    expect(((await odd.json()) as { error: string }).error).toBe('unsupported_grant_type')
  })
})

describe('refresh', () => {
  async function connected() {
    const { cookie, tenant, user } = await member()
    return { ...(await connectViaOAuth(env, cookie, { tenantId: tenant.id })), tenant, user }
  }
  const refresh = (refreshToken: string, clientId = CLAUDE_LIKE_CLIENT) =>
    tokenPost(env, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    })

  it('rotates: a new pair every time, and the new access token works on /mcp', async () => {
    const c = await connected()
    const res = await refresh(c.refreshToken)
    expect(res.status).toBe(200)
    const next = (await res.json()) as { access_token: string; refresh_token: string }
    expect(next.refresh_token).not.toBe(c.refreshToken)
    const client = await mcpClient(env, next.access_token)
    expect((await client.listTools()).tools.length).toBeGreaterThan(0)
    await client.close()
  })

  it('a retry inside the grace gets the SAME successor pair, and the connection lives', async () => {
    const c = await connected()
    const first = (await (await refresh(c.refreshToken)).json()) as Record<string, string>
    const retry = await refresh(c.refreshToken)
    expect(retry.status).toBe(200)
    const second = (await retry.json()) as Record<string, string>
    expect(second.access_token).toBe(first.access_token)
    expect(second.refresh_token).toBe(first.refresh_token)
    const [grant] = await db.select().from(mcpGrants).where(eq(mcpGrants.userId, c.user.id))
    expect(grant?.revokedAt).toBeNull()
    // The sealed successor is ciphertext, never the token itself.
    const sealed = await db
      .select()
      .from(mcpTokens)
      .where(eq(mcpTokens.grantId, grant?.id ?? ''))
    for (const row of sealed) {
      expect(row.successorSealed ?? '').not.toContain(first.refresh_token as string)
    }
  })

  it('reuse after the grace — or once the successor was used — revokes the connection', async () => {
    const c = await connected()
    const first = (await (await refresh(c.refreshToken)).json()) as Record<string, string>
    // The successor is used, so a replay of the original is no retry: it is theft.
    expect((await refresh(first.refresh_token as string)).status).toBe(200)
    const reuse = await refresh(c.refreshToken)
    expect(reuse.status).toBe(400)
    expect(((await reuse.json()) as { error: string }).error).toBe('invalid_grant')
    const [grant] = await db.select().from(mcpGrants).where(eq(mcpGrants.userId, c.user.id))
    expect(grant?.revokeReason).toBe('refresh_token_reused')
    // ...and every token of it is dead, on /mcp too.
    expect(
      (await mcpPost(env, '/mcp', LIST, { Authorization: `Bearer ${c.accessToken}` })).status
    ).toBe(401)
  })

  it('reuse after the grace window revokes too', async () => {
    const c = await connected()
    await refresh(c.refreshToken)
    await db
      .update(mcpTokens)
      .set({ usedAt: new Date(Date.now() - 60_000) })
      .where(eq(mcpTokens.kind, 'refresh'))
    const reuse = await refresh(c.refreshToken)
    expect(((await reuse.json()) as { error: string }).error).toBe('invalid_grant')
    const [grant] = await db.select().from(mcpGrants).where(eq(mcpGrants.userId, c.user.id))
    expect(grant?.revokedAt).not.toBeNull()
  })

  it('another client cannot use the refresh token', async () => {
    const c = await connected()
    const res = await refresh(c.refreshToken, LOOPBACK_CLIENT)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant')
  })

  it('an idle connection (30 days) and one past its absolute end (90 days) answer invalid_grant', async () => {
    for (const set of [
      { lastUsedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
      { expiresAt: new Date(Date.now() - 1000) },
    ]) {
      const c = await connected()
      await db.update(mcpGrants).set(set).where(eq(mcpGrants.userId, c.user.id))
      const res = await refresh(c.refreshToken)
      expect(((await res.json()) as { error: string }).error).toBe('invalid_grant')
    }
  })

  it('a grant made under IdP-managed tenancy ends with the IdP session cap', async () => {
    const { grantExpiry } = await import('@/api/services/mcp/authorization')
    const capped = loadConfig(
      mcpTestEnv({
        OIDC_ISSUER: 'https://idp.example.com',
        OIDC_CLIENT_ID: 'x',
        OIDC_MANAGED_TENANCY: 'true',
        OIDC_SESSION_MAX_AGE_DAYS: '7',
      })
    )
    const now = new Date()
    expect(grantExpiry(capped, now).getTime() - now.getTime()).toBe(7 * 24 * 60 * 60 * 1000)
    expect(grantExpiry(cfg, now).getTime() - now.getTime()).toBe(90 * 24 * 60 * 60 * 1000)
  })
})

describe('revoke (RFC 7009)', () => {
  it('a refresh token ends the connection; the access token stops on the next call', async () => {
    const { cookie, tenant } = await member()
    const c = await connectViaOAuth(env, cookie, { tenantId: tenant.id })
    const res = await revokePost(env, { token: c.refreshToken, client_id: c.clientId })
    expect(res.status).toBe(200)
    expect(
      (await mcpPost(env, '/mcp', LIST, { Authorization: `Bearer ${c.accessToken}` })).status
    ).toBe(401)
  })

  it('an unknown token, or another client’s, answers 200 and changes nothing', async () => {
    const { cookie, tenant, user } = await member()
    const c = await connectViaOAuth(env, cookie, { tenantId: tenant.id })
    expect((await revokePost(env, { token: 'mcprt_nope' })).status).toBe(200)
    expect(
      (await revokePost(env, { token: c.refreshToken, client_id: LOOPBACK_CLIENT })).status
    ).toBe(200)
    const [grant] = await db.select().from(mcpGrants).where(eq(mcpGrants.userId, user.id))
    expect(grant?.revokedAt).toBeNull()
  })
})

describe('end to end', () => {
  it('authorize → consent → token → tools/list → refresh → revoke → 401', async () => {
    const { cookie, tenant } = await member()
    const c = await connectViaOAuth(env, cookie, { tenantId: tenant.id })
    const client = await mcpClient(env, c.accessToken, { mode: 'auto' })
    const names = (await client.listTools()).tools.map(t => t.name)
    expect(names).toContain('search_knowledge')
    await client.close()
    const refreshed = (await (
      await tokenPost(env, {
        grant_type: 'refresh_token',
        refresh_token: c.refreshToken,
        client_id: c.clientId,
      })
    ).json()) as { access_token: string; refresh_token: string }
    expect(
      (await mcpPost(env, '/mcp', LIST, { Authorization: `Bearer ${refreshed.access_token}` }))
        .status
    ).toBe(200)
    await revokePost(env, { token: refreshed.refresh_token, client_id: c.clientId })
    expect(
      (await mcpPost(env, '/mcp', LIST, { Authorization: `Bearer ${refreshed.access_token}` }))
        .status
    ).toBe(401)
  })
})
