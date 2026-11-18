/**
 * Browsing knowledge facts: `GET /api/knowledge/documents/:id/facts` (the document viewer's Facts
 * tab) and `GET /api/knowledge/entities` (the Knowledge page's Facts view).
 *
 * Both read every fact through its document's visibility. The fixture is one tenant-wide
 * document and one restricted to a group, an outsider and a group member, and a second tenant:
 * a restricted document's facts are a 404 / invisible to the outsider, an entity known only from
 * it is never listed for them, a conflict with a hidden fact reads as no conflict, counts are over
 * visible facts only, and another tenant's entities never appear. With the flag off both are the
 * 404 every `/api/knowledge` route is.
 */
import {
  documentFactsResponseSchema,
  knowledgeEntityListSchema,
} from '@rocketflare/shared/ai/knowledge-facts'
import { beforeAll, describe, expect, it } from 'vitest'
import { setTenantOverride } from '@/api/services/features'
import { groupMembers, groups, groupTypes } from '@/db/schema'
import {
  createTestSession,
  createTestTenant,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { linkConflict, seedDocument, seedEntity, seedFact } from '../helpers/knowledge-facts'
import { json, request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const env = createTestEnv()

interface Person {
  userId: string
  cookie: Record<string, string>
}

let tenantId: string
let otherTenantId: string
let noFlagTenantId: string
let outsider: Person
let inGroup: Person
let stranger: Person
let unflagged: Person
let openDoc: string
let secretDoc: string
let foreignDoc: string
let unflaggedDoc: string
const entity: Record<string, string> = {}
const fact: Record<string, string> = {}

async function person(tenant: string, role: 'admin' | 'member'): Promise<Person> {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenant, role)
  return {
    userId: user.id,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant)),
  }
}

const get = (path: string, who: Person) => request(path, { headers: who.cookie }, { env })

async function entities(who: Person, query = '') {
  const res = await get(`/api/knowledge/entities${query}`, who)
  expect(res.status).toBe(200)
  return knowledgeEntityListSchema.parse(await json(res))
}

const byName = (list: Awaited<ReturnType<typeof entities>>) =>
  Object.fromEntries(list.items.map(i => [i.entity.name, i]))

beforeAll(async () => {
  tenantId = (await createTestTenant(db)).id
  otherTenantId = (await createTestTenant(db)).id
  noFlagTenantId = (await createTestTenant(db)).id
  outsider = await person(tenantId, 'member')
  inGroup = await person(tenantId, 'member')
  stranger = await person(otherTenantId, 'member')
  unflagged = await person(noFlagTenantId, 'member')
  await setTenantOverride(db, 'knowledge-facts', tenantId, true, outsider.userId)
  await setTenantOverride(db, 'knowledge-facts', otherTenantId, true, stranger.userId)

  const [type] = await db.insert(groupTypes).values({ tenantId, name: 'Department' }).returning()
  const [group] = await db
    .insert(groups)
    .values({ tenantId, groupTypeId: type?.id ?? '', name: 'Finance' })
    .returning()
  const groupId = group?.id ?? ''
  await db.insert(groupMembers).values({ tenantId, groupId, userId: inGroup.userId })

  openDoc = (await seedDocument(db, { tenantId, title: 'Rate card' })).id
  secretDoc = (await seedDocument(db, { tenantId, title: 'Credit file', groupIds: [groupId] })).id
  foreignDoc = (await seedDocument(db, { tenantId: otherTenantId, title: 'Their file' })).id
  unflaggedDoc = (await seedDocument(db, { tenantId: noFlagTenantId, title: 'Unflagged' })).id

  for (const [key, name, type] of [
    ['acme', 'Acme Logistics', 'customer'],
    ['hidden', 'Hidden Haulage', 'customer'],
    ['beta', 'Beta Freight', 'supplier'],
    ['gone', 'Gone Carriers', 'customer'],
  ] as const) {
    entity[key] = (await seedEntity(db, { tenantId, name, type, aliases: [`${name} Ltd`] })).id
  }
  entity.foreign = (await seedEntity(db, { tenantId: otherTenantId, name: 'Acme Logistics' })).id

  const seed = async (
    key: string,
    input: Omit<Parameters<typeof seedFact>[1], 'tenantId'> & { tenantId?: string }
  ) => {
    fact[key] = (await seedFact(db, { tenantId, ...input })).id
  }
  await seed('acmePlan', {
    entityId: entity.acme as string,
    documentId: openDoc,
    key: 'plan',
    value: 'gold',
  })
  await seed('acmeCredit', {
    entityId: entity.acme as string,
    documentId: secretDoc,
    key: 'credit_limit',
    value: 9000,
    state: 'unconfirmed',
  })
  await seed('acmeFeeOpen', {
    entityId: entity.acme as string,
    documentId: openDoc,
    key: 'fee',
    value: 40,
  })
  await seed('acmeFeeSecret', {
    entityId: entity.acme as string,
    documentId: secretDoc,
    key: 'fee',
    value: 55,
  })
  await linkConflict(db, tenantId, fact.acmeFeeOpen as string, fact.acmeFeeSecret as string)
  await seed('hidden', {
    entityId: entity.hidden as string,
    documentId: secretDoc,
    key: 'plan',
    value: 'silver',
  })
  await seed('beta', {
    entityId: entity.beta as string,
    entityType: 'supplier',
    documentId: openDoc,
    key: 'lead_time',
    value: 3,
    state: 'unconfirmed',
    sourceKind: 'agent',
  })
  await seed('gone', {
    entityId: entity.gone as string,
    documentId: openDoc,
    key: 'plan',
    value: 'bronze',
    state: 'rejected',
  })
  await seed('foreign', {
    tenantId: otherTenantId,
    entityId: entity.foreign as string,
    documentId: foreignDoc,
    key: 'plan',
    value: 'platinum',
  })
})

describe('GET /api/knowledge/documents/:id/facts', () => {
  it('groups a visible document’s facts by entity; a conflict with a hidden fact reads as none', async () => {
    const res = await get(`/api/knowledge/documents/${openDoc}/facts`, outsider)
    expect(res.status).toBe(200)
    const body = documentFactsResponseSchema.parse(await json(res))
    expect(body.groups.map(g => g.entity.name)).toEqual([
      'Acme Logistics',
      'Beta Freight',
      'Gone Carriers',
    ])
    const acme = body.groups[0]
    expect(acme?.facts.map(f => f.key).sort()).toEqual(['fee', 'plan'])
    const fee = acme?.facts.find(f => f.key === 'fee')
    expect(fee?.state).toBe('accepted')
    expect(fee?.conflictsWith).toEqual([])
    // The history is shown too, labelled.
    expect(body.groups[2]?.facts[0]?.state).toBe('rejected')
  })

  it('shows the conflict to someone who can see both documents', async () => {
    const body = documentFactsResponseSchema.parse(
      await json(await get(`/api/knowledge/documents/${openDoc}/facts`, inGroup))
    )
    const fee = body.groups[0]?.facts.find(f => f.key === 'fee')
    expect(fee?.state).toBe('conflicting')
    expect(fee?.conflictsWith).toEqual([fact.acmeFeeSecret])
  })

  it('404s a restricted document for an outsider, and another tenant’s document for anyone', async () => {
    expect((await get(`/api/knowledge/documents/${secretDoc}/facts`, outsider)).status).toBe(404)
    expect((await get(`/api/knowledge/documents/${secretDoc}/facts`, inGroup)).status).toBe(200)
    expect((await get(`/api/knowledge/documents/${foreignDoc}/facts`, inGroup)).status).toBe(404)
    expect((await get(`/api/knowledge/documents/${openDoc}/facts`, stranger)).status).toBe(404)
  })

  it('is the 404 feature_disabled without the flag', async () => {
    const res = await get(`/api/knowledge/documents/${unflaggedDoc}/facts`, unflagged)
    expect(res.status).toBe(404)
    expect(await json(res)).toMatchObject({ code: 'feature_disabled' })
  })
})

describe('GET /api/knowledge/entities', () => {
  it('lists entities with current visible facts, counted over those alone', async () => {
    const list = await entities(outsider)
    const named = byName(list)
    expect(Object.keys(named).sort()).toEqual(['Acme Logistics', 'Beta Freight'])
    expect(named['Acme Logistics']).toMatchObject({ facts: 2, needsLook: 0 })
    expect(named['Beta Freight']).toMatchObject({ facts: 1, needsLook: 1 })
    expect(named['Beta Freight']?.entity.type).toBe('supplier')
    // Needs a look first.
    expect(list.items[0]?.entity.name).toBe('Beta Freight')
    expect(list.pagination.total).toBe(2)
  })

  it('a group member sees the restricted facts and the entity only they explain', async () => {
    const named = byName(await entities(inGroup))
    expect(Object.keys(named).sort()).toEqual(['Acme Logistics', 'Beta Freight', 'Hidden Haulage'])
    expect(named['Acme Logistics']).toMatchObject({ facts: 4, needsLook: 3 })
  })

  it('never lists another tenant’s entities', async () => {
    const named = byName(await entities(stranger))
    expect(Object.keys(named)).toEqual(['Acme Logistics'])
    expect(named['Acme Logistics']?.entity.id).toBe(entity.foreign)
    expect(named['Acme Logistics']?.facts).toBe(1)
  })

  it('filters by type, source kind, needs a look and name', async () => {
    expect(byName(await entities(outsider, '?type=supplier'))).toHaveProperty('Beta Freight')
    expect((await entities(outsider, '?type=supplier')).items).toHaveLength(1)
    expect((await entities(outsider, '?sourceKind=agent')).items.map(i => i.entity.name)).toEqual([
      'Beta Freight',
    ])
    expect((await entities(outsider, '?needsLook=true')).items.map(i => i.entity.name)).toEqual([
      'Beta Freight',
    ])
    expect((await entities(outsider, '?q=acme')).items.map(i => i.entity.name)).toEqual([
      'Acme Logistics',
    ])
    // Aliases match too; a LIKE wildcard in the query is literal.
    expect((await entities(outsider, '?q=Freight%20Ltd')).items).toHaveLength(1)
    expect((await entities(outsider, '?q=%25')).items).toHaveLength(0)
    // A name only a hidden document explains is not found by searching for it.
    expect((await entities(outsider, '?q=hidden')).items).toHaveLength(0)
  })

  it('facets count entities over every visible current fact', async () => {
    const { facets } = await entities(outsider, '?type=supplier')
    expect(facets.types).toEqual([
      { value: 'customer', label: 'customer', count: 1 },
      { value: 'supplier', label: 'supplier', count: 1 },
    ])
    expect(facets.sourceKinds.map(k => [k.value, k.count])).toEqual(
      [
        ['upload', 1],
        ['agent', 1],
      ].sort()
    )
  })

  it('pages', async () => {
    const first = await entities(inGroup, '?pageSize=2&page=1')
    const second = await entities(inGroup, '?pageSize=2&page=2')
    expect(first.items).toHaveLength(2)
    expect(second.items).toHaveLength(1)
    expect(first.pagination).toMatchObject({ total: 3, totalPages: 2 })
    const all = [...first.items, ...second.items].map(i => i.entity.id)
    expect(new Set(all).size).toBe(3)
  })

  it('400s an unknown source kind', async () => {
    expect((await get('/api/knowledge/entities?sourceKind=fax', outsider)).status).toBe(400)
  })
})
