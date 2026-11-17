/**
 * The plugin's knowledge entity type (D43): `example-feature.note` is a valid registration, and
 * the kit's DEFAULT resolver — what a type with a table and no `resolve` gets — finds a note by its
 * title inside the reader's tenant and never another organisation's note with the same title.
 *
 * It drives the real resolver against the real database: only that proves the tenant predicate.
 */
import { entityTypeSchema } from '@rocketflare/shared/ai/knowledge-facts'
import { createTestTenant, setupTestDatabase } from '@testkit/integration'
import { beforeAll, describe, expect, it } from 'vitest'
import { type AccessScope, defaultEntityResolver } from '@/plugins/api'
import { exampleNotes } from '../../db/schema'
import { EXAMPLE_NOTE_ENTITY_TYPE, exampleNoteEntityType } from '../../knowledge/entity-types'

const db = setupTestDatabase()

let tenantId: string
let otherTenantId: string
let kitchenId: string
let otherKitchenId: string

function scopeOf(tenant: string): { db: typeof db; access: AccessScope; limit: number } {
  return { db, access: { tenantId: tenant, userId: null, groupIds: [], bypass: true }, limit: 5 }
}

beforeAll(async () => {
  tenantId = (await createTestTenant(db)).id
  otherTenantId = (await createTestTenant(db)).id
  const [kitchen] = await db
    .insert(exampleNotes)
    .values([
      { tenantId, title: 'Kitchen refit at Brightside' },
      { tenantId, title: 'Quarterly invoice run' },
    ])
    .returning({ id: exampleNotes.id })
  const [other] = await db
    .insert(exampleNotes)
    .values({ tenantId: otherTenantId, title: 'Kitchen refit at Brightside' })
    .returning({ id: exampleNotes.id })
  if (!kitchen || !other) throw new Error('fixture notes were not inserted')
  kitchenId = kitchen.id
  otherKitchenId = other.id
})

describe('example-feature.note', () => {
  it('is a valid, namespaced registration over the plugin’s own table', () => {
    expect(EXAMPLE_NOTE_ENTITY_TYPE.startsWith('example-feature.')).toBe(true)
    expect(entityTypeSchema.safeParse(exampleNoteEntityType).success).toBe(true)
    expect(Object.keys(exampleNoteEntityType.facts.shape)).toEqual(['due_date', 'contact_name'])
  })

  it('the default resolver finds the note by a near spelling of its title', async () => {
    const resolve = defaultEntityResolver(exampleNoteEntityType)
    const found = await resolve('kitchen refit brightside', scopeOf(tenantId))
    expect(found[0]).toMatchObject({ id: kitchenId, label: 'Kitchen refit at Brightside' })
    expect(found[0]?.score).toBeGreaterThan(0.5)
    expect(found.map(c => c.id)).not.toContain(otherKitchenId)
  })

  it('never answers with another tenant’s note, and finds nothing for an unrelated name', async () => {
    const resolve = defaultEntityResolver(exampleNoteEntityType)
    const other = await resolve('Kitchen refit at Brightside', scopeOf(otherTenantId))
    expect(other.map(c => c.id)).toEqual([otherKitchenId])
    expect(await resolve('zzzz qqqq', scopeOf(tenantId))).toEqual([])
    expect(await resolve('   ', scopeOf(tenantId))).toEqual([])
  })
})
