/**
 * `/api/knowledge` (D43): the review list, `confirm` / `reject` / `prefer`, the entity card, and
 * merge / keep-separate, against real Postgres. Facts are seeded as the state each case needs
 * (`tests/helpers/knowledge-facts.ts`) rather than extracted — extraction is
 * `knowledge-extract.test.ts`. Promote needs a registered type with a table, so it lives in the
 * isolated `knowledge-promote.test.ts`; what restricted documents do to all of this is
 * `knowledge-facts-visibility.test.ts`. Every action nudges `entity.changed { entity: 'knowledge' }`
 * after it commits; a refused one sends nothing.
 */
import type {
  EntityActionResponse,
  EntityCard,
  FactReviewResponse,
  KnowledgeReviewList,
} from '@rocketflare/shared/ai/knowledge-facts'
import {
  entityActionResponseSchema,
  entityCardSchema,
  factReviewResponseSchema,
  knowledgeReviewListSchema,
} from '@rocketflare/shared/ai/knowledge-facts'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { setTenantOverride } from '@/api/services/features'
import { knowledgeEntities, knowledgeFacts } from '@/db/schema'
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
import { createTestEnv, stubs } from '../mocks/bindings'

const db = setupTestDatabase()
const env = createTestEnv()

interface Person {
  userId: string
  cookie: Record<string, string>
}

let tenantId: string
let otherTenantId: string
let reviewer: Person
let bystander: Person
let admin: Person
let outsiderTenantMember: Person
let docId: string
let docB: string

async function person(tenant: string, role: 'owner' | 'admin' | 'member'): Promise<Person> {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenant, role)
  return {
    userId: user.id,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant)),
  }
}

const get = (path: string, who: Person) => request(path, { headers: who.cookie }, { env })
const post = (path: string, who: Person, body?: unknown) =>
  request(path, { method: 'POST', headers: who.cookie }, { env, json: body ?? {} })

async function review(path: string, who: Person): Promise<KnowledgeReviewList> {
  const res = await get(path, who)
  expect(res.status).toBe(200)
  return knowledgeReviewListSchema.parse(await json(res))
}

const stateOf = async (id: string) =>
  (
    await db.query.knowledgeFacts.findFirst({
      where: and(eq(knowledgeFacts.tenantId, tenantId), eq(knowledgeFacts.id, id)),
    })
  )?.state

beforeAll(async () => {
  tenantId = (await createTestTenant(db)).id
  otherTenantId = (await createTestTenant(db)).id
  reviewer = await person(tenantId, 'member')
  bystander = await person(tenantId, 'member')
  admin = await person(tenantId, 'admin')
  outsiderTenantMember = await person(otherTenantId, 'member')
  await setTenantOverride(db, 'knowledge-facts', tenantId, true, admin.userId)
  // The other tenant has the flag too, so its 404s are about tenancy, not the gate.
  await setTenantOverride(db, 'knowledge-facts', otherTenantId, true, admin.userId)
  docId = (
    await seedDocument(db, {
      tenantId,
      title: 'Contract 2025',
      ownerUserId: reviewer.userId,
      createdAt: new Date('2025-01-10T09:00:00Z'),
    })
  ).id
  docB = (
    await seedDocument(db, {
      tenantId,
      title: 'Email 2026',
      ownerUserId: reviewer.userId,
      createdAt: new Date('2026-02-01T09:00:00Z'),
    })
  ).id
})

describe('the gate and the guards', () => {
  it('is a 404 feature_disabled for a tenant without the flag', async () => {
    const dark = await createTestTenant(db)
    const someone = await person(dark.id, 'owner')
    const res = await get('/api/knowledge/review', someone)
    expect(res.status).toBe(404)
    expect(await json(res)).toMatchObject({ statusCode: 404, code: 'feature_disabled' })
  })

  it('is a 401 without a session', async () => {
    const res = await request('/api/knowledge/review', {}, { env })
    expect(res.status).toBe(401)
  })

  it('validates the action', async () => {
    const entity = await seedEntity(db, { tenantId, name: 'Validation Ltd' })
    const fact = await seedFact(db, { tenantId, entityId: entity.id, documentId: docId, value: 1 })
    const res = await post(`/api/knowledge/facts/${fact.id}/review`, admin, { action: 'maybe' })
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ statusCode: 400, code: 'validation_failed' })
  })
})

describe('GET /api/knowledge/review', () => {
  let open: string
  let elsewhere: string
  let possible: string

  beforeAll(async () => {
    const entity = await seedEntity(db, { tenantId, name: 'Listing Bakery' })
    open = (
      await seedFact(db, {
        tenantId,
        entityId: entity.id,
        documentId: docId,
        value: 120,
        state: 'unconfirmed',
        confidence: 0.5,
        reviewerUserId: reviewer.userId,
      })
    ).id
    // Accepted: not an item.
    await seedFact(db, {
      tenantId,
      entityId: entity.id,
      documentId: docId,
      key: 'visit_day',
      value: 'Monday',
      reviewerUserId: reviewer.userId,
    })
    elsewhere = (
      await seedFact(db, {
        tenantId,
        entityId: entity.id,
        documentId: docB,
        key: 'contact_phone',
        value: '0100',
        state: 'unconfirmed',
        confidence: 0.4,
        reviewerUserId: admin.userId,
      })
    ).id
    const twin = await seedEntity(db, { tenantId, name: 'Listing Bakers' })
    possible = (
      await seedEntity(db, {
        tenantId,
        name: 'Listing Bakery Ltd',
        reviewerUserId: reviewer.userId,
        possibleMatches: [
          { kind: 'staging', id: entity.id, label: entity.name, score: 0.55 },
          { kind: 'staging', id: twin.id, label: twin.name, score: 0.5 },
        ],
      })
    ).id
    await seedFact(db, { tenantId, entityId: possible, documentId: docId, value: 99 })
    // The candidate twin has a fact too, so a member may see it.
    await seedFact(db, { tenantId, entityId: twin.id, documentId: docId, value: 98 })
  })

  it('lists the reviewer their own open facts and possible matches', async () => {
    const list = await review('/api/knowledge/review?pageSize=200', reviewer)
    const ids = list.items.map(i => (i.kind === 'fact' ? i.fact.id : i.entity.id))
    expect(ids).toContain(open)
    expect(ids).toContain(possible)
    expect(ids).not.toContain(elsewhere)
    const match = list.items.find(i => i.kind === 'possibleMatch' && i.entity.id === possible)
    expect(match?.kind === 'possibleMatch' && match.candidates).toHaveLength(2)
    expect(list.pagination.total).toBe(list.items.length)
    // A fact item names its entity, so the list can link to the entity page.
    const item = list.items.find(i => i.kind === 'fact' && i.fact.id === open)
    expect(item?.kind === 'fact' && item.entity).toMatchObject({
      kind: 'staging',
      name: 'Listing Bakery',
    })
  })

  it('lists another member nothing of theirs', async () => {
    const list = await review('/api/knowledge/review', bystander)
    expect(list.items).toEqual([])
    expect(list.pagination.total).toBe(0)
  })

  it('lists an admin everyone’s, and only theirs with mine=true', async () => {
    const all = await review('/api/knowledge/review?pageSize=200', admin)
    const ids = all.items.map(i => (i.kind === 'fact' ? i.fact.id : i.entity.id))
    expect(ids).toEqual(expect.arrayContaining([open, elsewhere, possible]))
    const mine = await review('/api/knowledge/review?mine=true&pageSize=200', admin)
    expect(mine.items.map(i => (i.kind === 'fact' ? i.fact.id : i.entity.id))).toEqual([elsewhere])
  })

  it('filters by kind and paginates', async () => {
    const facts = await review('/api/knowledge/review?kind=fact&pageSize=200', admin)
    expect(facts.items.every(i => i.kind === 'fact')).toBe(true)
    const page = await review('/api/knowledge/review?pageSize=1&page=2', admin)
    expect(page.items).toHaveLength(1)
    expect(page.pagination).toMatchObject({ page: 2, pageSize: 1 })
    expect(page.pagination.total).toBeGreaterThanOrEqual(3)
  })

  it('never lists another tenant’s items', async () => {
    const list = await review('/api/knowledge/review?pageSize=200', outsiderTenantMember)
    expect(list.items).toEqual([])
  })
})

describe('POST /api/knowledge/facts/:id/review', () => {
  async function fresh(name: string) {
    return seedEntity(db, { tenantId, name })
  }

  it('confirm: accepted, confirmed by me, trust unchanged', async () => {
    const e = await fresh('Confirm Co')
    const f = await seedFact(db, {
      tenantId,
      entityId: e.id,
      documentId: docId,
      value: 5,
      state: 'unconfirmed',
      confidence: 0.4,
      sourceKind: 'integration',
      reviewerUserId: reviewer.userId,
    })
    const res = await post(`/api/knowledge/facts/${f.id}/review`, reviewer, { action: 'confirm' })
    expect(res.status).toBe(200)
    const body: FactReviewResponse = factReviewResponseSchema.parse(await json(res))
    expect(body.fact).toMatchObject({ state: 'accepted', confirmedBy: reviewer.userId })
    expect(body.fact.source.kind).toBe('integration')
    expect(body.fact.confirmedAt).not.toBeNull()
  })

  it('confirm on a conflicting fact is a 409 fact_conflicting', async () => {
    const e = await fresh('Conflict Confirm Co')
    const a = await seedFact(db, { tenantId, entityId: e.id, documentId: docId, value: 1 })
    const b = await seedFact(db, { tenantId, entityId: e.id, documentId: docB, value: 2 })
    await linkConflict(db, tenantId, a.id, b.id)
    const res = await post(`/api/knowledge/facts/${a.id}/review`, admin, { action: 'confirm' })
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ statusCode: 409, code: 'fact_conflicting' })
  })

  it('reject: rejected and unlinked; the other side goes back to accepted', async () => {
    const e = await fresh('Reject Co')
    const a = await seedFact(db, { tenantId, entityId: e.id, documentId: docId, value: 1 })
    const b = await seedFact(db, { tenantId, entityId: e.id, documentId: docB, value: 2 })
    await linkConflict(db, tenantId, a.id, b.id)
    const res = await post(`/api/knowledge/facts/${b.id}/review`, admin, { action: 'reject' })
    expect(res.status).toBe(200)
    const body = factReviewResponseSchema.parse(await json(res))
    expect(body.fact).toMatchObject({ state: 'rejected', conflictsWith: [] })
    expect(body.affected.map(f => [f.id, f.state, f.conflictsWith])).toEqual([
      [a.id, 'accepted', []],
    ])
  })

  it('reject leaves a side that still disagrees with a third fact conflicting', async () => {
    const e = await fresh('Three Way Co')
    const a = await seedFact(db, { tenantId, entityId: e.id, documentId: docId, value: 1 })
    const b = await seedFact(db, { tenantId, entityId: e.id, documentId: docB, value: 2 })
    const c = await seedFact(db, { tenantId, entityId: e.id, documentId: docB, value: 3 })
    await linkConflict(db, tenantId, a.id, b.id, c.id)
    await post(`/api/knowledge/facts/${c.id}/review`, admin, { action: 'reject' })
    expect(await stateOf(a.id)).toBe('conflicting')
    expect(await stateOf(b.id)).toBe('conflicting')
  })

  it('reject restores an unconfirmed side as unconfirmed, a confirmed one as accepted', async () => {
    const e = await fresh('Restore Co')
    const low = await seedFact(db, {
      tenantId,
      entityId: e.id,
      documentId: docId,
      value: 1,
      confidence: 0.3,
    })
    const b = await seedFact(db, { tenantId, entityId: e.id, documentId: docB, value: 2 })
    await linkConflict(db, tenantId, low.id, b.id)
    await post(`/api/knowledge/facts/${b.id}/review`, admin, { action: 'reject' })
    expect(await stateOf(low.id)).toBe('unconfirmed')
  })

  it('prefer: accepted and confirmed; every side it conflicted with is rejected', async () => {
    const e = await fresh('Prefer Co')
    const a = await seedFact(db, {
      tenantId,
      entityId: e.id,
      documentId: docId,
      value: 1,
      reviewerUserId: reviewer.userId,
    })
    // The other sides are the reviewer's own items too: a member sets aside only those.
    const theirs = { documentId: docB, reviewerUserId: reviewer.userId }
    const b = await seedFact(db, { tenantId, entityId: e.id, ...theirs, value: 2 })
    const c = await seedFact(db, { tenantId, entityId: e.id, ...theirs, value: 3 })
    await linkConflict(db, tenantId, a.id, b.id, c.id)
    const res = await post(`/api/knowledge/facts/${a.id}/review`, reviewer, { action: 'prefer' })
    expect(res.status).toBe(200)
    const body = factReviewResponseSchema.parse(await json(res))
    expect(body.fact).toMatchObject({
      state: 'accepted',
      confirmedBy: reviewer.userId,
      conflictsWith: [],
    })
    expect(Object.fromEntries(body.affected.map(f => [f.id, f.state]))).toEqual({
      [b.id]: 'rejected',
      [c.id]: 'rejected',
    })
  })

  it('is a 403 for a member who is not the reviewer, and the envelope says so', async () => {
    const e = await fresh('Not Yours Co')
    const f = await seedFact(db, {
      tenantId,
      entityId: e.id,
      documentId: docId,
      value: 1,
      state: 'unconfirmed',
      confidence: 0.4,
      reviewerUserId: reviewer.userId,
    })
    const res = await post(`/api/knowledge/facts/${f.id}/review`, bystander, { action: 'confirm' })
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ statusCode: 403, code: 'forbidden' })
    expect(await stateOf(f.id)).toBe('unconfirmed')
  })

  it('lets an admin settle anyone’s item', async () => {
    const e = await fresh('Admin Settles Co')
    const f = await seedFact(db, {
      tenantId,
      entityId: e.id,
      documentId: docId,
      value: 1,
      state: 'unconfirmed',
      confidence: 0.4,
      reviewerUserId: reviewer.userId,
    })
    const res = await post(`/api/knowledge/facts/${f.id}/review`, admin, { action: 'reject' })
    expect(res.status).toBe(200)
  })

  it('is a 409 fact_not_reviewable on a rejected fact', async () => {
    const e = await fresh('Settled Co')
    const f = await seedFact(db, {
      tenantId,
      entityId: e.id,
      documentId: docId,
      value: 1,
      state: 'rejected',
    })
    const res = await post(`/api/knowledge/facts/${f.id}/review`, admin, { action: 'prefer' })
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ code: 'fact_not_reviewable' })
  })

  it('is a 404 for another tenant’s fact and for a non-uuid', async () => {
    const e = await fresh('Foreign Co')
    const f = await seedFact(db, { tenantId, entityId: e.id, documentId: docId, value: 1 })
    const res = await post(`/api/knowledge/facts/${f.id}/review`, outsiderTenantMember, {
      action: 'reject',
    })
    expect(res.status).toBe(404)
    expect(await stateOf(f.id)).toBe('accepted')
    expect(
      (await post('/api/knowledge/facts/nope/review', admin, { action: 'reject' })).status
    ).toBe(404)
  })
})

describe('GET /api/knowledge/entities/:type/:id', () => {
  it('answers a staging entity with every fact and its source', async () => {
    const e = await seedEntity(db, { tenantId, name: 'Card Co', aliases: ['CC'] })
    const a = await seedFact(db, { tenantId, entityId: e.id, documentId: docId, value: 10 })
    await seedFact(db, {
      tenantId,
      entityId: e.id,
      documentId: docB,
      key: 'visit_day',
      value: 'Friday',
      state: 'rejected',
    })
    const res = await get(`/api/knowledge/entities/customer/${e.id}`, bystander)
    expect(res.status).toBe(200)
    const card: EntityCard = entityCardSchema.parse(await json(res))
    // `customer` is not registered in this file, so there is nothing to promote it to.
    expect(card.entity).toMatchObject({
      kind: 'staging',
      name: 'Card Co',
      aliases: ['CC'],
      promotable: false,
    })
    expect(card.facts).toHaveLength(2)
    expect(card.facts.find(f => f.id === a.id)?.source).toMatchObject({
      documentId: docId,
      documentTitle: 'Contract 2025',
      kind: 'upload',
    })
  })

  it('is a 404 across tenants, for the wrong type, and for an unregistered domain type', async () => {
    const e = await seedEntity(db, { tenantId, name: 'Hidden Card Co' })
    await seedFact(db, { tenantId, entityId: e.id, documentId: docId, value: 1 })
    expect(
      (await get(`/api/knowledge/entities/customer/${e.id}`, outsiderTenantMember)).status
    ).toBe(404)
    expect((await get(`/api/knowledge/entities/supplier/${e.id}`, admin)).status).toBe(404)
    expect((await get('/api/knowledge/entities/no_such_type/123', admin)).status).toBe(404)
  })
})

describe('merge and keep-separate', () => {
  it('moves the facts, unions the names, and decides the shared keys again', async () => {
    const target = await seedEntity(db, { tenantId, name: 'Winter gritting (annual plan)' })
    const source = await seedEntity(db, {
      tenantId,
      name: 'Car park gritting — annual plan',
      aliases: ['gritting plan'],
      reviewerUserId: reviewer.userId,
      possibleMatches: [{ kind: 'staging', id: target.id, label: target.name, score: 0.5 }],
    })
    // price: the two disagree → a new conflict. unit: they agree → corroboration.
    // included_in_plans: only the source has it → keeps its state.
    const tPrice = await seedFact(db, {
      tenantId,
      entityId: target.id,
      entityType: 'customer',
      documentId: docId,
      key: 'price_gbp',
      value: 1140,
      observedAt: new Date('2025-01-10T09:00:00Z'),
    })
    const sPrice = await seedFact(db, {
      tenantId,
      entityId: source.id,
      documentId: docB,
      key: 'price_gbp',
      value: 1195,
      observedAt: new Date('2026-02-01T09:00:00Z'),
    })
    const tUnit = await seedFact(db, {
      tenantId,
      entityId: target.id,
      documentId: docId,
      key: 'unit',
      value: 'per site per year',
      state: 'unconfirmed',
      confidence: 0.5,
      observedAt: new Date('2025-01-10T09:00:00Z'),
    })
    await seedFact(db, {
      tenantId,
      entityId: source.id,
      documentId: docB,
      key: 'unit',
      value: 'Per site, per year',
      observedAt: new Date('2026-02-01T09:00:00Z'),
    })
    const sOnly = await seedFact(db, {
      tenantId,
      entityId: source.id,
      documentId: docB,
      key: 'included_in_plans',
      value: 'Premium',
      state: 'unconfirmed',
      confidence: 0.5,
    })

    const res = await post(`/api/knowledge/entities/${source.id}/merge`, reviewer, {
      into: { kind: 'staging', id: target.id },
    })
    expect(res.status).toBe(200)
    const body: EntityActionResponse = entityActionResponseSchema.parse(await json(res))
    expect(body).toMatchObject({
      into: { kind: 'staging', id: target.id },
      movedFacts: 3,
      recomputedKeys: ['price_gbp', 'unit'],
    })
    expect(body.entity.mergedInto).toBe(target.id)

    const facts = await db.query.knowledgeFacts.findMany({
      where: and(eq(knowledgeFacts.tenantId, tenantId), eq(knowledgeFacts.entityId, target.id)),
    })
    expect(facts).toHaveLength(5)
    const byId = new Map(facts.map(f => [f.id, f]))
    expect(byId.get(tPrice.id)).toMatchObject({ state: 'conflicting', conflictsWith: [sPrice.id] })
    expect(byId.get(sPrice.id)).toMatchObject({ state: 'conflicting', conflictsWith: [tPrice.id] })
    expect(byId.get(tUnit.id)?.state).toBe('accepted')
    expect(byId.get(sOnly.id)?.state).toBe('unconfirmed')

    const merged = await db.query.knowledgeEntities.findFirst({
      where: and(eq(knowledgeEntities.tenantId, tenantId), eq(knowledgeEntities.id, target.id)),
    })
    expect(merged?.aliases).toEqual(['Car park gritting — annual plan', 'gritting plan'])

    // Settled: no longer a review item, and a second merge is a 409.
    const list = await review('/api/knowledge/review?kind=possibleMatch&pageSize=200', reviewer)
    expect(list.items.some(i => i.kind === 'possibleMatch' && i.entity.id === source.id)).toBe(
      false
    )
    const again = await post(`/api/knowledge/entities/${source.id}/merge`, reviewer, {
      into: { kind: 'staging', id: target.id },
    })
    expect(again.status).toBe(409)
    expect(await json(again)).toMatchObject({ code: 'entity_settled' })
  })

  it('refuses another type, itself, another tenant’s target, and a non-reviewer', async () => {
    const supplier = await seedEntity(db, { tenantId, name: 'Grit Supplier', type: 'supplier' })
    await seedFact(db, {
      tenantId,
      entityId: supplier.id,
      entityType: 'supplier',
      documentId: docId,
      value: 1,
    })
    const foreign = await seedEntity(db, { tenantId: otherTenantId, name: 'Foreign target' })
    const source = await seedEntity(db, {
      tenantId,
      name: 'Merge Guard Co',
      reviewerUserId: reviewer.userId,
    })
    await seedFact(db, { tenantId, entityId: source.id, documentId: docId, value: 1 })
    for (const into of [
      { kind: 'staging', id: supplier.id },
      { kind: 'staging', id: source.id },
      { kind: 'staging', id: foreign.id },
    ]) {
      const res = await post(`/api/knowledge/entities/${source.id}/merge`, reviewer, { into })
      expect(res.status).toBe(400)
      expect(await json(res)).toMatchObject({ code: 'entity_target_not_found' })
    }
    const res = await post(`/api/knowledge/entities/${source.id}/merge`, bystander, {
      into: { kind: 'staging', id: supplier.id },
    })
    expect(res.status).toBe(403)
  })

  it('promote on an unregistered type is a 400 entity_type_not_promotable', async () => {
    const source = await seedEntity(db, { tenantId, name: 'Promote Me Co' })
    await seedFact(db, { tenantId, entityId: source.id, documentId: docId, value: 1 })
    const res = await post(`/api/knowledge/entities/${source.id}/promote`, admin, { id: 'row-1' })
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ code: 'entity_type_not_promotable' })
  })

  it('keep-separate closes the possible match and nothing moves', async () => {
    const other = await seedEntity(db, { tenantId, name: 'Separate Co' })
    const source = await seedEntity(db, {
      tenantId,
      name: 'Separate Co Ltd',
      reviewerUserId: reviewer.userId,
      possibleMatches: [{ kind: 'staging', id: other.id, label: other.name, score: 0.5 }],
    })
    await seedFact(db, { tenantId, entityId: source.id, documentId: docId, value: 1 })
    const res = await post(`/api/knowledge/entities/${source.id}/keep-separate`, reviewer)
    expect(res.status).toBe(200)
    const body = entityActionResponseSchema.parse(await json(res))
    expect(body).toMatchObject({ into: null, movedFacts: 0 })
    const row = await db.query.knowledgeEntities.findFirst({
      where: and(eq(knowledgeEntities.tenantId, tenantId), eq(knowledgeEntities.id, source.id)),
    })
    expect(row?.possibleMatches).toBeNull()
    expect(row?.mergedInto).toBeNull()
  })
})

describe('the realtime nudge', () => {
  const nudgesFor = (id: string) =>
    stubs(env)
      .hub.broadcasts.filter(b => b.tenantId === tenantId)
      .filter(b => b.args[0] === 'broadcast')
      .map(b => b.args[1] as { type: string; payload?: { entity?: string; id?: string } })
      .filter(e => e.payload?.id === id)

  it('a review action nudges entity.changed { entity: knowledge, id } tenant-wide', async () => {
    const entity = await seedEntity(db, { tenantId, name: 'Nudge Bakery' })
    const fact = await seedFact(db, {
      tenantId,
      entityId: entity.id,
      documentId: docId,
      value: 7,
      state: 'unconfirmed',
      confidence: 0.4,
      reviewerUserId: reviewer.userId,
    })
    const res = await post(`/api/knowledge/facts/${fact.id}/review`, reviewer, {
      action: 'confirm',
    })
    expect(res.status).toBe(200)
    expect(nudgesFor(fact.id)).toEqual([
      expect.objectContaining({
        type: 'entity.changed',
        payload: { entity: 'knowledge', id: fact.id },
      }),
    ])
  })

  it('merge and keep-separate nudge with the entity id; a refused action sends nothing', async () => {
    const target = await seedEntity(db, { tenantId, name: 'Nudge Target' })
    // A fact the reviewer can see, so the target is visible to them.
    await seedFact(db, { tenantId, entityId: target.id, documentId: docId, value: 2 })
    const merged = await seedEntity(db, {
      tenantId,
      name: 'Nudge Target Ltd',
      reviewerUserId: reviewer.userId,
      possibleMatches: [{ kind: 'staging', id: target.id, label: target.name, score: 0.5 }],
    })
    await seedFact(db, { tenantId, entityId: merged.id, documentId: docId, value: 1 })
    const res = await post(`/api/knowledge/entities/${merged.id}/merge`, reviewer, {
      into: { kind: 'staging', id: target.id },
    })
    expect(res.status).toBe(200)
    expect(nudgesFor(merged.id)).toHaveLength(1)

    const separate = await seedEntity(db, {
      tenantId,
      name: 'Nudge Apart',
      reviewerUserId: reviewer.userId,
      possibleMatches: [{ kind: 'staging', id: target.id, label: target.name, score: 0.5 }],
    })
    await seedFact(db, { tenantId, entityId: separate.id, documentId: docId, value: 1 })
    // Somebody else's item first: a 403, and no nudge.
    expect(
      (await post(`/api/knowledge/entities/${separate.id}/keep-separate`, bystander)).status
    ).toBe(403)
    expect(nudgesFor(separate.id)).toEqual([])
    expect(
      (await post(`/api/knowledge/entities/${separate.id}/keep-separate`, reviewer)).status
    ).toBe(200)
    expect(nudgesFor(separate.id)).toHaveLength(1)
  })
})
