/**
 * Knowledge facts inherit their DOCUMENT's visibility (D43): a fact read from a document you
 * cannot open does not exist for you — on every path that hands facts to a person or a model:
 *
 *   the review list · a review action (404, never 403) · the entity card · `lookup_facts` ·
 *   `search_knowledge`'s facts block
 *
 * and the one subtle shape: a fact `conflicting` only with a hidden fact reads, for that reader,
 * as the fact nobody disagrees with (`accepted` here) — a hidden document must not leak even "a
 * source you cannot see says otherwise". `prefer` by such a reader leaves the hidden side alone.
 *
 * Readers: somebody in the group, somebody who is not, and an admin (who sees everything).
 */
import {
  entityCardSchema,
  knowledgeReviewListSchema,
  type LookupFactsResult,
} from '@rocketflare/shared/ai/knowledge-facts'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { type AccessScope, accessScopeForUser } from '@/api/services/access'
import { buildAgentTools } from '@/api/services/agents/tools'
import type { SearchKnowledgeResult } from '@/api/services/agents/tools/search-knowledge'
import { setTenantOverride } from '@/api/services/features'
import { loadConfig } from '@/config'
import { groupMembers, groups, groupTypes, knowledgeFacts } from '@/db/schema'
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
const cfg = loadConfig(env)

interface Reader {
  userId: string
  cookie: Record<string, string>
  scope: AccessScope
}

let tenantId: string
let inGroup: Reader
let outsider: Reader
let admin: Reader
let bakeryId: string
let secretEntityId: string
let openFee: string
let secretFee: string
let secretContact: string

async function reader(role: 'admin' | 'member'): Promise<Reader> {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, role)
  return {
    userId: user.id,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenantId)),
    scope: { tenantId, userId: user.id, groupIds: [], bypass: role === 'admin' },
  }
}

const get = (path: string, who: Reader) => request(path, { headers: who.cookie }, { env })

async function tool(who: Reader, name: string, input: unknown, features = ['knowledge-facts']) {
  const tools = await buildAgentTools({ db, cfg, env, scope: who.scope, features })
  const found = tools.find(t => t.name === name)
  if (!found?.handler) throw new Error(`no tool ${name}`)
  return JSON.parse(await found.handler(input as never)) as unknown
}

beforeAll(async () => {
  tenantId = (await createTestTenant(db)).id
  inGroup = await reader('member')
  outsider = await reader('member')
  admin = await reader('admin')
  await setTenantOverride(db, 'knowledge-facts', tenantId, true, admin.userId)

  const [type] = await db.insert(groupTypes).values({ tenantId, name: 'Department' }).returning()
  const [group] = await db
    .insert(groups)
    .values({ tenantId, groupTypeId: type?.id ?? '', name: 'Finance' })
    .returning()
  const groupId = group?.id ?? ''
  await db.insert(groupMembers).values({ tenantId, groupId, userId: inGroup.userId })
  inGroup.scope = await accessScopeForUser(db, tenantId, inGroup.userId)

  const open = await seedDocument(db, {
    tenantId,
    title: 'Service catalogue',
    createdAt: new Date('2025-06-01T09:00:00Z'),
  })
  const secret = await seedDocument(db, {
    tenantId,
    title: 'Board minutes',
    groupIds: [groupId],
    createdAt: new Date('2026-06-01T09:00:00Z'),
  })

  bakeryId = (await seedEntity(db, { tenantId, name: 'Brightside Bakery' })).id
  openFee = (
    await seedFact(db, {
      tenantId,
      entityId: bakeryId,
      documentId: open.id,
      value: 100,
      observedAt: new Date('2025-06-01T09:00:00Z'),
      reviewerUserId: outsider.userId,
    })
  ).id
  secretFee = (
    await seedFact(db, {
      tenantId,
      entityId: bakeryId,
      documentId: secret.id,
      value: 120,
      observedAt: new Date('2026-06-01T09:00:00Z'),
      reviewerUserId: outsider.userId,
    })
  ).id
  await linkConflict(db, tenantId, openFee, secretFee)
  secretContact = (
    await seedFact(db, {
      tenantId,
      entityId: bakeryId,
      documentId: secret.id,
      key: 'primary_contact',
      value: 'Helen Price',
      state: 'unconfirmed',
      confidence: 0.4,
      reviewerUserId: outsider.userId,
    })
  ).id

  secretEntityId = (await seedEntity(db, { tenantId, name: 'Project Larkspur' })).id
  await seedFact(db, {
    tenantId,
    entityId: secretEntityId,
    documentId: secret.id,
    key: 'contact_phone',
    value: '0100 200',
  })
})

describe('the review list', () => {
  it('shows an outsider none of it: the hidden fact, and the conflict it hides', async () => {
    const res = await get('/api/knowledge/review?pageSize=200', outsider)
    const list = knowledgeReviewListSchema.parse(await json(res))
    // `openFee` conflicts only with a hidden fact, so for them it is plain accepted — no item.
    expect(list.items).toEqual([])
    expect(list.pagination.total).toBe(0)
  })

  it('shows an admin every item with both sides', async () => {
    const res = await get('/api/knowledge/review?pageSize=200', admin)
    const list = knowledgeReviewListSchema.parse(await json(res))
    const ids = list.items.flatMap(i => (i.kind === 'fact' ? [i.fact.id] : []))
    expect(ids).toEqual(expect.arrayContaining([openFee, secretFee, secretContact]))
    const item = list.items.find(i => i.kind === 'fact' && i.fact.id === openFee)
    expect(item?.kind === 'fact' && item.conflicts.map(f => f.id)).toEqual([secretFee])
  })
})

describe('a possible match whose every candidate is hidden', () => {
  it('is neither listed nor counted for that reader; an admin sees it', async () => {
    // Visible to the outsider (a fact from the open document), naming only the hidden entity.
    const open = await seedDocument(db, { tenantId, title: 'Open note' })
    const twin = await seedEntity(db, {
      tenantId,
      name: 'Copperfield Holdings',
      reviewerUserId: outsider.userId,
      possibleMatches: [
        { kind: 'staging', id: secretEntityId, label: 'Project Larkspur', score: 0.6 },
      ],
    })
    await seedFact(db, { tenantId, entityId: twin.id, documentId: open.id, value: 5 })
    const mine = knowledgeReviewListSchema.parse(
      await json(await get('/api/knowledge/review?pageSize=200', outsider))
    )
    expect(mine.items).toEqual([])
    expect(mine.pagination.total).toBe(0)
    const all = knowledgeReviewListSchema.parse(
      await json(await get('/api/knowledge/review?kind=possibleMatch&pageSize=200', admin))
    )
    expect(all.items.map(i => (i.kind === 'possibleMatch' ? i.entity.id : ''))).toContain(twin.id)
    expect(all.pagination.total).toBe(all.items.length)
  })
})

describe('a review action on a hidden fact', () => {
  it('is the 404 an absent fact is — never a 403, even for its named reviewer', async () => {
    const res = await request(
      `/api/knowledge/facts/${secretContact}/review`,
      { method: 'POST', headers: outsider.cookie },
      { env, json: { action: 'confirm' } }
    )
    expect(res.status).toBe(404)
    const missing = await request(
      `/api/knowledge/facts/${crypto.randomUUID()}/review`,
      { method: 'POST', headers: outsider.cookie },
      { env, json: { action: 'confirm' } }
    )
    expect(await json(res)).toEqual(await json(missing))
  })
})

describe('the entity card', () => {
  it('gives an outsider only the visible fact, in their view of its state', async () => {
    const res = await get(`/api/knowledge/entities/customer/${bakeryId}`, outsider)
    const card = entityCardSchema.parse(await json(res))
    expect(card.facts.map(f => [f.id, f.state, f.conflictsWith])).toEqual([
      [openFee, 'accepted', []],
    ])
  })

  it('gives the group member both sides, conflicting', async () => {
    const res = await get(`/api/knowledge/entities/customer/${bakeryId}`, inGroup)
    const card = entityCardSchema.parse(await json(res))
    const fees = card.facts.filter(f => f.key === 'monthly_fee_gbp')
    expect(fees.map(f => f.state)).toEqual(['conflicting', 'conflicting'])
  })

  it('is a 404 for an entity known only from a hidden document', async () => {
    expect((await get(`/api/knowledge/entities/customer/${secretEntityId}`, outsider)).status).toBe(
      404
    )
    expect((await get(`/api/knowledge/entities/customer/${secretEntityId}`, inGroup)).status).toBe(
      200
    )
    expect((await get(`/api/knowledge/entities/customer/${secretEntityId}`, admin)).status).toBe(
      200
    )
  })
})

describe('lookup_facts', () => {
  it('is offered only with the flag', async () => {
    const off = await buildAgentTools({ db, cfg, env, scope: outsider.scope, features: [] })
    expect(off.map(t => t.name)).not.toContain('lookup_facts')
    const on = await buildAgentTools({
      db,
      cfg,
      env,
      scope: outsider.scope,
      features: ['knowledge-facts'],
    })
    expect(on.map(t => t.name).slice(0, 4)).toEqual([
      'search_knowledge',
      'get_document',
      'list_documents',
      'lookup_facts',
    ])
  })

  it('answers an outsider with the visible fact alone, unlabelled', async () => {
    const result = (await tool(outsider, 'lookup_facts', {
      entity: 'Brightside',
    })) as LookupFactsResult
    expect(result.entities).toHaveLength(1)
    expect(result.entities[0]?.facts.map(f => [f.factId, f.state, f.preferred])).toEqual([
      [openFee, 'accepted', true],
    ])
    expect(JSON.stringify(result)).not.toContain('Board minutes')
    expect(JSON.stringify(result)).not.toContain('Helen')
  })

  it('answers the group member with both sides, labelled, the newer one preferred', async () => {
    const result = (await tool(inGroup, 'lookup_facts', {
      entity: 'Brightside Bakery',
      key: 'monthly_fee_gbp',
    })) as LookupFactsResult
    const facts = result.entities[0]?.facts ?? []
    expect(facts.map(f => [f.valueText, f.state, f.preferred, f.documentTitle])).toEqual([
      ['100', 'conflicting', false, 'Service catalogue'],
      ['120', 'conflicting', true, 'Board minutes'],
    ])
    expect(result.note).toMatch(/every side/i)
  })

  it('finds nothing for an outsider about an entity known only from a hidden document', async () => {
    const result = (await tool(outsider, 'lookup_facts', {
      entity: 'Project Larkspur',
    })) as LookupFactsResult
    expect(result.entities).toEqual([])
  })
})

describe("search_knowledge's facts block", () => {
  it('carries the facts about the entity the query names — the visible ones', async () => {
    const forOutsider = (await tool(outsider, 'search_knowledge', {
      query: 'What does Brightside Bakery pay each month?',
    })) as SearchKnowledgeResult
    expect(forOutsider.facts?.[0]?.facts.map(f => f.factId)).toEqual([openFee])
    const forMember = (await tool(inGroup, 'search_knowledge', {
      query: 'What does Brightside Bakery pay each month?',
    })) as SearchKnowledgeResult
    expect(forMember.facts?.[0]?.facts.map(f => f.factId).sort()).toEqual(
      [openFee, secretFee, secretContact].sort()
    )
    expect(forMember.factsNote).toMatch(/conflicting/)
  })

  it('names no entity the reader cannot see, and is absent without the flag', async () => {
    const hidden = (await tool(outsider, 'search_knowledge', {
      query: 'Who is the contact for Project Larkspur?',
    })) as SearchKnowledgeResult
    expect(hidden.facts).toBeUndefined()
    const off = (await tool(
      inGroup,
      'search_knowledge',
      { query: 'What does Brightside Bakery pay each month?' },
      []
    )) as SearchKnowledgeResult
    expect(off.facts).toBeUndefined()
  })
})

describe('prefer by a reader who cannot see the other side', () => {
  it('confirms their side and leaves the hidden one — and the conflict — for an admin', async () => {
    const res = await request(
      `/api/knowledge/facts/${openFee}/review`,
      { method: 'POST', headers: outsider.cookie },
      { env, json: { action: 'prefer' } }
    )
    expect(res.status).toBe(200)
    const body = (await json(res)) as { fact: { state: string }; affected: unknown[] }
    expect(body.fact.state).toBe('accepted')
    expect(body.affected).toEqual([])
    const rows = await db.query.knowledgeFacts.findMany({
      where: and(eq(knowledgeFacts.tenantId, tenantId), eq(knowledgeFacts.entityId, bakeryId)),
    })
    const byId = new Map(rows.map(r => [r.id, r]))
    expect(byId.get(openFee)).toMatchObject({ state: 'conflicting', confirmedBy: outsider.userId })
    expect(byId.get(secretFee)?.state).toBe('conflicting')
  })
})
