/**
 * The reference plugin's server behaviour (D31): the mount is dark until the flag is on, every
 * query is scoped to one organisation, ownership is the route's own check, the ping route enqueues
 * rather than doing the work, and the agent tool answers the run's tenant.
 *
 * It lives inside the plugin because it tests the plugin — the division of labour the kit settled
 * on is that **a plugin tests its behaviour and the host tests that it is a well-formed plugin**
 * (`tests/config/plugins.test.ts`). `vitest.config.ts` discovers this directory, so it runs in the
 * host's `api` project against the host's real Postgres, exactly like a kit test.
 *
 * **It reaches the harness through `@testkit`, which is a DECLARED entry.** Before that existed
 * these were six-level relative climbs into `apps/web/tests/**` — five modules and twenty-one
 * symbols nobody had promised to keep — so a plugin's tests were the one part of it still pinned to
 * kit internals. They are in scope for the import rule now, like the rest of the plugin.
 *
 * **The tenant-isolation case below drives the REAL mount through `request(...)` as a second
 * tenant**, and that is deliberate rather than incidental. A context builder from `@testkit/unit`
 * can prove a branch; only the real mount can prove a predicate, which is why the builders refuse a
 * fake `db` at all — a stub returning `[]` passes "tenant B sees no rows" whatever the query said.
 *
 * **The flag is turned on with a per-tenant OVERRIDE, never with the platform row.**
 * `feature_flags.state` is one row for the whole deployment: setting it to `on` here turns
 * `example-feature` on for EVERY tenant in the test database, including the seeded one that
 * `tests/api/auth-session.test.ts` asserts has `features: []` — and the `api` project runs files in
 * parallel workers, so that shows up as a failure in the OTHER file, only on some orders. An
 * override is scoped to one organisation and beats the platform state in both directions, so this
 * file can be as loud as it likes without being visible to anybody else.
 *
 * The platform row still has to EXIST, because `tenant_feature_overrides.flag_key` is a foreign key
 * to it — but it is written `off`, which evaluates identically to no row at all for every tenant
 * that has no override. That is the whole of this file's global footprint.
 */
import { EXAMPLE_FEATURE_FLAG } from '@rocketflare/shared/plugins/example-feature/index'
import {
  createTestEnv,
  createTestSession,
  createTestTenant,
  createTestUser,
  json,
  linkUserToTenant,
  request,
  sessionCookieHeader,
  setupTestDatabase,
  stubs,
} from '@testkit/integration'
import { makeCronCtx, makeJobCtx, makeToolCtx } from '@testkit/unit'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { allTables } from '@/plugins/api/peers'
import { exampleNotes } from '../../db/schema'
import { listExampleNotesTool } from '../../tools/list-example-notes'

const db = setupTestDatabase()

const BASE = '/api/example-feature'

let tenantId: string
let otherTenantId: string
let ownerCookie: Record<string, string>
let memberCookie: Record<string, string>
let otherCookie: Record<string, string>
let memberId: string

/**
 * The whole mount is gated, so the flag has to be on for anything below to be reachable at all —
 * and it is turned on for THIS FILE'S OWN organisations only, through an override. The platform
 * row exists solely to satisfy the override's foreign key and stays `off`.
 *
 * `feature_flags` is the KIT's table, so it is reached through `allTables()` — the declared way to
 * name the merged schema — and CALLED rather than read at module scope, because that module reads
 * the plugin barrel and a module-scope call closes the cycle with one side still `undefined`.
 */
async function setFlagFor(tenant: string, enabled: boolean) {
  const { featureFlags, tenantFeatureOverrides } = allTables()
  await db
    .insert(featureFlags)
    .values({ key: EXAMPLE_FEATURE_FLAG, state: 'off' })
    .onConflictDoNothing()
  await db
    .insert(tenantFeatureOverrides)
    .values({ tenantId: tenant, flagKey: EXAMPLE_FEATURE_FLAG, enabled })
    .onConflictDoUpdate({
      target: [tenantFeatureOverrides.tenantId, tenantFeatureOverrides.flagKey],
      set: { enabled },
    })
}

async function createNote(headers: Record<string, string>, title: string) {
  const res = await request(`${BASE}/notes`, { method: 'POST', headers }, { json: { title } })
  expect(res.status).toBe(201)
  return json<{ id: string; ownerUserId: string | null; title: string }>(res)
}

beforeAll(async () => {
  const tenant = await createTestTenant(db)
  tenantId = tenant.id
  otherTenantId = (await createTestTenant(db)).id

  const owner = await createTestUser(db)
  await linkUserToTenant(db, owner.id, tenantId, 'owner')
  ownerCookie = sessionCookieHeader(await createTestSession(db, owner.id, tenantId))

  const member = await createTestUser(db)
  memberId = member.id
  await linkUserToTenant(db, member.id, tenantId, 'member')
  memberCookie = sessionCookieHeader(await createTestSession(db, member.id, tenantId))

  const outsider = await createTestUser(db)
  await linkUserToTenant(db, outsider.id, otherTenantId, 'owner')
  otherCookie = sessionCookieHeader(await createTestSession(db, outsider.id, otherTenantId))

  // Both of this file's organisations: the isolation case below drives the mount as tenant B, so
  // B needs the surface to EXIST for it in order to prove it cannot see A's rows through it.
  await setFlagFor(tenantId, true)
  await setFlagFor(otherTenantId, true)
})

/** Leave the database as we found it — our two override rows go, the `off` platform row stays. */
afterAll(async () => {
  const { tenantFeatureOverrides } = allTables()
  await db
    .delete(tenantFeatureOverrides)
    .where(
      and(
        eq(tenantFeatureOverrides.flagKey, EXAMPLE_FEATURE_FLAG),
        inArray(tenantFeatureOverrides.tenantId, [tenantId, otherTenantId])
      )
    )
})

describe('the feature gate', () => {
  it('is a 401 without a credential, whatever the flag says', async () => {
    const res = await request(`${BASE}/notes`)
    expect(res.status).toBe(401)
    expect(await json<{ error: string; statusCode: number }>(res)).toMatchObject({
      statusCode: 401,
    })
  })

  it('hides the whole mount as a 404 — never a 403, which would confirm it exists', async () => {
    // The same override, flipped to `false`: an override beats the platform state in BOTH
    // directions, so this is the dark case without touching one byte of global state.
    await setFlagFor(tenantId, false)
    try {
      const res = await request(`${BASE}/notes`, { headers: ownerCookie })
      expect(res.status).toBe(404)
      expect(await json<{ code?: string }>(res)).toMatchObject({ code: 'feature_disabled' })
    } finally {
      await setFlagFor(tenantId, true)
    }
  })
})

describe('notes CRUD', () => {
  it('creates, reads, lists, patches and deletes its own row', async () => {
    const note = await createNote(memberCookie, 'Written by a member')
    expect(note.ownerUserId).toBe(memberId)

    const read = await request(`${BASE}/notes/${note.id}`, { headers: memberCookie })
    expect(read.status).toBe(200)

    const list = await request(`${BASE}/notes`, { headers: memberCookie })
    const body = await json<{ items: { id: string }[]; pagination: { total: number } }>(list)
    expect(body.items.map(n => n.id)).toContain(note.id)
    expect(body.pagination.total).toBeGreaterThan(0)

    const patched = await request(
      `${BASE}/notes/${note.id}`,
      { method: 'PATCH', headers: memberCookie },
      { json: { body: 'and edited by them' } }
    )
    expect(patched.status).toBe(200)
    expect(await json<{ body: string }>(patched)).toMatchObject({ body: 'and edited by them' })

    const removed = await request(`${BASE}/notes/${note.id}`, {
      method: 'DELETE',
      headers: memberCookie,
    })
    expect(removed.status).toBe(204)
    expect(await request(`${BASE}/notes/${note.id}`, { headers: memberCookie })).toHaveProperty(
      'status',
      404
    )
  })

  it('rejects a body the contract refuses, with the shared envelope', async () => {
    const res = await request(
      `${BASE}/notes`,
      { method: 'POST', headers: memberCookie },
      { json: { title: '' } }
    )
    expect(res.status).toBe(400)
    expect(await json<{ error: string; statusCode: number }>(res)).toMatchObject({
      statusCode: 400,
    })
  })

  it('lets a member read but not edit somebody else’s note, and an admin do both', async () => {
    const note = await createNote(ownerCookie, 'Written by the owner')

    expect(await request(`${BASE}/notes/${note.id}`, { headers: memberCookie })).toHaveProperty(
      'status',
      200
    )
    const refused = await request(
      `${BASE}/notes/${note.id}`,
      { method: 'PATCH', headers: memberCookie },
      { json: { title: 'hijacked' } }
    )
    expect(refused.status).toBe(403)

    const allowed = await request(`${BASE}/notes/${note.id}`, {
      method: 'DELETE',
      headers: ownerCookie,
    })
    expect(allowed.status).toBe(204)
  })
})

describe('tenant isolation', () => {
  it('never lets one organisation see, read or delete another’s notes', async () => {
    const mine = await createNote(ownerCookie, 'Only ours')

    // The list is the tenant predicate at work: another organisation's page simply does not
    // contain the row.
    const theirs = await request(`${BASE}/notes`, { headers: otherCookie })
    const body = await json<{ items: { id: string }[] }>(theirs)
    expect(body.items.map(n => n.id)).not.toContain(mine.id)

    // …and naming the id directly is the SAME 404 as an id that does not exist, so the API is not
    // an existence oracle.
    expect(await request(`${BASE}/notes/${mine.id}`, { headers: otherCookie })).toHaveProperty(
      'status',
      404
    )
    const deleted = await request(`${BASE}/notes/${mine.id}`, {
      method: 'DELETE',
      headers: otherCookie,
    })
    expect(deleted.status).toBe(404)

    // The row is still there — the 404 was a refusal, not a silent success.
    const [row] = await db
      .select()
      .from(exampleNotes)
      .where(and(eq(exampleNotes.tenantId, tenantId), eq(exampleNotes.id, mine.id)))
    expect(row).toBeDefined()
  })
})

describe('onTenantCreated', () => {
  it('gives a brand-new organisation its welcome note, and only it', async () => {
    const newcomer = await createTestUser(db)
    const cookie = {
      ...sessionCookieHeader(await createTestSession(db, newcomer.id, null)),
      Origin: 'http://localhost:3000',
    }
    const res = await request(
      '/api/tenants',
      { method: 'POST', headers: cookie },
      { json: { name: `Plugin Hook Org ${Date.now()}` } }
    )
    expect(res.status).toBe(201)
    const { id } = await json<{ id: string }>(res)
    const rows = await db.select().from(exampleNotes).where(eq(exampleNotes.tenantId, id))
    // Exactly one, and unowned — the hook runs post-commit with no person attached to it.
    expect(rows).toHaveLength(1)
    expect(rows[0]?.ownerUserId).toBeNull()
  })
})

describe('the ping route', () => {
  it('enqueues the plugin’s job and does not run it', async () => {
    const env = createTestEnv()
    const res = await request(`${BASE}/ping`, { method: 'POST', headers: memberCookie }, { env })
    expect(res.status).toBe(202)
    expect(await json<{ type: string }>(res)).toMatchObject({ type: 'example-feature.ping' })
    const [message] = stubs(env).queue.messages
    expect(message?.body).toMatchObject({
      type: 'example-feature.ping',
      payload: { tenantId },
    })
  })
})

describe('features(tenantId) off-request (D34)', () => {
  it('answers what the session would, for a tenant named per call, from a job and a cron', async () => {
    const dark = await createTestTenant(db)
    for (const ctx of [makeJobCtx({ db }), makeCronCtx({ db })]) {
      expect(await ctx.features(tenantId)).toContain(EXAMPLE_FEATURE_FLAG)
      expect(await ctx.features(dark.id)).not.toContain(EXAMPLE_FEATURE_FLAG)
    }
  })
})

describe('the public ping link (D34)', () => {
  async function mintLink(headers: Record<string, string>) {
    const res = await request(`${BASE}/ping-link`, { method: 'POST', headers })
    expect(res.status).toBe(200)
    const { url } = await json<{ url: string }>(res)
    return new URL(url)
  }

  it('is answered with NO credential, and pings the tenant the link was minted for', async () => {
    const link = await mintLink(memberCookie)
    expect(link.pathname).toBe('/api/hooks/example-feature/ping')
    const env = createTestEnv()
    const res = await request(`${link.pathname}${link.search}`, {}, { env })
    expect(res.status).toBe(202)
    const [message] = stubs(env).queue.messages
    expect(message?.body).toMatchObject({ type: 'example-feature.ping', payload: { tenantId } })
  })

  it('refuses a tampered, foreign or missing state with the same 401', async () => {
    const link = await mintLink(memberCookie)
    const state = link.searchParams.get('state') ?? ''
    const [body = '', sig = ''] = state.split('.')
    const flipped = `${body.slice(0, -2)}${body.endsWith('A') ? 'B' : 'A'}${body.slice(-1)}.${sig}`
    for (const bad of [flipped, `${body}.${sig.slice(1)}`, 'not-a-token', '']) {
      const res = await request(`/api/hooks/example-feature/ping?state=${encodeURIComponent(bad)}`)
      expect(res.status, bad).toBe(401)
    }
  })

  it('goes dark with the flag, although no gate middleware can run without a session', async () => {
    const link = await mintLink(memberCookie)
    await setFlagFor(tenantId, false)
    try {
      const res = await request(`${link.pathname}${link.search}`)
      expect(res.status).toBe(404)
      expect(await json<{ code: string }>(res)).toMatchObject({ code: 'feature_disabled' })
    } finally {
      await setFlagFor(tenantId, true)
    }
  })

  it('is not reachable at an unauthenticated path the plugin did not declare', async () => {
    const res = await request('/api/hooks/example-feature/nope')
    expect(res.status).toBe(404)
  })
})

describe('list_example_notes', () => {
  it('answers the run’s own tenant, and says so when there is nothing to read', async () => {
    const note = await createNote(ownerCookie, 'Depot handover')
    const tool = listExampleNotesTool(makeToolCtx({ db, tenantId }))
    const answer = JSON.parse((await tool.handler?.({})) ?? '{}') as {
      total: number
      notes: { noteId: string; title: string }[]
      hint?: string
    }
    expect(answer.notes.map(n => n.noteId)).toContain(note.id)

    const emptyTenant = await createTestTenant(db)
    const empty = JSON.parse(
      (await listExampleNotesTool(makeToolCtx({ db, tenantId: emptyTenant.id })).handler?.({})) ??
        '{}'
    ) as { total: number; hint?: string }
    expect(empty.total).toBe(0)
    expect(empty.hint).toMatch(/No example notes/)
  })
})
