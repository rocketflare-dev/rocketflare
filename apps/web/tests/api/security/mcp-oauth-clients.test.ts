/**
 * The authorization server's client cache and its inputs: a client metadata document that cannot
 * be used is reported in one sentence whatever the cause; a document that does not register the
 * request's redirect URI is never cached; the nightly sweep drops a stale cache row nobody refers
 * to; and a `resource` that does not decode is `invalid_target`, not a server error.
 */
import { eq, inArray, like } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  CIMD_UNUSABLE,
  OAuthClientError,
  REDIRECT_NOT_REGISTERED,
  resolveOAuthClient,
} from '@/api/services/mcp/cimd'
import { runPruneMcp } from '@/api/services/mcp/retention'
import { loadConfig } from '@/config'
import { oauthClients, oauthRequests } from '@/db/schema'
import { createTestTenant, createTestUser, linkUserToTenant } from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { connectMcp, mcpTestEnv } from '../../helpers/mcp'
import {
  authorizePath,
  browserGet,
  CLAUDE_LIKE_REDIRECT,
  seedOAuthClient,
  validAuthorize,
} from '../../helpers/oauth'

const db = setupTestDatabase()
const env = mcpTestEnv()
const ORIGIN = new URL(loadConfig(env).APP_URL).origin
const DAY = 86_400_000

/** A client id of its own, so nothing another file caches is touched. */
const ownClientId = () => `https://c-${crypto.randomUUID()}.example.com/client.json`

const documentFor = (clientId: string, redirect = 'https://client.example.com/cb') =>
  new Response(
    JSON.stringify({ client_id: clientId, client_name: 'C', redirect_uris: [redirect] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )

async function refusalOf(fetcher: (url: string) => Promise<Response>) {
  const err = await resolveOAuthClient(db, ownClientId(), { fetcher }).catch(e => e)
  expect(err).toBeInstanceOf(OAuthClientError)
  return (err as OAuthClientError).description
}

describe('a client metadata document that cannot be used', () => {
  it('is described in the same sentence whatever went wrong', async () => {
    const descriptions = [
      await refusalOf(async () => {
        throw new TypeError('fetch failed')
      }),
      await refusalOf(async () => new Response('nope', { status: 404 })),
      await refusalOf(
        async () => new Response(null, { status: 302, headers: { Location: 'https://x.test/' } })
      ),
      await refusalOf(
        async () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } })
      ),
      await refusalOf(
        async () => new Response('{', { headers: { 'Content-Type': 'application/json' } })
      ),
      await refusalOf(async () => documentFor('https://someone-else.example.com/client.json')),
    ]
    expect(new Set(descriptions)).toEqual(new Set([CIMD_UNUSABLE]))
  })

  it('says so on the authorize page', async () => {
    // The api suites have no network: the fetch fails as an unreachable host would.
    const res = await browserGet(
      env,
      authorizePath(validAuthorize(env, { client_id: ownClientId() }))
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toContain(CIMD_UNUSABLE)
  })
})

describe('the client cache', () => {
  it('keeps no row for a document that does not register the redirect URI asked for', async () => {
    const clientId = ownClientId()
    const err = await resolveOAuthClient(db, clientId, {
      fetcher: async () => documentFor(clientId),
      forRedirect: { uri: 'https://elsewhere.example.com/cb' },
    }).catch(e => e)
    expect(err).toBeInstanceOf(OAuthClientError)
    expect((err as OAuthClientError).description).toBe(REDIRECT_NOT_REGISTERED)
    expect(
      await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId))
    ).toHaveLength(0)

    const ok = await resolveOAuthClient(db, clientId, {
      fetcher: async () => documentFor(clientId),
      forRedirect: { uri: 'https://client.example.com/cb' },
    })
    expect(ok.clientId).toBe(clientId)
  })

  it('drops a stale row nobody refers to, and keeps one a grant or a pending request names', async () => {
    // Every row is seeded fresh and its references made BEFORE any is backdated: other files
    // run the same nightly sweep against the shared database, and must never see a stale row
    // that this case means to be referenced.
    const prefix = `https://sweep-${crypto.randomUUID()}.example.com/`
    const unreferenced = await seedOAuthClient(db, { clientId: `${prefix}unreferenced.json` })
    const fresh = await seedOAuthClient(db, { clientId: `${prefix}fresh.json` })
    const granted = await seedOAuthClient(db, { clientId: `${prefix}granted.json` })
    const pending = await seedOAuthClient(db, { clientId: `${prefix}pending.json` })

    const tenant = await createTestTenant(db)
    const user = await createTestUser(db)
    await linkUserToTenant(db, user.id, tenant.id, 'owner')
    await connectMcp(db, env, { tenantId: tenant.id, userId: user.id, clientId: granted })
    await db.insert(oauthRequests).values({
      clientId: pending,
      redirectUri: CLAUDE_LIKE_REDIRECT,
      scopes: ['mcp:read'],
      resource: `${ORIGIN}/mcp`,
      codeChallenge: 'x'.repeat(43),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    })
    await db
      .update(oauthClients)
      .set({ fetchedAt: new Date(Date.now() - 31 * DAY) })
      .where(inArray(oauthClients.clientId, [unreferenced, granted, pending]))

    // The count is not asserted: a sweep from another file may take the row first.
    const result = await runPruneMcp(db, 90)
    expect(result.clients).toBeTypeOf('number')
    const left = await db
      .select({ clientId: oauthClients.clientId })
      .from(oauthClients)
      .where(like(oauthClients.clientId, `${prefix}%`))
    expect(left.map(r => r.clientId).sort()).toEqual([fresh, granted, pending].sort())
    expect(left.map(r => r.clientId)).not.toContain(unreferenced)
  })
})

describe('the resource parameter', () => {
  it('answers invalid_target for a pinned URL whose slug does not decode', async () => {
    await seedOAuthClient(db)
    const res = await browserGet(
      env,
      authorizePath(validAuthorize(env, { resource: `${ORIGIN}/mcp/t/%E0%A4%A` }))
    )
    expect(res.status).toBe(302)
    const url = new URL(res.headers.get('Location') ?? '')
    expect(url.searchParams.get('error')).toBe('invalid_target')
  })
})
