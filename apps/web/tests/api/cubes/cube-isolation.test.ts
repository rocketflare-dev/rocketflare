/**
 * Two-tenant cube isolation (D19, MANDATORY). Every cube in `allCubes` is queried through the real
 * `/cubejs-api/v1/load` as tenant A and as tenant B; each sees exactly its own rows. Also: `/meta`
 * lists every cube, unauthenticated → 401 envelope, `/mcp` is reachable only behind auth, and
 * every dashboard-template portlet query actually executes against Postgres.
 */
import { ERROR_CODES } from '@gmgo/shared/errors'
import { describe, expect, it } from 'vitest'
import { allCubes } from '@/api/cubes'
import { refreshFactTable } from '@/api/services/fact-tables'
import { listTemplates } from '@/dashboards'
import { activityEvents } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { json, request } from '../../helpers/request'

const db = setupTestDatabase()

/** Cube.js v1 load shape: `{ queryType, results: [{ query, data, annotation, … }] }`. */
interface LoadResponse {
  queryType: string
  results: Array<{ data: Array<Record<string, unknown>> }>
}
type Rows = Array<Record<string, unknown>>

async function seedTenant(events: Array<{ type: string; system?: boolean }>, extraMembers = 0) {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  const members = []
  for (let i = 0; i < extraMembers; i++) {
    const m = await createTestUser(db)
    await linkUserToTenant(db, m.id, tenant.id, 'member')
    members.push(m)
  }
  if (events.length > 0) {
    await db.insert(activityEvents).values(
      events.map(e => ({
        tenantId: tenant.id,
        userId: e.system ? null : user.id,
        type: e.type,
        subjectType: 'Test',
        subjectId: 'x',
      }))
    )
  }
  await refreshFactTable(db, 'tenant_activity_daily_facts', { tenantId: tenant.id })
  const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
  return { user, tenant, members, cookie }
}

async function load(cookie: Record<string, string>, query: unknown): Promise<Rows> {
  const res = await request(
    '/cubejs-api/v1/load',
    { method: 'POST', headers: { ...cookie, Origin: 'http://localhost:3001' } },
    { json: { query } }
  )
  expect(res.status, await res.clone().text()).toBe(200)
  const body = await json<LoadResponse>(res)
  const data = body.results[0]?.data
  if (!Array.isArray(data)) throw new Error(`unexpected load shape: ${JSON.stringify(body)}`)
  return data
}

// Expected per-tenant results for EVERY cube. A cube missing here fails the coverage assertion.
const A_EVENTS = [
  { type: 'member.invited' },
  { type: 'member.invited' },
  { type: 'api_key.created' },
  { type: 'cron.ran', system: true },
]
const B_EVENTS = [{ type: 'member.invited' }, { type: 'file.uploaded' }]

describe('cube isolation: two tenants', () => {
  it('every cube returns only the querying tenant’s rows, in both directions', async () => {
    const a = await seedTenant(A_EVENTS, 1) // owner + 1 member = 2 memberships
    const b = await seedTenant(B_EVENTS, 0) // owner only

    const cases: Record<string, { query: unknown; expect: (rows: Rows, side: 'a' | 'b') => void }> =
      {
        Users: {
          query: { measures: ['Users.count'], dimensions: ['Users.id', 'Users.email'] },
          expect: (rows, side) => {
            const ids = rows.map(r => r['Users.id']).sort()
            const mine = side === 'a' ? [a.user.id, ...a.members.map(m => m.id)] : [b.user.id]
            expect(ids).toEqual(mine.sort())
          },
        },
        TenantUsers: {
          query: {
            measures: ['TenantUsers.count', 'TenantUsers.ownerCount', 'TenantUsers.memberCount'],
          },
          expect: (rows, side) => {
            expect(rows).toHaveLength(1)
            expect(Number(rows[0]?.['TenantUsers.count'])).toBe(side === 'a' ? 2 : 1)
            expect(Number(rows[0]?.['TenantUsers.ownerCount'])).toBe(1)
            expect(Number(rows[0]?.['TenantUsers.memberCount'])).toBe(side === 'a' ? 1 : 0)
          },
        },
        ActivityEvents: {
          query: { measures: ['ActivityEvents.count'], dimensions: ['ActivityEvents.type'] },
          expect: (rows, side) => {
            const counts = Object.fromEntries(
              rows.map(r => [r['ActivityEvents.type'], Number(r['ActivityEvents.count'])])
            )
            expect(counts).toEqual(
              side === 'a'
                ? { 'member.invited': 2, 'api_key.created': 1, 'cron.ran': 1 }
                : { 'member.invited': 1, 'file.uploaded': 1 }
            )
          },
        },
        TenantActivityDaily: {
          query: {
            measures: ['TenantActivityDaily.eventCount', 'TenantActivityDaily.activeUsers'],
          },
          expect: (rows, side) => {
            expect(rows).toHaveLength(1)
            expect(Number(rows[0]?.['TenantActivityDaily.eventCount'])).toBe(side === 'a' ? 4 : 2)
            expect(Number(rows[0]?.['TenantActivityDaily.activeUsers'])).toBe(1)
          },
        },
      }

    // Coverage: a new cube must add a case here (and seed rows for its table).
    expect(Object.keys(cases).sort()).toEqual(allCubes.map(c => c.name).sort())

    for (const [cube, testCase] of Object.entries(cases)) {
      const forA = await load(a.cookie, testCase.query)
      testCase.expect(forA, 'a')
      const forB = await load(b.cookie, testCase.query)
      testCase.expect(forB, 'b')
      // Belt and braces: nothing of B's identity ever appears in A's result set.
      const serialised = JSON.stringify(forA)
      expect(serialised, `${cube}: tenant B leaked into tenant A`).not.toContain(b.user.id)
      expect(serialised).not.toContain(b.tenant.id)
    }
  })

  it('joins stay scoped: ActivityEvents → Users names only this tenant’s people', async () => {
    const a = await seedTenant([{ type: 'x.y' }])
    const b = await seedTenant([{ type: 'x.y' }])
    const rows = await load(a.cookie, {
      measures: ['ActivityEvents.count'],
      dimensions: ['Users.email'],
    })
    expect(rows.map(r => r['Users.email'])).toEqual([a.user.email])
    expect(JSON.stringify(rows)).not.toContain(b.user.email)
  })

  it('every dashboard-template portlet query executes for a tenant', async () => {
    const a = await seedTenant(A_EVENTS, 2)
    for (const template of listTemplates()) {
      for (const portlet of template.config.portlets) {
        const query = JSON.parse(portlet.query ?? '{}')
        const rows = await load(a.cookie, query)
        expect(Array.isArray(rows), `${template.key}/${portlet.id}`).toBe(true)
        // Every portlet has something to show for a tenant with members and activity.
        expect(rows.length, `${template.key}/${portlet.id} returned no rows`).toBeGreaterThan(0)
      }
    }
  })
})

describe('cube API surface', () => {
  it('GET /cubejs-api/v1/meta lists every registered cube', async () => {
    const a = await seedTenant([])
    const res = await request('/cubejs-api/v1/meta', { headers: a.cookie })
    expect(res.status).toBe(200)
    const meta = await json<{ cubes: Array<{ name: string }> }>(res)
    expect(meta.cubes.map(c => c.name).sort()).toEqual(allCubes.map(c => c.name).sort())
  })

  it('unauthenticated → 401 envelope on /cubejs-api and /mcp', async () => {
    for (const path of ['/cubejs-api/v1/meta', '/cubejs-api/v1/load', '/mcp']) {
      const res = await request(path, { method: path === '/mcp' ? 'POST' : 'GET' })
      expect(res.status, path).toBe(401)
      expect(await json(res)).toMatchObject({ statusCode: 401, code: ERROR_CODES.unauthorized })
    }
  })

  it('a session with no tenant → 403 no_tenant', async () => {
    const user = await createTestUser(db)
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, null))
    const res = await request('/cubejs-api/v1/meta', { headers: cookie })
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ code: ERROR_CODES.noTenant })
  })

  it('/mcp is reachable behind auth (JSON-RPC initialize)', async () => {
    const a = await seedTenant([])
    const res = await request(
      '/mcp',
      {
        method: 'POST',
        headers: { ...a.cookie, Accept: 'application/json, text/event-stream' },
      },
      {
        json: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'vitest', version: '0' },
          },
        },
      }
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('"jsonrpc":"2.0"')
  })
})
