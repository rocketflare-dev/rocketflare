/**
 * `/api/analytics` (D19): template pages appear lazily on first list (and on tenant creation),
 * CRUD is admin+, reset restores a template page, template pages cannot be deleted, cross-tenant
 * reads are 404, and fact-table status is admin+.
 */
import { analyticsPageListResponseSchema, analyticsPageSchema } from '@gmgo/shared/analytics'
import { ERROR_CODES } from '@gmgo/shared/errors'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { analyticsPages } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'

const db = setupTestDatabase()
const ORIGIN = { Origin: 'http://localhost:3001' }

async function owner() {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  const cookie = {
    ...sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
    ...ORIGIN,
  }
  return { user, tenant, cookie }
}

async function listPages(cookie: Record<string, string>) {
  const res = await request('/api/analytics/pages', { headers: cookie })
  expect(res.status).toBe(200)
  return analyticsPageListResponseSchema.parse(await json(res)).items
}

describe('GET /api/analytics/pages', () => {
  it('creates the template pages lazily on first list, once', async () => {
    const o = await owner()
    // Fixtures insert tenants directly (no createTenantForUser hook), so the tenant starts empty.
    expect(
      await db.select().from(analyticsPages).where(eq(analyticsPages.tenantId, o.tenant.id))
    ).toHaveLength(0)
    const first = await listPages(o.cookie)
    expect(first.map(p => p.slug)).toEqual(['tenant-overview'])
    expect(first[0]).toMatchObject({
      templateKey: 'tenant-overview',
      isDefault: true,
      name: 'Organisation Overview',
      tenantId: o.tenant.id,
    })
    expect(first[0]?.config.portlets.length).toBeGreaterThan(0)
    const second = await listPages(o.cookie)
    expect(second).toHaveLength(1)
  })

  it('members can list and read; unauthenticated → 401', async () => {
    const o = await owner()
    const member = await createTestUser(db)
    await linkUserToTenant(db, member.id, o.tenant.id, 'member')
    const cookie = sessionCookieHeader(await createTestSession(db, member.id, o.tenant.id))
    const pages = await listPages(cookie)
    const res = await request(`/api/analytics/pages/${pages[0]?.id}`, { headers: cookie })
    expect(res.status).toBe(200)
    expect(analyticsPageSchema.parse(await json(res)).slug).toBe('tenant-overview')
    expect((await request('/api/analytics/pages')).status).toBe(401)
  })
})

describe('tenant creation seeds dashboards', () => {
  it('POST /api/tenants → the new organisation already has its template pages', async () => {
    const user = await createTestUser(db)
    const cookie = { ...sessionCookieHeader(await createTestSession(db, user.id, null)), ...ORIGIN }
    const res = await request(
      '/api/tenants',
      { method: 'POST', headers: cookie },
      { json: { name: `Dash Org ${Date.now()}` } }
    )
    expect(res.status).toBe(201)
    const { id } = await json<{ id: string }>(res)
    const rows = await db.select().from(analyticsPages).where(eq(analyticsPages.tenantId, id))
    expect(rows.map(r => r.templateKey)).toEqual(['tenant-overview'])
    expect(rows[0]?.createdByUserId).toBe(user.id)
  })
})

describe('CRUD (manage Dashboard)', () => {
  it('owner creates, reads, updates and deletes a user page; slugs are unique per tenant', async () => {
    const o = await owner()
    const create = (name: string) =>
      request('/api/analytics/pages', { method: 'POST', headers: o.cookie }, { json: { name } })
    const res = await create('My Dash')
    expect(res.status).toBe(201)
    const page = analyticsPageSchema.parse(await json(res))
    expect(page).toMatchObject({ slug: 'my-dash', templateKey: null, createdBy: o.user.id })
    expect(page.config).toEqual({ layoutMode: 'rows', rows: [], portlets: [] })
    const dup = analyticsPageSchema.parse(await json(await create('My Dash')))
    expect(dup.slug).toBe('my-dash-2')

    const patched = await request(
      `/api/analytics/pages/${page.id}`,
      { method: 'PATCH', headers: o.cookie },
      {
        json: { name: 'Renamed', order: 5, config: { layoutMode: 'rows', rows: [], portlets: [] } },
      }
    )
    expect(patched.status).toBe(200)
    expect(analyticsPageSchema.parse(await json(patched))).toMatchObject({
      name: 'Renamed',
      order: 5,
    })
    const empty = await request(
      `/api/analytics/pages/${page.id}`,
      { method: 'PATCH', headers: o.cookie },
      { json: {} }
    )
    expect(empty.status).toBe(400)
    expect(await json(empty)).toMatchObject({ code: ERROR_CODES.validationFailed })

    const del = await request(`/api/analytics/pages/${page.id}`, {
      method: 'DELETE',
      headers: o.cookie,
    })
    expect(del.status).toBe(204)
    expect((await request(`/api/analytics/pages/${page.id}`, { headers: o.cookie })).status).toBe(
      404
    )
    // The activity log saw it.
    const activity = await json<{ items: Array<{ type: string }> }>(
      await request('/api/activity?subjectType=Dashboard', { headers: o.cookie })
    )
    expect(activity.items.map(a => a.type).sort()).toEqual([
      'dashboard.created',
      'dashboard.created',
      'dashboard.deleted',
      'dashboard.updated',
    ])
  })

  it('template pages: reset restores the template; delete is refused', async () => {
    const o = await owner()
    const [tpl] = await listPages(o.cookie)
    if (!tpl) throw new Error('no template page')
    await request(
      `/api/analytics/pages/${tpl.id}`,
      { method: 'PATCH', headers: o.cookie },
      { json: { name: 'Scribbled', config: { portlets: [] } } }
    )
    const reset = await request(`/api/analytics/pages/${tpl.id}/reset`, {
      method: 'POST',
      headers: o.cookie,
    })
    expect(reset.status).toBe(200)
    const restored = analyticsPageSchema.parse(await json(reset))
    expect(restored.name).toBe('Organisation Overview')
    expect(restored.config.portlets.length).toBeGreaterThan(0)

    const del = await request(`/api/analytics/pages/${tpl.id}`, {
      method: 'DELETE',
      headers: o.cookie,
    })
    expect(del.status).toBe(403)
    expect(await json(del)).toMatchObject({ statusCode: 403, code: 'template_page' })

    // A user page cannot be "reset".
    const created = analyticsPageSchema.parse(
      await json(
        await request(
          '/api/analytics/pages',
          { method: 'POST', headers: o.cookie },
          { json: { name: 'Mine' } }
        )
      )
    )
    const bad = await request(`/api/analytics/pages/${created.id}/reset`, {
      method: 'POST',
      headers: o.cookie,
    })
    expect(bad.status).toBe(400)
    expect(await json(bad)).toMatchObject({ code: 'not_a_template_page' })
  })

  it('member → 403 on every write; another tenant → 404', async () => {
    const o = await owner()
    const [tpl] = await listPages(o.cookie)
    const member = await createTestUser(db)
    await linkUserToTenant(db, member.id, o.tenant.id, 'member')
    const cookie = {
      ...sessionCookieHeader(await createTestSession(db, member.id, o.tenant.id)),
      ...ORIGIN,
    }
    for (const [method, path, body] of [
      ['POST', '/api/analytics/pages', { name: 'x' }],
      ['PATCH', `/api/analytics/pages/${tpl?.id}`, { name: 'x' }],
      ['DELETE', `/api/analytics/pages/${tpl?.id}`, undefined],
      ['POST', `/api/analytics/pages/${tpl?.id}/reset`, undefined],
      ['POST', '/api/analytics/templates/recreate', undefined],
    ] as const) {
      const res = await request(path, { method, headers: cookie }, { json: body })
      expect(res.status, `${method} ${path}`).toBe(403)
      expect(await json(res)).toMatchObject({ statusCode: 403, code: ERROR_CODES.forbidden })
    }
    const other = await owner()
    const cross = await request(`/api/analytics/pages/${tpl?.id}`, { headers: other.cookie })
    expect(cross.status).toBe(404)
    const crossPatch = await request(
      `/api/analytics/pages/${tpl?.id}`,
      { method: 'PATCH', headers: other.cookie },
      { json: { name: 'hijack' } }
    )
    expect(crossPatch.status).toBe(404)
    expect((await request('/api/analytics/pages/not-a-uuid', { headers: o.cookie })).status).toBe(
      404
    )
  })
})

describe('templates and fact status', () => {
  it('GET /templates lists the registry; POST /templates/recreate repairs', async () => {
    const o = await owner()
    const res = await request('/api/analytics/templates', { headers: o.cookie })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({
      items: [
        {
          key: 'tenant-overview',
          name: 'Organisation Overview',
          description: expect.any(String),
        },
      ],
    })
    // Nothing listed yet → recreate creates; second call resets.
    const first = await request('/api/analytics/templates/recreate', {
      method: 'POST',
      headers: o.cookie,
    })
    expect(await json(first)).toEqual({ created: 1, reset: 0 })
    const second = await request('/api/analytics/templates/recreate', {
      method: 'POST',
      headers: o.cookie,
    })
    expect(await json(second)).toEqual({ created: 0, reset: 1 })
  })

  it('GET /facts/status is admin+ and reports every fact table', async () => {
    const o = await owner()
    const res = await request('/api/analytics/facts/status', { headers: o.cookie })
    expect(res.status).toBe(200)
    const body = await json<{ items: Array<{ table: string; stale: boolean }> }>(res)
    expect(body.items.map(i => i.table)).toEqual(['tenant_activity_daily_facts'])
    expect(typeof body.items[0]?.stale).toBe('boolean')
    const member = await createTestUser(db)
    await linkUserToTenant(db, member.id, o.tenant.id, 'member')
    const denied = await request('/api/analytics/facts/status', {
      headers: sessionCookieHeader(await createTestSession(db, member.id, o.tenant.id)),
    })
    expect(denied.status).toBe(403)
  })
})
