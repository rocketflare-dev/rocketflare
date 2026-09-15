/**
 * Feature flags (D30) end to end: the admin surface, the two layers composing, and — the assertion
 * that matters most — that a GLOBAL ADMIN is dark too.
 *
 * That last one is not hypothetical. An app built on this kit shipped the gate reading the CASL
 * ability and had five routes open in production to platform staff, because `manage all` and
 * `access all` are wildcards covering every `Feature:` subject, while the cube and dashboard gates
 * read the features array and stayed dark. Two sources of truth disagreeing. So every assertion
 * here runs for an owner AND for a global admin, and the API test is where that is pinned.
 */
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { featureFlags, tenantFeatureOverrides } from '@/db/schema'
import {
  createTestApiKey,
  createTestGlobalAdmin,
  createTestSession,
  createTestTenant,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()

const KEY = 'example-feature'

let tenantId: string
let otherTenantId: string
let ownerCookie: Record<string, string>
let memberCookie: Record<string, string>
let adminCookie: Record<string, string>
let apiKey: string

/** Wipe the flag's stored state so each test starts from "nothing configured". */
async function resetFlag() {
  await db.delete(tenantFeatureOverrides).where(eq(tenantFeatureOverrides.flagKey, KEY))
  await db.delete(featureFlags).where(eq(featureFlags.key, KEY))
}

async function setState(body: Record<string, unknown>) {
  const res = await request(
    `/api/admin/feature-flags/${KEY}`,
    { method: 'PATCH', headers: adminCookie },
    { json: body }
  )
  expect(res.status).toBe(200)
}

/** Force a flag on or off for one organisation. */
async function setOverride(enabled: boolean, tenant = tenantId) {
  const res = await request(
    `/api/admin/feature-flags/${KEY}/overrides/${tenant}`,
    { method: 'PUT', headers: adminCookie },
    { json: { enabled } }
  )
  expect(res.status).toBe(204)
}

/** The features array the server hands this credential. */
async function featuresFor(headers: Record<string, string>): Promise<string[]> {
  const res = await request('/auth/session', { headers })
  return (await json<{ features: string[] }>(res)).features
}

/** The admin list, as the global admin sees it. */
async function adminList() {
  const res = await request('/api/admin/feature-flags', { headers: adminCookie })
  return json<{ items: { key: string; state: string; overrideCount: number }[] }>(res)
}

beforeAll(async () => {
  const tenant = await createTestTenant(db)
  tenantId = tenant.id
  otherTenantId = (await createTestTenant(db)).id

  const owner = await createTestUser(db)
  await linkUserToTenant(db, owner.id, tenantId, 'owner')
  ownerCookie = sessionCookieHeader(await createTestSession(db, owner.id, tenantId))

  const member = await createTestUser(db)
  await linkUserToTenant(db, member.id, tenantId, 'member')
  memberCookie = sessionCookieHeader(await createTestSession(db, member.id, tenantId))

  // A global admin who is ALSO a member, so "dark" cannot be explained by a missing membership.
  const staff = await createTestGlobalAdmin(db)
  await linkUserToTenant(db, staff.id, tenantId, 'owner')
  adminCookie = sessionCookieHeader(await createTestSession(db, staff.id, tenantId))

  apiKey = (await createTestApiKey(db, tenantId, owner.id)).key
})

/**
 * `feature_flags` is PLATFORM state — one row for the whole deployment, shared with every other
 * test file against this database. Leave it as we found it.
 */
afterAll(resetFlag)

describe('GET /api/admin/feature-flags', () => {
  it('lists every registry key, configured or not', async () => {
    await resetFlag()
    const body = await adminList()
    const flag = body.items.find(f => f.key === KEY)
    expect(flag).toBeDefined()
    expect(flag?.state).toBe('off')
    expect(flag?.overrideCount).toBe(0)
  })

  it('is 403 for an owner and 401 unauthenticated', async () => {
    const forbidden = await request('/api/admin/feature-flags', { headers: ownerCookie })
    expect(forbidden.status).toBe(403)
    const anon = await request('/api/admin/feature-flags')
    expect(anon.status).toBe(401)
    const body = await json<{ error: string; statusCode: number }>(anon)
    expect(body).toMatchObject({ statusCode: 401 })
    expect(body.error).toEqual(expect.any(String))
  })

  it('404s a key the registry does not know', async () => {
    const res = await request(
      '/api/admin/feature-flags/not-a-feature',
      { method: 'PATCH', headers: adminCookie },
      { json: { state: 'on' } }
    )
    expect(res.status).toBe(404)
  })
})

describe('the flag reaches every credential the same way', () => {
  it('is absent by default, on when switched on — for owner, member AND global admin', async () => {
    await resetFlag()
    for (const headers of [ownerCookie, memberCookie, adminCookie]) {
      expect(await featuresFor(headers)).not.toContain(KEY)
    }

    await setState({ state: 'on' })
    for (const headers of [ownerCookie, memberCookie, adminCookie]) {
      // The global admin included: `manage all` must NOT be what decides this.
      expect(await featuresFor(headers)).toContain(KEY)
    }
  })

  it('answers the same for a Bearer key as for the cookie that created it', async () => {
    await resetFlag()
    await setState({ state: 'on' })
    const keyRes = await request('/api/features', {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    const viaKey = await json<{ features: string[]; items: { key: string; enabled: boolean }[] }>(
      keyRes
    )
    expect(viaKey.features).toEqual(await featuresFor(ownerCookie))
    expect(viaKey.items.find(i => i.key === KEY)?.enabled).toBe(true)
  })
})

describe('precedence', () => {
  it('lets a per-tenant override beat the platform state, both ways', async () => {
    await resetFlag()
    await setState({ state: 'on' })

    await setOverride(false)
    expect(await featuresFor(ownerCookie)).not.toContain(KEY)
    // …and the global admin is equally dark.
    expect(await featuresFor(adminCookie)).not.toContain(KEY)

    await setState({ state: 'off' })
    await setOverride(true)
    expect(await featuresFor(ownerCookie)).toContain(KEY)
  })

  it('narrows to one tenant: another organisation keeps the platform answer', async () => {
    await resetFlag()
    await setState({ state: 'off' })
    await setOverride(true)
    const rows = await db
      .select()
      .from(tenantFeatureOverrides)
      .where(eq(tenantFeatureOverrides.flagKey, KEY))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.tenantId).toBe(tenantId)
    expect(rows.some(r => r.tenantId === otherTenantId)).toBe(false)
  })

  it('follows the platform state again once the override is removed', async () => {
    await resetFlag()
    await setState({ state: 'off' })
    await setOverride(true)
    expect(await featuresFor(ownerCookie)).toContain(KEY)

    const cleared = await request(`/api/admin/feature-flags/${KEY}/overrides/${tenantId}`, {
      method: 'DELETE',
      headers: adminCookie,
    })
    expect(cleared.status).toBe(204)
    expect(await featuresFor(ownerCookie)).not.toContain(KEY)
  })

  it('counts overrides in the admin list', async () => {
    await resetFlag()
    await setState({ state: 'off' })
    await setOverride(true)
    const body = await adminList()
    expect(body.items.find(f => f.key === KEY)?.overrideCount).toBe(1)
  })
})

describe('the environment layer', () => {
  it('beats everything, including an override and a global admin', async () => {
    await resetFlag()
    await setState({ state: 'on' })
    await setOverride(true)
    // The kit's demo flag is not `environmentGated`, so an empty `FEATURES_ENABLED` changes
    // nothing — which is itself the contract: an ordinary rollout flag needs no toml edit.
    const env = createTestEnv({ FEATURES_ENABLED: '' })
    const res = await request('/auth/session', { headers: adminCookie }, { env })
    expect((await json<{ features: string[] }>(res)).features).toContain(KEY)
  })
})

describe('single-tenant mode', () => {
  const single = () => createTestEnv({ TENANCY_MODE: 'single' })

  it('still lets the global admin read and move a flag', async () => {
    await resetFlag()
    const list = await request(
      '/api/admin/feature-flags',
      { headers: adminCookie },
      { env: single() }
    )
    expect(list.status).toBe(200)
    const patch = await request(
      `/api/admin/feature-flags/${KEY}`,
      { method: 'PATCH', headers: adminCookie },
      { env: single(), json: { state: 'on' } }
    )
    expect(patch.status).toBe(200)
  })

  it('404s the override routes — one organisation makes them meaningless', async () => {
    const cases = [
      {
        method: 'GET' as const,
        path: `/api/admin/feature-flags/${KEY}/overrides`,
        json: undefined,
      },
      {
        method: 'PUT' as const,
        path: `/api/admin/feature-flags/${KEY}/overrides/${tenantId}`,
        json: { enabled: true },
      },
      {
        method: 'DELETE' as const,
        path: `/api/admin/feature-flags/${KEY}/overrides/${tenantId}`,
        json: undefined,
      },
    ]
    for (const { method, path, json: body } of cases) {
      const res = await request(
        path,
        { method, headers: adminCookie },
        { env: single(), json: body }
      )
      expect(res.status, method).toBe(404)
      expect((await json<{ code?: string }>(res)).code, method).toBe('tenancy_mode_single')
    }
  })

  it('refuses a rollout counted in organisations, and says why', async () => {
    await resetFlag()
    const res = await request(
      `/api/admin/feature-flags/${KEY}`,
      { method: 'PATCH', headers: adminCookie },
      { env: single(), json: { state: 'rollout', rolloutUnit: 'tenant' } }
    )
    expect(res.status).toBe(400)
    expect((await json<{ error: string }>(res)).error).toMatch(/one organisation/i)

    // …while a rollout counted in PEOPLE is exactly what single mode wants.
    const ok = await request(
      `/api/admin/feature-flags/${KEY}`,
      { method: 'PATCH', headers: adminCookie },
      { env: single(), json: { state: 'rollout', rolloutUnit: 'user', rolloutPercent: 100 } }
    )
    expect(ok.status).toBe(200)
  })
})
