/**
 * Tenant lifecycle (D9, D10, D25): create (owner + selected), read/patch (admin+ name, owner-only
 * slug), delete with slug confirmation (owner), settings, `GET /api/tenants`, single-mode 404s.
 */
import { slugify } from '@rocketflare/shared/tenants'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { activityEvents, tenantSettings, tenants, tenantUsers } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
  uniqueId,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()

/**
 * A test slug must be SLUG-STABLE (`slugify(slug) === slug`), not merely valid: `uniqueId()` is
 * base64url, so it can carry `_` from a `/` alongside its own `_` separator, and naively swapping
 * both for `-` yields `--` — which `slugify` then collapses. A test that derives a slug from such a
 * name gets a DIFFERENT root, so it is free and never de-duplicated. That was a 1-in-60 flake.
 * Running the value through the real `slugify` is what makes it stable by construction.
 */
const testSlug = (prefix: string) => slugify(`${prefix}-${uniqueId()}`)

async function actor(role: 'owner' | 'admin' | 'member') {
  const slug = testSlug('t')
  const { user, tenant } = await createTestTenantWithUser(db, role, {}, { slug })
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

describe('POST /api/tenants', () => {
  it('creates the org with the caller as owner, settings row, activity, and selects it', async () => {
    const user = await createTestUser(db)
    const cookie = sessionCookieHeader(await createTestSession(db, user.id))
    const name = `New Org ${uniqueId()}`
    const res = await request(
      '/api/tenants',
      { method: 'POST', headers: cookie },
      { json: { name } }
    )
    expect(res.status).toBe(201)
    const body = await json<{ id: string; slug: string; name: string }>(res)
    expect(body.name).toBe(name)
    expect(body.slug).toMatch(/^new-org-/)
    const [m] = await db.select().from(tenantUsers).where(eq(tenantUsers.tenantId, body.id))
    expect(m).toMatchObject({ userId: user.id, role: 'owner' })
    expect(
      await db.select().from(tenantSettings).where(eq(tenantSettings.tenantId, body.id))
    ).toHaveLength(1)
    const events = await db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.tenantId, body.id))
    expect(events.map(e => e.type)).toContain('tenant.created')
    const session = await json<{ tenant: { id: string } }>(
      await request('/auth/session', { headers: cookie })
    )
    expect(session.tenant.id).toBe(body.id)
  })

  it('409 slug_taken for an explicit duplicate slug; derived slugs are de-duplicated', async () => {
    const a = await actor('owner')
    const res = await request(
      '/api/tenants',
      { method: 'POST', headers: a.cookie },
      { json: { name: 'X', slug: a.tenant.slug } }
    )
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ code: 'slug_taken' })
    const first = await json<{ slug: string }>(
      await request(
        '/api/tenants',
        { method: 'POST', headers: a.cookie },
        { json: { name: a.tenant.slug } }
      )
    )
    expect(first.slug).toBe(`${a.tenant.slug}-2`)
  })

  it('400 for a reserved slug', async () => {
    const a = await actor('owner')
    const res = await request(
      '/api/tenants',
      { method: 'POST', headers: a.cookie },
      { json: { name: 'Admin', slug: 'admin' } }
    )
    expect(res.status).toBe(400)
  })

  it('GET /api/tenants lists my summaries', async () => {
    const a = await actor('member')
    const { tenant: other } = await createTestTenantWithUser(db, 'owner')
    await linkUserToTenant(db, a.user.id, other.id, 'admin')
    const body = await json<Array<{ id: string; role: string }>>(
      await request('/api/tenants', { headers: a.cookie })
    )
    expect(body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: a.tenant.id, role: 'member' }),
        expect.objectContaining({ id: other.id, role: 'admin' }),
      ])
    )
  })
})

describe('GET/PATCH/DELETE /api/tenant', () => {
  it('GET returns tenantSchema for every role', async () => {
    const a = await actor('member')
    const res = await request('/api/tenant', { headers: a.cookie })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({
      id: a.tenant.id,
      slug: a.tenant.slug,
      status: 'active',
    })
  })

  it('PATCH name: admin ok, member 403; slug: owner only', async () => {
    const a = await actor('admin')
    const renamed = await request(
      '/api/tenant',
      { method: 'PATCH', headers: a.cookie },
      { json: { name: 'Renamed' } }
    )
    expect(renamed.status).toBe(200)
    expect((await json<{ name: string }>(renamed)).name).toBe('Renamed')
    const slug = await request(
      '/api/tenant',
      { method: 'PATCH', headers: a.cookie },
      { json: { slug: testSlug('s') } }
    )
    expect(slug.status).toBe(403)
    const m = await actor('member')
    expect(
      (
        await request(
          '/api/tenant',
          { method: 'PATCH', headers: m.cookie },
          { json: { name: 'Nope' } }
        )
      ).status
    ).toBe(403)
    const o = await actor('owner')
    const newSlug = testSlug('s')
    const ok = await request(
      '/api/tenant',
      { method: 'PATCH', headers: o.cookie },
      { json: { slug: newSlug } }
    )
    expect(ok.status).toBe(200)
    expect((await json<{ slug: string }>(ok)).slug).toBe(newSlug)
    const clash = await request(
      '/api/tenant',
      { method: 'PATCH', headers: o.cookie },
      { json: { slug: a.tenant.slug } }
    )
    expect(clash.status).toBe(409)
  })

  it('DELETE: owner with matching confirm → 204 and cascade; wrong confirm 400; admin 403', async () => {
    const a = await actor('admin')
    expect(
      (
        await request(
          '/api/tenant',
          { method: 'DELETE', headers: a.cookie },
          { json: { confirm: a.tenant.slug } }
        )
      ).status
    ).toBe(403)
    const o = await actor('owner')
    const bad = await request(
      '/api/tenant',
      { method: 'DELETE', headers: o.cookie },
      { json: { confirm: 'wrong' } }
    )
    expect(bad.status).toBe(400)
    expect(await json(bad)).toMatchObject({ code: 'confirmation_mismatch' })
    const ok = await request(
      '/api/tenant',
      { method: 'DELETE', headers: o.cookie },
      { json: { confirm: o.tenant.slug } }
    )
    expect(ok.status).toBe(204)
    expect(await db.select().from(tenants).where(eq(tenants.id, o.tenant.id))).toHaveLength(0)
    expect(
      await db.select().from(tenantUsers).where(eq(tenantUsers.tenantId, o.tenant.id))
    ).toHaveLength(0)
    // the session now has no tenant
    expect(
      (await json<{ tenant: unknown }>(await request('/auth/session', { headers: o.cookie })))
        .tenant
    ).toBeNull()
  })
})

describe('/api/tenant/settings', () => {
  it('GET creates defaults; PATCH shallow-merges (admin+), member 403', async () => {
    const o = await actor('owner')
    const first = await json<{ timezone: string; settings: Record<string, unknown> }>(
      await request('/api/tenant/settings', { headers: o.cookie })
    )
    expect(first).toMatchObject({ timezone: 'UTC', notificationsEnabled: true, settings: {} })
    const patched = await request(
      '/api/tenant/settings',
      { method: 'PATCH', headers: o.cookie },
      { json: { timezone: 'Europe/London', settings: { theme: 'dark' } } }
    )
    expect(patched.status).toBe(200)
    const again = await request(
      '/api/tenant/settings',
      { method: 'PATCH', headers: o.cookie },
      { json: { settings: { locale: 'en-GB' } } }
    )
    expect(await json(again)).toMatchObject({
      timezone: 'Europe/London',
      settings: { theme: 'dark', locale: 'en-GB' },
    })
    const member = await createTestUser(db)
    await linkUserToTenant(db, member.id, o.tenant.id, 'member')
    const mc = sessionCookieHeader(await createTestSession(db, member.id, o.tenant.id))
    expect((await request('/api/tenant/settings', { headers: mc })).status).toBe(200)
    expect(
      (
        await request(
          '/api/tenant/settings',
          { method: 'PATCH', headers: mc },
          { json: { timezone: 'UTC' } }
        )
      ).status
    ).toBe(403)
  })
})

describe('/api/me', () => {
  it('profile + preferences round trip', async () => {
    const o = await actor('owner')
    const me = await json<{ email: string; preferences: Record<string, unknown> }>(
      await request('/api/me', { headers: o.cookie })
    )
    expect(me.email).toBe(o.user.email)
    expect(me.preferences).toEqual({})
    const patched = await request(
      '/api/me',
      { method: 'PATCH', headers: o.cookie },
      { json: { name: 'Renamed Person' } }
    )
    expect((await json<{ name: string }>(patched)).name).toBe('Renamed Person')
    await request(
      '/api/me/preferences',
      { method: 'PATCH', headers: o.cookie },
      { json: { preferences: { sidebar: 'collapsed', a: 1 } } }
    )
    const merged = await request(
      '/api/me/preferences',
      { method: 'PATCH', headers: o.cookie },
      { json: { preferences: { a: null, b: 2 } } }
    )
    expect((await json<{ preferences: unknown }>(merged)).preferences).toEqual({
      sidebar: 'collapsed',
      b: 2,
    })
    expect(
      (await request('/api/me', { method: 'PATCH', headers: o.cookie }, { json: {} })).status
    ).toBe(400)
  })
})

describe('TENANCY_MODE=single', () => {
  const env = createTestEnv({ TENANCY_MODE: 'single' })
  it('POST /api/tenants and DELETE /api/tenant → 404 tenancy_mode_single; GET/PATCH still work', async () => {
    const o = await actor('owner')
    const create = await request(
      '/api/tenants',
      { method: 'POST', headers: o.cookie },
      { json: { name: 'x' }, env }
    )
    expect(create.status).toBe(404)
    expect(await json(create)).toMatchObject({ statusCode: 404, code: 'tenancy_mode_single' })
    const del = await request(
      '/api/tenant',
      { method: 'DELETE', headers: o.cookie },
      { json: { confirm: o.tenant.slug }, env }
    )
    expect(del.status).toBe(404)
    expect((await request('/api/tenant', { headers: o.cookie }, { env })).status).toBe(200)
    expect(
      (
        await request(
          '/api/tenant',
          { method: 'PATCH', headers: o.cookie },
          { json: { name: 'Workspace' }, env }
        )
      ).status
    ).toBe(200)
  })
})
