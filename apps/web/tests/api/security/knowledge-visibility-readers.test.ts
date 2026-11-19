/**
 * What a member reads about a fact never depends on a document they cannot open:
 *
 * - a fact SUPERSEDED by a fact from a hidden document reads, for that reader, as the fact
 *   nothing replaced — its restored state, no `supersededById` — on the card, a document's facts
 *   and `lookup_facts`, counts in the Facts view, and can be confirmed (which leaves the stored
 *   supersession alone for those who can see it);
 * - `lookup_facts` resolves a name through the reader's view, so an entity known only from hidden
 *   documents answers exactly like a name nobody knows.
 */
import {
  documentFactsResponseSchema,
  entityCardSchema,
  factReviewResponseSchema,
  knowledgeEntityListSchema,
  type LookupFactsResult,
} from '@rocketflare/shared/ai/knowledge-facts'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { type AccessScope, accessScopeForUser } from '@/api/services/access'
import { buildAgentTools } from '@/api/services/agents/tools'
import { setTenantOverride } from '@/api/services/features'
import { loadConfig } from '@/config'
import { groupMembers, groups, groupTypes, knowledgeFacts } from '@/db/schema'
import {
  createTestSession,
  createTestTenant,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { seedDocument, seedEntity, seedFact } from '../../helpers/knowledge-facts'
import { json, request } from '../../helpers/request'
import { createTestEnv } from '../../mocks/bindings'

const db = setupTestDatabase()
const env = createTestEnv()
const cfg = loadConfig(env)

interface Reader {
  userId: string
  cookie: Record<string, string>
  scope: AccessScope
}

let tenantId: string
let groupId: string
let insider: Reader
let outsider: Reader
let admin: Reader

async function reader(role: 'admin' | 'member', inGroup = false): Promise<Reader> {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, role)
  if (inGroup) await db.insert(groupMembers).values({ tenantId, groupId, userId: user.id })
  return {
    userId: user.id,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenantId)),
    scope: await accessScopeForUser(db, tenantId, user.id, { bypass: role === 'admin' }),
  }
}

const get = (path: string, who: Reader) => request(path, { headers: who.cookie }, { env })

async function lookup(who: Reader, input: unknown): Promise<LookupFactsResult> {
  const tools = await buildAgentTools({
    db,
    cfg,
    env,
    scope: who.scope,
    features: ['knowledge-facts'],
  })
  const found = tools.find(t => t.name === 'lookup_facts')
  if (!found?.handler) throw new Error('no lookup_facts')
  return JSON.parse(await found.handler(input as never)) as LookupFactsResult
}

beforeAll(async () => {
  tenantId = (await createTestTenant(db)).id
  const [type] = await db.insert(groupTypes).values({ tenantId, name: 'Dept' }).returning()
  const [group] = await db
    .insert(groups)
    .values({ tenantId, groupTypeId: type?.id ?? '', name: 'Board' })
    .returning()
  groupId = group?.id ?? ''
  admin = await reader('admin')
  insider = await reader('member', true)
  outsider = await reader('member')
  await setTenantOverride(db, 'knowledge-facts', tenantId, true, admin.userId)
})

describe('a fact replaced only by a fact the reader cannot see', () => {
  let entityId: string
  let openDocId: string
  let openFact: string
  let hiddenFact: string

  beforeAll(async () => {
    const open = await seedDocument(db, { tenantId, title: 'Price list 2025' })
    openDocId = open.id
    const restricted = await seedDocument(db, {
      tenantId,
      title: 'Board minutes',
      groupIds: [groupId],
    })
    entityId = (await seedEntity(db, { tenantId, name: 'Ferncliff Nurseries' })).id
    openFact = (
      await seedFact(db, {
        tenantId,
        entityId,
        documentId: open.id,
        value: 100,
        confidence: 0.95,
        reviewerUserId: outsider.userId,
        validFrom: new Date('2025-01-01Z'),
        validTo: new Date('2025-12-31Z'),
      })
    ).id
    hiddenFact = (
      await seedFact(db, {
        tenantId,
        entityId,
        documentId: restricted.id,
        value: 500,
        validFrom: new Date('2026-01-01Z'),
      })
    ).id
    await db
      .update(knowledgeFacts)
      .set({ state: 'superseded', supersededById: hiddenFact })
      .where(and(eq(knowledgeFacts.tenantId, tenantId), eq(knowledgeFacts.id, openFact)))
  })

  it('reads as its restored state with no pointer on the card and in its document', async () => {
    const card = entityCardSchema.parse(
      await json(await get(`/api/knowledge/entities/customer/${entityId}`, outsider))
    )
    expect(card.facts.map(f => f.id)).toEqual([openFact])
    expect(card.facts[0]).toMatchObject({ state: 'accepted', supersededById: null })

    const res = await get(`/api/knowledge/documents/${openDocId}/facts`, outsider)
    const body = documentFactsResponseSchema.parse(await json(res))
    expect(JSON.stringify(body)).not.toContain(hiddenFact)
    expect(body.groups[0]?.facts[0]?.state).toBe('accepted')
  })

  it('a reader who can see the replacing fact still sees the supersession', async () => {
    for (const who of [insider, admin]) {
      const card = entityCardSchema.parse(
        await json(await get(`/api/knowledge/entities/customer/${entityId}`, who))
      )
      expect(card.facts.find(f => f.id === openFact)).toMatchObject({
        state: 'superseded',
        supersededById: hiddenFact,
      })
    }
  })

  it('is answerable through lookup_facts and counted in the Facts view', async () => {
    const answer = await lookup(outsider, { entity: 'Ferncliff Nurseries' })
    const facts = answer.entities.flatMap(e => e.facts)
    expect(facts.map(f => [f.factId, f.state])).toEqual([[openFact, 'accepted']])

    const inside = await lookup(insider, { entity: 'Ferncliff Nurseries' })
    expect(inside.entities.flatMap(e => e.facts).map(f => f.factId)).toEqual([hiddenFact])

    const list = knowledgeEntityListSchema.parse(
      await json(await get('/api/knowledge/entities?q=Ferncliff', outsider))
    )
    expect(list.items.map(i => [i.entity.id, i.facts])).toEqual([[entityId, 1]])
  })

  it('can be confirmed by its reviewer, and stays superseded for those who see why', async () => {
    const res = await request(
      `/api/knowledge/facts/${openFact}/review`,
      {
        method: 'POST',
        headers: { ...outsider.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'confirm' }),
      },
      { env }
    )
    expect(res.status).toBe(200)
    const body = factReviewResponseSchema.parse(await json(res))
    expect(body.fact).toMatchObject({ id: openFact, state: 'accepted', supersededById: null })
    const [row] = await db
      .select()
      .from(knowledgeFacts)
      .where(and(eq(knowledgeFacts.tenantId, tenantId), eq(knowledgeFacts.id, openFact)))
    expect(row).toMatchObject({ state: 'superseded', supersededById: hiddenFact })
    expect(row?.confirmedBy).toBe(outsider.userId)
  })
})

describe('lookup_facts resolves names through the reader’s view', () => {
  beforeAll(async () => {
    const restricted = await seedDocument(db, {
      tenantId,
      title: 'Restricted memo',
      groupIds: [groupId],
    })
    const entity = await seedEntity(db, {
      tenantId,
      name: 'Project Larkspur',
      aliases: ['Larkspur Venture'],
    })
    await seedFact(db, { tenantId, entityId: entity.id, documentId: restricted.id, value: 7 })
  })

  it('a member of the group finds the entity', async () => {
    const res = await lookup(insider, { entity: 'Project Larkspur' })
    expect(res.entities.map(e => e.entity.name)).toEqual(['Project Larkspur'])
  })

  it('for anyone else, an entity known only from hidden documents answers like an unknown name', async () => {
    const pairs: [string, string][] = [
      ['Project Larkspur', 'Qwzzyx Nonexistent'],
      ['Larkspur', 'Qwzzyx'],
      ['Larkspur Venture', 'Qwzzyx Venturous'],
    ]
    for (const [known, unknown] of pairs) {
      const hidden = await lookup(outsider, { entity: known })
      const none = await lookup(outsider, { entity: unknown })
      expect(hidden.entities).toEqual([])
      expect(hidden.hint?.replace(known, 'X')).toBe(none.hint?.replace(unknown, 'X'))
    }
  })
})
