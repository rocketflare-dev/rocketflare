/**
 * The visibility matrix (D29). Groups are only worth having if EVERY read path agrees about them,
 * so this file walks one restricted document past every way the kit can hand content to a person
 * or to a model:
 *
 *   documents list · get · content · passages · card · delete · hybrid search ·
 *   `GET /api/files/:id` for the uploaded original · the three agent tools
 *
 * An installed PLUGIN whose rows carry `visibility` owns the same matrix for its own resource —
 * the analytics plugin's dashboards used to be a second half of this file and are now
 * `src/plugins/analytics/tests/api/dashboard-visibility.test.ts` (D31).
 *
 * Readers: the owner, somebody in the group, somebody who is not, an admin, and support. The two
 * shapes that matter most are at the bottom: an EMPTY grant list (what a force-deleted group
 * leaves) must hide the document from everyone but its owner and admins, and a hidden document
 * must answer the SAME 404 as one that does not exist.
 */
import { makeRequestCtx } from '@testkit/unit'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { accessScopeForUser } from '@/api/services/access'
import { buildAgentTools } from '@/api/services/agents/tools'
import { ingestText } from '@/api/services/ai/ingest'
import { searchChunks } from '@/api/services/ai/retrieval'
import { loadConfig } from '@/config'
import { documentGroups, documents, files, groupMembers, groups, groupTypes } from '@/db/schema'
import {
  createTestSession,
  createTestTenant,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv, type TestEnv } from '../mocks/bindings'

const db = setupTestDatabase()

/** Deterministic vectors keyed on a word, so the dense half is exercised rather than mocked away. */
function keywordEnv(): TestEnv {
  return createTestEnv({
    AI: {
      run: async (_model: string, inputs: { text?: string[] }) => ({
        data: (inputs.text ?? ['']).map(text => {
          const vector = new Array(1024).fill(0)
          vector[0] = text.toLowerCase().includes('payroll') ? 1 : 0
          vector[1] = 1
          return vector
        }),
      }),
    } as unknown as TestEnv['AI'],
  })
}

interface Reader {
  userId: string
  cookie: Record<string, string>
}

let tenantId: string
let env: TestEnv
let cfg: ReturnType<typeof loadConfig>
let groupId: string
/** The restricted document and the tenant-wide one it sits beside. */
let restrictedId: string
let openId: string
let owner: Reader
let inGroup: Reader
let outsider: Reader
let admin: Reader
let support: Reader

async function reader(role: 'owner' | 'admin' | 'member' | 'support'): Promise<Reader> {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, role)
  return {
    userId: user.id,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenantId)),
  }
}

beforeAll(async () => {
  const tenant = await createTestTenant(db)
  tenantId = tenant.id
  env = keywordEnv()
  cfg = loadConfig(env)

  owner = await reader('member')
  inGroup = await reader('member')
  outsider = await reader('member')
  admin = await reader('admin')
  support = await reader('support')

  const [type] = await db.insert(groupTypes).values({ tenantId, name: 'Department' }).returning()
  const [group] = await db
    .insert(groups)
    .values({ tenantId, groupTypeId: type?.id ?? '', name: 'Finance' })
    .returning()
  groupId = group?.id ?? ''
  await db.insert(groupMembers).values({ tenantId, groupId, userId: inGroup.userId })

  const restricted = await ingestText(db, cfg, env, {
    tenantId,
    userId: owner.userId,
    title: 'Payroll handbook',
    text: 'The payroll run closes on the 25th. Payroll queries go to Finance.',
    visibility: 'groups',
    groupIds: [groupId],
  })
  restrictedId = restricted.document.id

  const open = await ingestText(db, cfg, env, {
    tenantId,
    userId: owner.userId,
    title: 'Office handbook',
    text: 'The office opens at eight. Payroll is not discussed here.',
  })
  openId = open.document.id
})

const readers = () =>
  [
    ['owner', () => owner, true],
    ['in the group', () => inGroup, true],
    ['outsider', () => outsider, false],
    ['admin', () => admin, true],
    ['support', () => support, true],
  ] as const

describe('documents: every read path agrees', () => {
  for (const [label, get, canSee] of readers()) {
    it(`${label} ${canSee ? 'sees' : 'does not see'} the restricted document`, async () => {
      const headers = get().cookie

      const list = await json<{ items: { id: string }[] }>(
        await request('/api/ai/documents', { headers })
      )
      expect(list.items.map(d => d.id).includes(restrictedId)).toBe(canSee)
      // The tenant-wide document is visible to everyone, always.
      expect(list.items.map(d => d.id)).toContain(openId)

      const expected = canSee ? 200 : 404
      expect((await request(`/api/ai/documents/${restrictedId}`, { headers })).status).toBe(
        expected
      )
      expect((await request(`/api/ai/documents/${restrictedId}/content`, { headers })).status).toBe(
        expected
      )
      expect(
        (await request(`/api/ai/documents/${restrictedId}/passages`, { headers })).status
      ).toBe(expected)
      expect((await request(`/api/ai/documents/${restrictedId}/card`, { headers })).status).toBe(
        expected
      )

      const search = await json<{ hits: { documentId: string }[] }>(
        await request(
          '/api/ai/documents/search',
          { method: 'POST', headers },
          { json: { query: 'payroll run', limit: 10 } }
        )
      )
      expect(search.hits.some(h => h.documentId === restrictedId)).toBe(canSee)
    })
  }

  it('a hidden document is the SAME 404 body as one that never existed', async () => {
    const hidden = await request(`/api/ai/documents/${restrictedId}`, { headers: outsider.cookie })
    const absent = await request(`/api/ai/documents/00000000-0000-4000-8000-000000000000`, {
      headers: outsider.cookie,
    })
    expect(await json(hidden)).toEqual(await json(absent))
  })

  it('an outsider cannot delete what they cannot see', async () => {
    const res = await request(`/api/ai/documents/${restrictedId}`, {
      method: 'DELETE',
      headers: outsider.cookie,
    })
    expect(res.status).toBe(404)
  })

  it('the ORIGINAL behind a restricted document is not downloadable by id', async () => {
    const key = `tenants/${tenantId}/documents/${crypto.randomUUID()}-payslips.pdf`
    await env.FILES?.put(key, new TextEncoder().encode('%PDF-1.4'))
    const [file] = await db
      .insert(files)
      .values({
        tenantId,
        ownerUserId: owner.userId,
        scope: 'documents',
        key,
        filename: 'payslips.pdf',
        contentType: 'application/pdf',
        sizeBytes: 10,
      })
      .returning()
    const [doc] = await db
      .insert(documents)
      .values({
        tenantId,
        ownerUserId: owner.userId,
        title: 'Payslips',
        contentType: 'application/pdf',
        fileId: file?.id,
        visibility: 'groups',
      })
      .returning()
    await db.insert(documentGroups).values({ tenantId, documentId: doc?.id ?? '', groupId })

    expect(
      (await request(`/api/files/${file?.id}`, { headers: outsider.cookie }, { env })).status
    ).toBe(404)
    // Somebody who may read the document gets the bytes.
    const allowed = await request(`/api/files/${file?.id}`, { headers: inGroup.cookie }, { env })
    expect(allowed.status).toBe(200)
    expect(await allowed.text()).toContain('%PDF')
  })
})

describe('the knowledge tools see exactly what their requester sees', () => {
  const parse = (s: string) => JSON.parse(s) as Record<string, never>

  async function toolsFor(userId: string | null) {
    const scope = await accessScopeForUser(db, tenantId, userId)
    const [search, get, list] = buildAgentTools({ db, cfg, env, scope })
    return {
      search: (input: unknown) => search?.handler?.(input as never) ?? Promise.resolve('{}'),
      get: (input: unknown) => get?.handler?.(input as never) ?? Promise.resolve('{}'),
      list: (input: unknown) => list?.handler?.(input as never) ?? Promise.resolve('{}'),
    }
  }

  it('a run started by someone in the group reads the restricted document', async () => {
    const tools = await toolsFor(inGroup.userId)
    const found = parse(await tools.search({ query: 'payroll run', limit: 10 })) as unknown as {
      documents: { documentId: string }[]
    }
    expect(found.documents.map(d => d.documentId)).toContain(restrictedId)
    const window = parse(await tools.get({ documentId: restrictedId })) as unknown as {
      text?: string
    }
    expect(window.text).toContain('payroll')
    const listed = parse(await tools.list({})) as unknown as {
      documents: { documentId: string }[]
    }
    expect(listed.documents.map(d => d.documentId)).toContain(restrictedId)
  })

  it('a run started by an outsider gets an unknown-id answer that does not admit it exists', async () => {
    const tools = await toolsFor(outsider.userId)
    const found = parse(await tools.search({ query: 'payroll run', limit: 10 })) as unknown as {
      documents: { documentId: string }[]
    }
    expect(found.documents.map(d => d.documentId)).not.toContain(restrictedId)

    const problem = parse(await tools.get({ documentId: restrictedId })) as unknown as {
      error: string
      hint: string
      knowledgeBase: { documentId: string }[]
    }
    expect(problem.error).toBe('document_not_found')
    expect(problem.hint).not.toMatch(/permission|restricted|not allowed/i)
    // The suggestion list is filtered too, or it would name the very document just denied.
    expect(problem.knowledgeBase.map(d => d.documentId)).not.toContain(restrictedId)

    const listed = parse(await tools.list({})) as unknown as {
      documents: { documentId: string }[]
    }
    expect(listed.documents.map(d => d.documentId)).not.toContain(restrictedId)
  })

  it('a run with NO requesting user ("system") sees tenant-wide documents only', async () => {
    const tools = await toolsFor(null)
    const listed = parse(await tools.list({})) as unknown as {
      documents: { documentId: string }[]
    }
    expect(listed.documents.map(d => d.documentId)).toContain(openId)
    expect(listed.documents.map(d => d.documentId)).not.toContain(restrictedId)
  })
})

describe('an EMPTY grant list is private, not public', () => {
  it('hides the document from everyone but its owner and admins', async () => {
    const { document } = await ingestText(db, cfg, env, {
      tenantId,
      userId: owner.userId,
      title: 'Orphaned',
      text: 'Payroll numbers nobody is meant to read.',
      visibility: 'groups',
      groupIds: [groupId],
    })
    // What deleting the last group leaves behind: the column stays `groups`, the grants are gone.
    await db.delete(documentGroups).where(eq(documentGroups.documentId, document.id))

    const seen = async (r: Reader) =>
      (await request(`/api/ai/documents/${document.id}`, { headers: r.cookie })).status === 200
    expect(await seen(owner)).toBe(true)
    expect(await seen(admin)).toBe(true)
    expect(await seen(inGroup)).toBe(false)
    expect(await seen(outsider)).toBe(false)
  })
})

describe('who may restrict what', () => {
  it('a member may only share with groups they belong to; an admin with any', async () => {
    const { document } = await ingestText(db, cfg, env, {
      tenantId,
      userId: outsider.userId,
      title: 'Mine',
      text: 'A document the outsider owns.',
    })
    const refused = await request(
      `/api/ai/documents/${document.id}/visibility`,
      { method: 'PUT', headers: outsider.cookie },
      { json: { visibility: 'groups', groupIds: [groupId] } }
    )
    expect(refused.status).toBe(403)
    expect(await json(refused)).toMatchObject({ code: 'group_not_yours' })

    const allowed = await request(
      `/api/ai/documents/${document.id}/visibility`,
      { method: 'PUT', headers: admin.cookie },
      { json: { visibility: 'groups', groupIds: [groupId] } }
    )
    expect(allowed.status).toBe(200)
    expect(await json(allowed)).toMatchObject({
      visibility: 'groups',
      groups: [{ id: groupId, name: 'Finance', typeName: 'Department' }],
    })
  })

  it("a member cannot change the visibility of somebody else's document", async () => {
    const res = await request(
      `/api/ai/documents/${openId}/visibility`,
      { method: 'PUT', headers: inGroup.cookie },
      { json: { visibility: 'tenant', groupIds: [] } }
    )
    expect(res.status).toBe(403)
  })
})

describe('retrieval recall under a restrictive scope', () => {
  it('finds the one visible passage with hundreds of hidden ones ranked above it', async () => {
    const tenant = await createTestTenant(db)
    const user = await createTestUser(db)
    await linkUserToTenant(db, user.id, tenant.id, 'member')
    const [type] = await db
      .insert(groupTypes)
      .values({ tenantId: tenant.id, name: 'Department' })
      .returning()
    const [group] = await db
      .insert(groups)
      .values({ tenantId: tenant.id, groupTypeId: type?.id ?? '', name: 'Finance' })
      .returning()

    // 60 documents nobody in this scope may read, all matching the query as strongly as possible.
    for (let i = 0; i < 60; i++) {
      await ingestText(db, cfg, env, {
        tenantId: tenant.id,
        userId: null,
        title: `Hidden payroll ${i}`,
        text: 'Payroll payroll payroll — the hidden corpus.',
        visibility: 'groups',
        groupIds: [group?.id ?? ''],
      })
    }
    const { document } = await ingestText(db, cfg, env, {
      tenantId: tenant.id,
      userId: null,
      title: 'The one visible payroll note',
      text: 'Payroll closes on the 25th, and this note is open to the organisation.',
    })

    const scope = await accessScopeForUser(db, tenant.id, user.id)
    const hits = await searchChunks(db, cfg, env, scope, { query: 'payroll', limit: 5 })
    expect(hits.map(h => h.documentId)).toContain(document.id)
  })
})

/**
 * The same rules, reached the way a PLUGIN reaches them (D31).
 *
 * A plugin declares a restrictable resource and the kit reads the declaration — but the three
 * helpers the kit's own routes use around it (`resolve`, `set`, `grantsFor`) live in the module
 * that COMPOSES the registry, which a plugin cannot import without closing a cycle through the
 * plugin barrel. So they are injected as `ctx.visibility`, and this block drives the published
 * surface over the same fixtures the rest of the file proves the predicate with: whatever holds
 * above holds for a plugin's own rows, or the two halves have drifted.
 */
describe('ctx.visibility: the published helpers', () => {
  const ctxFor = (r: Reader, role: 'member' | 'admin' = 'member', inFinance = false) =>
    makeRequestCtx({
      db,
      tenantId,
      userId: r.userId,
      role,
      groups: inFinance ? [{ id: groupId, name: 'Finance', typeName: 'Department' }] : [],
    })

  it('reads the grants of many rows in one call, and says nothing about an unshared one', async () => {
    const grants = await ctxFor(admin, 'admin').visibility.grantsFor('document', [
      restrictedId,
      openId,
    ])
    expect(grants.get(restrictedId)).toEqual([
      { id: groupId, name: 'Finance', typeName: 'Department' },
    ])
    expect(grants.get(openId)).toBeUndefined()
  })

  it('refuses a member sharing with a group they are not in — 403 group_not_yours', async () => {
    await expect(
      ctxFor(outsider).visibility.resolve({ visibility: 'groups', groupIds: [groupId] })
    ).rejects.toMatchObject({ statusCode: 403, code: 'group_not_yours' })
  })

  it('allows the member who IS in it, and an admin with any group', async () => {
    await expect(
      ctxFor(inGroup, 'member', true).visibility.resolve({
        visibility: 'groups',
        groupIds: [groupId],
      })
    ).resolves.toEqual({ visibility: 'groups', groupIds: [groupId] })
    // `bypass` is admin-level, so an admin is never narrowed to their own memberships.
    await expect(
      ctxFor(admin, 'admin').visibility.resolve({ visibility: 'groups', groupIds: [groupId] })
    ).resolves.toEqual({ visibility: 'groups', groupIds: [groupId] })
  })

  it('defaults to tenant-wide when the client asked for nothing', async () => {
    await expect(ctxFor(owner).visibility.resolve(undefined)).resolves.toEqual({
      visibility: 'tenant',
      groupIds: [],
    })
  })

  it('writes grants through the registry, and clears them when it goes back to tenant', async () => {
    // Its own document, so the matrix above cannot depend on the order this file runs in.
    const { document } = await ingestText(db, cfg, env, {
      tenantId,
      userId: owner.userId,
      title: 'Shift rota',
      text: 'The rota is published on Fridays.',
    })
    const ctx = ctxFor(admin, 'admin')

    expect(
      await ctx.visibility.set('document', document.id, {
        visibility: 'groups',
        groupIds: [groupId],
      })
    ).toEqual([groupId])
    expect((await ctx.visibility.grantsFor('document', [document.id])).get(document.id)).toEqual([
      { id: groupId, name: 'Finance', typeName: 'Department' },
    ])

    // 'tenant' CLEARS the grants: stale rows would silently re-restrict the document the next time
    // somebody flipped it back to 'groups'.
    expect(
      await ctx.visibility.set('document', document.id, { visibility: 'tenant', groupIds: [] })
    ).toEqual([])
    expect(
      (await ctx.visibility.grantsFor('document', [document.id])).get(document.id)
    ).toBeUndefined()
  })

  it('is a 404-shaped failure for a kind nothing registered', async () => {
    await expect(
      ctxFor(admin, 'admin').visibility.grantsFor('nope:thing', [restrictedId])
    ).rejects.toThrow(/no visibility resource named 'nope:thing'/)
  })
})
