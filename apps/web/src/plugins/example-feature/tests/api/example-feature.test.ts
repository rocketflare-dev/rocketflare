/**
 * The reference plugin's server behaviour (D31): the mount is dark until the flag is on, every
 * query is scoped to one organisation, ownership is the route's own check, the ping route enqueues
 * rather than doing the work, and the agent tool answers the run's tenant.
 *
 * It lives inside the plugin because it tests the plugin — the division of labour the kit settled
 * on in A1 is that **a plugin tests its behaviour and the host tests that it is a well-formed
 * plugin** (`tests/config/plugins.test.ts`). `vitest.config.ts` discovers this directory, so it
 * runs in the host's `api` project against the host's real Postgres, exactly like a kit test.
 *
 * This file is the one place `example-feature`'s PLATFORM flag row is written. `featureFlags.key`
 * is global state and `tenant_feature_overrides` cascades off it, so a second file resetting the
 * same key would delete this one's rows mid-run — which is why `tests/api/feature-flags.test.ts`
 * registers a fixture key of its own rather than borrowing this one.
 */
import { EXAMPLE_FEATURE_FLAG } from '@rocketflare/shared/plugins/example-feature/index'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '@/config'
import { featureFlags } from '@/db/schema'
import {
  createTestSession,
  createTestTenant,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../../../../../tests/helpers/auth'
import { setupTestDatabase } from '../../../../../tests/helpers/db'
import { json, request } from '../../../../../tests/helpers/request'
import { createTestEnv, stubs } from '../../../../../tests/mocks/bindings'
import { fullAccessScope } from '../../../../api/services/access'
import type { AgentToolContext } from '../../../../api/services/agents/tools'
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

/** The whole mount is gated, so the flag has to be on for anything below to be reachable at all. */
async function setFlag(state: 'on' | 'off') {
  await db
    .insert(featureFlags)
    .values({ key: EXAMPLE_FEATURE_FLAG, state })
    .onConflictDoUpdate({ target: featureFlags.key, set: { state } })
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

  await setFlag('on')
})

afterAll(() => setFlag('off'))

describe('the feature gate', () => {
  it('is a 401 without a credential, whatever the flag says', async () => {
    const res = await request(`${BASE}/notes`)
    expect(res.status).toBe(401)
    expect(await json<{ error: string; statusCode: number }>(res)).toMatchObject({
      statusCode: 401,
    })
  })

  it('hides the whole mount as a 404 — never a 403, which would confirm it exists', async () => {
    await setFlag('off')
    try {
      const res = await request(`${BASE}/notes`, { headers: ownerCookie })
      expect(res.status).toBe(404)
      expect(await json<{ code?: string }>(res)).toMatchObject({ code: 'feature_disabled' })
    } finally {
      await setFlag('on')
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

describe('list_example_notes', () => {
  const toolContext = (tenant: string): AgentToolContext => {
    const env = createTestEnv()
    return { db, cfg: loadConfig(env), env, scope: fullAccessScope(tenant) }
  }

  it('answers the run’s own tenant, and says so when there is nothing to read', async () => {
    const note = await createNote(ownerCookie, 'Depot handover')
    const tool = listExampleNotesTool(toolContext(tenantId))
    const answer = JSON.parse((await tool.handler?.({})) ?? '{}') as {
      total: number
      notes: { noteId: string; title: string }[]
      hint?: string
    }
    expect(answer.notes.map(n => n.noteId)).toContain(note.id)

    const emptyTenant = await createTestTenant(db)
    const empty = JSON.parse(
      (await listExampleNotesTool(toolContext(emptyTenant.id)).handler?.({})) ?? '{}'
    ) as { total: number; hint?: string }
    expect(empty.total).toBe(0)
    expect(empty.hint).toMatch(/No example notes/)
  })
})
