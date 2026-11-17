// @vitest-isolate
// Mocks the knowledge entity-type registry (a type backed by a real table), so it needs its own registry.
/**
 * `POST /api/knowledge/entities/:id/promote` and merge-into-a-domain-row (D43): a staging entity
 * becomes a row of its registered type — `promoted_type` / `promoted_id` recorded, its facts moved
 * onto the row and the shared keys decided again — and NO domain column written. The registered
 * type here is `team`, backed by the kit's own `groups` table (`labelColumn: groups.name`), so the
 * row is real and tenant-scoped without a fixture table. Then the domain row's entity card, and
 * `lookup_facts` finding the row by the staging entity's old name.
 */
import {
  entityActionResponseSchema,
  entityCardSchema,
} from '@rocketflare/shared/ai/knowledge-facts'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { buildAgentTools } from '@/api/services/agents/tools'
import { setTenantOverride } from '@/api/services/features'
import type { EntityTypeRegistration } from '@/api/services/knowledge/types'
import { loadConfig } from '@/config'
import { groups, groupTypes, knowledgeEntities, knowledgeFacts } from '@/db/schema'
import {
  createTestSession,
  createTestTenant,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { seedDocument, seedEntity, seedFact } from '../helpers/knowledge-facts'
import { json, request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

const team: EntityTypeRegistration = {
  type: 'team',
  label: 'Team',
  table: groups,
  labelColumn: groups.name,
  facts: z.object({ monthly_fee_gbp: z.number(), visit_day: z.string() }),
}

vi.mock('@/api/services/knowledge/registry', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/knowledge/registry')>()
  return {
    ...actual,
    knowledgeEntityTypes: () => [team],
    knowledgeEntityType: (type: string) => (type === 'team' ? team : undefined),
  }
})

const db = setupTestDatabase()
const env = createTestEnv()
const cfg = loadConfig(env)

let tenantId: string
let groupTypeId: string
let adminCookie: Record<string, string>
let adminId: string
let docId: string

const post = (path: string, body: unknown) =>
  request(path, { method: 'POST', headers: adminCookie }, { env, json: body })

async function teamRow(tenant: string, typeId: string, name: string) {
  const [row] = await db
    .insert(groups)
    .values({ tenantId: tenant, groupTypeId: typeId, name })
    .returning()
  if (!row) throw new Error('no group')
  return row
}

beforeAll(async () => {
  tenantId = (await createTestTenant(db)).id
  const user = await createTestUser(db)
  adminId = user.id
  await linkUserToTenant(db, user.id, tenantId, 'admin')
  adminCookie = sessionCookieHeader(await createTestSession(db, user.id, tenantId))
  await setTenantOverride(db, 'knowledge-facts', tenantId, true, user.id)
  const [type] = await db.insert(groupTypes).values({ tenantId, name: 'Customers' }).returning()
  groupTypeId = type?.id ?? ''
  docId = (await seedDocument(db, { tenantId, title: 'Contract' })).id
})

describe('promote', () => {
  it('records promotedTo, moves the facts, decides shared keys, and writes no domain column', async () => {
    const row = await teamRow(tenantId, groupTypeId, 'Brightside Bakery Ltd')
    const held = await seedFact(db, {
      tenantId,
      entityKind: 'domain',
      entityType: 'team',
      entityId: row.id,
      documentId: docId,
      value: 100,
      observedAt: new Date('2025-01-01T00:00:00Z'),
    })
    const staging = await seedEntity(db, { tenantId, type: 'team', name: 'Brightside' })
    const moved = await seedFact(db, {
      tenantId,
      entityType: 'team',
      entityId: staging.id,
      documentId: docId,
      value: 120,
      observedAt: new Date('2026-01-01T00:00:00Z'),
    })

    const res = await post(`/api/knowledge/entities/${staging.id}/promote`, { id: row.id })
    expect(res.status).toBe(200)
    const body = entityActionResponseSchema.parse(await json(res))
    expect(body).toMatchObject({
      entity: { promotedTo: { type: 'team', id: row.id } },
      into: { kind: 'domain', type: 'team', id: row.id },
      movedFacts: 1,
      recomputedKeys: ['monthly_fee_gbp'],
    })

    const facts = await db.query.knowledgeFacts.findMany({
      where: and(eq(knowledgeFacts.tenantId, tenantId), eq(knowledgeFacts.entityId, row.id)),
    })
    expect(new Map(facts.map(f => [f.id, f.state]))).toEqual(
      new Map([
        [held.id, 'conflicting'],
        [moved.id, 'conflicting'],
      ])
    )
    expect(facts.every(f => f.entityKind === 'domain')).toBe(true)
    // The domain row is untouched.
    const after = await db.query.groups.findFirst({ where: eq(groups.id, row.id) })
    expect(after?.name).toBe('Brightside Bakery Ltd')

    // The row's card: its label, the staging name as an alias, both facts.
    const card = entityCardSchema.parse(
      await json(
        await request(`/api/knowledge/entities/team/${row.id}`, { headers: adminCookie }, { env })
      )
    )
    expect(card.entity).toMatchObject({
      kind: 'domain',
      typeLabel: 'Team',
      name: 'Brightside Bakery Ltd',
      aliases: ['Brightside'],
    })
    expect(card.facts).toHaveLength(2)

    // lookup_facts finds the row by the staging entity's name.
    const tools = await buildAgentTools({
      db,
      cfg,
      env,
      scope: { tenantId, userId: adminId, groupIds: [], bypass: true },
      features: ['knowledge-facts'],
    })
    const lookup = tools.find(t => t.name === 'lookup_facts')
    const result = JSON.parse((await lookup?.handler?.({ entity: 'Brightside' } as never)) ?? '{}')
    expect(result.entities[0].entity).toMatchObject({ kind: 'domain', type: 'team', id: row.id })
    expect(result.entities[0].facts).toHaveLength(2)
  })

  it('merge into a domain row is a promote', async () => {
    const row = await teamRow(tenantId, groupTypeId, 'Harbour View Dental')
    const staging = await seedEntity(db, { tenantId, type: 'team', name: 'HVD' })
    const res = await post(`/api/knowledge/entities/${staging.id}/merge`, {
      into: { kind: 'domain', id: row.id },
    })
    expect(res.status).toBe(200)
    const entity = await db.query.knowledgeEntities.findFirst({
      where: and(eq(knowledgeEntities.tenantId, tenantId), eq(knowledgeEntities.id, staging.id)),
    })
    expect(entity).toMatchObject({ promotedType: 'team', promotedId: row.id, mergedInto: null })
  })

  it('refuses a row that does not exist, or exists in another tenant', async () => {
    const other = await createTestTenant(db)
    const [otherType] = await db
      .insert(groupTypes)
      .values({ tenantId: other.id, name: 'Customers' })
      .returning()
    const foreign = await teamRow(other.id, otherType?.id ?? '', 'Foreign Bakery')
    const staging = await seedEntity(db, { tenantId, type: 'team', name: 'Foreign Bakery' })
    for (const id of [crypto.randomUUID(), foreign.id]) {
      const res = await post(`/api/knowledge/entities/${staging.id}/promote`, { id })
      expect(res.status).toBe(400)
      expect(await json(res)).toMatchObject({ statusCode: 400, code: 'entity_target_not_found' })
    }
    const row = await db.query.knowledgeEntities.findFirst({
      where: and(eq(knowledgeEntities.tenantId, tenantId), eq(knowledgeEntities.id, staging.id)),
    })
    expect(row?.promotedId).toBeNull()
  })
})
