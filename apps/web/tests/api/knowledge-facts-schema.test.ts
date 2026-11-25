/**
 * The delete semantics of the knowledge facts tables (D43), against the real catalog:
 *
 * - deleting a DOCUMENT removes the facts read from it (`document_id` cascades);
 * - re-indexing replaces chunks, and a fact SURVIVES that — its `chunk_id` goes null, its span and
 *   quote stay (`chunk_id` is SET NULL);
 * - deleting the last fact about a staging entity leaves the entity (no trigger);
 * - `pg_trgm` is installed, and the trigram index on `knowledge_entities.name` answers `%`.
 */
import { EMBEDDING_DIM } from '@rocketflare/shared/ai/config'
import { and, eq, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { rows } from '@/db/client'
import { chunks, documents, knowledgeEntities, knowledgeFacts } from '@/db/schema'
import { createTestTenant } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'

const db = setupTestDatabase()
const embedding = Array.from({ length: EMBEDDING_DIM }, (_, i) => (i === 0 ? 1 : 0))

let tenantId: string

async function documentWithChunk(title: string) {
  const [doc] = await db
    .insert(documents)
    .values({ tenantId, title, contentType: 'text/plain', content: 'Delivery on 3 March.' })
    .returning()
  if (!doc) throw new Error('no document')
  const [chunk] = await db
    .insert(chunks)
    .values({ tenantId, documentId: doc.id, seq: 0, text: 'Delivery on 3 March.', embedding })
    .returning()
  if (!chunk) throw new Error('no chunk')
  return { doc, chunk }
}

async function stagingEntity(name: string) {
  const [entity] = await db
    .insert(knowledgeEntities)
    .values({ tenantId, type: 'customer', name, aliases: ['BSB'] })
    .returning()
  if (!entity) throw new Error('no entity')
  return entity
}

async function factOn(entityId: string, documentId: string, chunkId: string | null) {
  const [fact] = await db
    .insert(knowledgeFacts)
    .values({
      tenantId,
      entityKind: 'staging',
      entityType: 'customer',
      entityId,
      key: 'delivery_date',
      value: '2026-03-03',
      valueText: '3 March 2026',
      documentId,
      chunkId,
      charStart: 0,
      charEnd: 20,
      quote: 'Delivery on 3 March.',
      sourceKind: 'upload',
      confidence: 0.9,
      state: 'accepted',
    })
    .returning()
  if (!fact) throw new Error('no fact')
  return fact
}

beforeAll(async () => {
  tenantId = (await createTestTenant(db)).id
})

describe('knowledge_facts deletes', () => {
  it('a re-index (chunks replaced) keeps the fact, with chunk_id null and the span intact', async () => {
    const { doc, chunk } = await documentWithChunk('Contract')
    const entity = await stagingEntity('Brightside Bakery')
    const fact = await factOn(entity.id, doc.id, chunk.id)
    await db.delete(chunks).where(eq(chunks.documentId, doc.id))
    const [after] = await db.select().from(knowledgeFacts).where(eq(knowledgeFacts.id, fact.id))
    expect(after).toMatchObject({ chunkId: null, charStart: 0, charEnd: 20, documentId: doc.id })
  })

  it('deleting the document removes its facts but leaves the staging entity', async () => {
    const { doc, chunk } = await documentWithChunk('Call notes')
    const entity = await stagingEntity('Harbour Cafe')
    const fact = await factOn(entity.id, doc.id, chunk.id)
    await db.delete(documents).where(eq(documents.id, doc.id))
    const facts = await db.select().from(knowledgeFacts).where(eq(knowledgeFacts.id, fact.id))
    expect(facts).toEqual([])
    const entities = await db
      .select()
      .from(knowledgeEntities)
      .where(and(eq(knowledgeEntities.tenantId, tenantId), eq(knowledgeEntities.id, entity.id)))
    expect(entities).toHaveLength(1)
  })

  it('refuses a confidence outside [0, 1]', async () => {
    const { doc } = await documentWithChunk('Bad confidence')
    const entity = await stagingEntity('Out of range')
    await expect(
      db.insert(knowledgeFacts).values({
        tenantId,
        entityKind: 'staging',
        entityType: 'customer',
        entityId: entity.id,
        key: 'x',
        value: 1,
        valueText: '1',
        documentId: doc.id,
        quote: 'q',
        sourceKind: 'agent',
        confidence: 1.5,
        state: 'unconfirmed',
      })
    ).rejects.toThrow()
  })
})

describe('pg_trgm', () => {
  it('is installed and the trigram operator matches a near spelling', async () => {
    const ext = rows<{ extname: string }>(
      await db.execute(sql`select extname from pg_extension where extname = 'pg_trgm'`)
    )
    expect(ext).toHaveLength(1)
    const entity = await stagingEntity('Brightside Bakery Ltd')
    const found = await db
      .select({ id: knowledgeEntities.id })
      .from(knowledgeEntities)
      .where(
        and(
          eq(knowledgeEntities.tenantId, tenantId),
          sql`${knowledgeEntities.name} % ${'Brightside Bakery'}`
        )
      )
    expect(found.map(r => r.id)).toContain(entity.id)
  })
})
