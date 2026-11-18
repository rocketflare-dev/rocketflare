/**
 * The Search page's API: `POST /api/ai/documents/search` `filters` (source, content type, date
 * added) and `GET /api/ai/documents/facets`, plus `GET /api/knowledge/mentioned` (the facts block).
 *
 * The property that matters is that every one of them only NARROWS what the reader may already
 * see: a filter naming a restricted document's source finds nothing for someone outside its
 * group, the facets never list a value only an invisible (or another tenant's) document carries,
 * and the facts block reads facts through their documents' visibility. Validation: an inverted
 * date range and an empty list are 400s. Also: `lexical: 'no_terms'` when every query word is a
 * Postgres stopword, and the facets' reader-scoped `staleEmbeddings`.
 */
import { documentFacetsSchema, searchResponseSchema } from '@rocketflare/shared/ai/embeddings'
import { mentionedFactsResponseSchema } from '@rocketflare/shared/ai/knowledge-facts'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { ingestText } from '@/api/services/ai/ingest'
import { setTenantOverride } from '@/api/services/features'
import { loadConfig } from '@/config'
import { chunks, documents, groupMembers, groups, groupTypes } from '@/db/schema'
import {
  createTestSession,
  createTestTenant,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { seedEntity, seedFact } from '../helpers/knowledge-facts'
import { json, request } from '../helpers/request'
import { createTestEnv, type TestEnv } from '../mocks/bindings'

const db = setupTestDatabase()

/** Every text embeds to the same vector: the dense half finds everything, filters decide. */
function flatEnv(): TestEnv {
  return createTestEnv({
    AI: {
      run: async (_model: string, inputs: { text?: string[] }) => ({
        data: (inputs.text ?? ['']).map(() => {
          const vector = new Array(1024).fill(0)
          vector[0] = 1
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
let otherTenantId: string
let env: TestEnv
let owner: Reader
let inGroup: Reader
let outsider: Reader
let stranger: Reader
const ids: Record<string, string> = {}

async function reader(tenant: string, role: 'admin' | 'member'): Promise<Reader> {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenant, role)
  return {
    userId: user.id,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant)),
  }
}

async function seed(
  tenant: string,
  key: string,
  input: { source: string; contentType: string; createdAt: string; groupIds?: string[] }
) {
  const cfg = loadConfig(env)
  const { document } = await ingestText(db, cfg, env, {
    tenantId: tenant,
    userId: owner.userId,
    title: `Warehouse ${key}`,
    text: `Warehouse pallets note ${key}: stack the pallets two high in aisle ${key}.`,
    source: input.source,
    contentType: input.contentType,
    ...(input.groupIds ? { visibility: 'groups' as const, groupIds: input.groupIds } : {}),
  })
  await db
    .update(documents)
    .set({ createdAt: new Date(input.createdAt) })
    .where(and(eq(documents.tenantId, tenant), eq(documents.id, document.id)))
  ids[key] = document.id
}

const search = (who: Reader, body: Record<string, unknown>) =>
  request('/api/ai/documents/search', { method: 'POST', headers: who.cookie }, { env, json: body })

async function hitDocs(who: Reader, filters?: Record<string, unknown>) {
  const res = await search(who, { query: 'warehouse pallets', limit: 20, filters })
  expect(res.status).toBe(200)
  const body = searchResponseSchema.parse(await json(res))
  return [...new Set(body.hits.map(h => h.documentId))].sort()
}

const docsFor = (...keys: string[]) => keys.map(k => ids[k] as string).sort()

beforeAll(async () => {
  env = flatEnv()
  tenantId = (await createTestTenant(db)).id
  otherTenantId = (await createTestTenant(db)).id
  owner = await reader(tenantId, 'member')
  inGroup = await reader(tenantId, 'member')
  outsider = await reader(tenantId, 'member')
  stranger = await reader(otherTenantId, 'member')

  const [type] = await db.insert(groupTypes).values({ tenantId, name: 'Department' }).returning()
  const [group] = await db
    .insert(groups)
    .values({ tenantId, groupTypeId: type?.id ?? '', name: 'Finance' })
    .returning()
  const groupId = group?.id ?? ''
  await db.insert(groupMembers).values({ tenantId, groupId, userId: inGroup.userId })

  await seed(tenantId, 'a', {
    source: 'upload',
    contentType: 'text/plain',
    createdAt: '2025-01-15T10:00:00Z',
  })
  await seed(tenantId, 'b', {
    source: 'agent:weekly-digest',
    contentType: 'text/markdown',
    createdAt: '2025-03-31T23:30:00Z',
  })
  await seed(tenantId, 'c', {
    source: 'upload',
    contentType: 'text/markdown',
    createdAt: '2025-06-01T00:00:00Z',
  })
  // Restricted: only the group (and the owner) may see it — and its source is its own.
  await seed(tenantId, 'secret', {
    source: 'finance:ledger',
    contentType: 'text/csv',
    createdAt: '2025-02-01T00:00:00Z',
    groupIds: [groupId],
  })
  // Another tenant, with a source nobody here carries.
  await seed(otherTenantId, 'foreign', {
    source: 'foreign:crm',
    contentType: 'text/plain',
    createdAt: '2025-02-01T00:00:00Z',
  })
})

describe('POST /search filters', () => {
  it('no filters: everything the reader may see', async () => {
    expect(await hitDocs(outsider)).toEqual(docsFor('a', 'b', 'c'))
    expect(await hitDocs(inGroup)).toEqual(docsFor('a', 'b', 'c', 'secret'))
  })

  it('narrows by source, by content type, and by both', async () => {
    expect(await hitDocs(outsider, { sources: ['upload'] })).toEqual(docsFor('a', 'c'))
    expect(await hitDocs(outsider, { contentTypes: ['text/markdown'] })).toEqual(docsFor('b', 'c'))
    expect(
      await hitDocs(outsider, { sources: ['upload'], contentTypes: ['text/markdown'] })
    ).toEqual(docsFor('c'))
  })

  it('narrows by date added, both ends inclusive UTC days', async () => {
    expect(await hitDocs(outsider, { createdFrom: '2025-01-15', createdTo: '2025-03-31' })).toEqual(
      docsFor('a', 'b')
    )
    expect(await hitDocs(outsider, { createdFrom: '2025-04-01' })).toEqual(docsFor('c'))
    expect(await hitDocs(outsider, { createdTo: '2025-01-14' })).toEqual([])
  })

  it('never widens: a restricted or foreign source finds nothing for a reader who cannot see it', async () => {
    expect(await hitDocs(outsider, { sources: ['finance:ledger'] })).toEqual([])
    expect(await hitDocs(inGroup, { sources: ['finance:ledger'] })).toEqual(docsFor('secret'))
    expect(await hitDocs(outsider, { sources: ['foreign:crm'] })).toEqual([])
    expect(await hitDocs(stranger, { sources: ['upload'] })).toEqual([])
  })

  it('400s an inverted date range, an empty list and a malformed date', async () => {
    for (const filters of [
      { createdFrom: '2025-05-01', createdTo: '2025-01-01' },
      { sources: [] },
      { createdFrom: '01/05/2025' },
    ]) {
      const res = await search(outsider, { query: 'warehouse', filters })
      expect(res.status).toBe(400)
    }
  })
})

describe('GET /facets', () => {
  const facets = async (who: Reader) => {
    const res = await request('/api/ai/documents/facets', { headers: who.cookie }, { env })
    expect(res.status).toBe(200)
    return documentFacetsSchema.parse(await json(res))
  }

  it('lists the sources and types of what the reader may see, most common first', async () => {
    const f = await facets(outsider)
    expect(f.total).toBe(3)
    expect(f.sources).toEqual([
      { value: 'upload', count: 2 },
      { value: 'agent:weekly-digest', count: 1 },
    ])
    expect(f.contentTypes).toEqual([
      { value: 'text/markdown', count: 2 },
      { value: 'text/plain', count: 1 },
    ])
    expect(f.oldest?.toISOString()).toBe('2025-01-15T10:00:00.000Z')
    expect(f.newest?.toISOString()).toBe('2025-06-01T00:00:00.000Z')
  })

  it("includes a restricted document's values only for those who may see it, never another tenant's", async () => {
    const mine = await facets(inGroup)
    expect(mine.total).toBe(4)
    expect(mine.sources.map(s => s.value)).toContain('finance:ledger')
    expect(mine.contentTypes.map(s => s.value)).toContain('text/csv')
    for (const who of [outsider, inGroup]) {
      const f = await facets(who)
      expect(f.sources.map(s => s.value)).not.toContain('foreign:crm')
    }
    expect((await facets(outsider)).sources.map(s => s.value)).not.toContain('finance:ledger')
    expect(await facets(stranger)).toMatchObject({
      total: 1,
      sources: [{ value: 'foreign:crm', count: 1 }],
    })
  })

  it('401s without a session', async () => {
    expect((await request('/api/ai/documents/facets', {}, { env })).status).toBe(401)
  })
})

describe('GET /api/knowledge/mentioned', () => {
  const mentioned = (who: Reader, q: string) =>
    request(`/api/knowledge/mentioned?q=${encodeURIComponent(q)}`, { headers: who.cookie }, { env })

  it('is the 404 feature_disabled without the flag', async () => {
    const res = await mentioned(outsider, 'Acme Logistics')
    expect(res.status).toBe(404)
    expect(await json(res)).toMatchObject({ code: 'feature_disabled' })
  })

  it("answers the facts about the entities the query names, through the documents' visibility", async () => {
    await setTenantOverride(db, 'knowledge-facts', tenantId, true, owner.userId)
    const acme = await seedEntity(db, { tenantId, name: 'Acme Logistics' })
    await seedFact(db, {
      tenantId,
      entityId: acme.id,
      documentId: ids.a as string,
      key: 'pallet_limit',
      value: 40,
    })
    await seedFact(db, {
      tenantId,
      entityId: acme.id,
      documentId: ids.secret as string,
      key: 'credit_limit',
      value: 9000,
    })

    const forOutsider = mentionedFactsResponseSchema.parse(
      await json(await mentioned(outsider, 'what is Acme Logistics allowed'))
    )
    expect(forOutsider.entities).toHaveLength(1)
    expect(forOutsider.entities[0]?.entity.name).toBe('Acme Logistics')
    expect(forOutsider.entities[0]?.facts.map(f => f.key)).toEqual(['pallet_limit'])

    const forGroup = mentionedFactsResponseSchema.parse(
      await json(await mentioned(inGroup, 'what is Acme Logistics allowed'))
    )
    expect(forGroup.entities[0]?.facts.map(f => f.key).sort()).toEqual([
      'credit_limit',
      'pallet_limit',
    ])

    const none = mentionedFactsResponseSchema.parse(
      await json(await mentioned(outsider, 'opening hours'))
    )
    expect(none.entities).toEqual([])
  })

  it('400s an empty query', async () => {
    expect((await mentioned(outsider, '   ')).status).toBe(400)
  })
})

describe('lexical report', () => {
  const lexicalOf = async (query: string) => {
    const res = await search(outsider, { query })
    expect(res.status).toBe(200)
    return searchResponseSchema.parse(await json(res)).lexical
  }

  it("is 'no_terms' when every word is a stopword, 'used' otherwise", async () => {
    expect(await lexicalOf('and')).toBe('no_terms')
    expect(await lexicalOf('because and')).toBe('no_terms')
    expect(await lexicalOf('and pallets')).toBe('used')
    expect(await lexicalOf('warehouse')).toBe('used')
  })
})

describe('facets: staleEmbeddings', () => {
  const staleFor = async (who: Reader) => {
    const res = await request('/api/ai/documents/facets', { headers: who.cookie }, { env })
    return documentFacetsSchema.parse(await json(res)).staleEmbeddings
  }

  it("counts the reader's visible documents embedded by another model", async () => {
    expect(await staleFor(outsider)).toBe(0)
    for (const key of ['a', 'secret']) {
      await db
        .update(chunks)
        .set({ embeddingModel: 'seed:deterministic' })
        .where(and(eq(chunks.tenantId, tenantId), eq(chunks.documentId, ids[key] as string)))
    }
    expect(await staleFor(outsider)).toBe(1)
    expect(await staleFor(inGroup)).toBe(2)
    expect(await staleFor(stranger)).toBe(0)
  })
})
