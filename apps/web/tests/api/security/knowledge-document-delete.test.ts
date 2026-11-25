/**
 * Deleting a document undoes what its facts did to the rest: a fact one of them superseded is
 * current again, and a fact that conflicted only with one of them is no longer conflicting —
 * whether a person deletes it (`DELETE /api/ai/documents/:id`) or a connector reports the item
 * gone upstream (`deleteExternalDocument`).
 */
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { deleteExternalDocument } from '@/api/services/ai/ingest'
import { setTenantOverride } from '@/api/services/features'
import { documents, knowledgeFacts } from '@/db/schema'
import {
  createTestSession,
  createTestTenant,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { linkConflict, seedDocument, seedEntity, seedFact } from '../../helpers/knowledge-facts'
import { request } from '../../helpers/request'
import { createTestEnv } from '../../mocks/bindings'

const db = setupTestDatabase()
const env = createTestEnv()

async function twoDocuments() {
  const tenantId = (await createTestTenant(db)).id
  const owner = await createTestUser(db)
  await linkUserToTenant(db, owner.id, tenantId, 'owner')
  await setTenantOverride(db, 'knowledge-facts', tenantId, true, owner.id)
  const cookie = sessionCookieHeader(await createTestSession(db, owner.id, tenantId))
  const kept = await seedDocument(db, { tenantId, title: 'Contract', ownerUserId: owner.id })
  const deleted = await seedDocument(db, { tenantId, title: 'Later note', ownerUserId: owner.id })
  const entity = await seedEntity(db, { tenantId, name: 'Harbour Bakery' })
  return { tenantId, cookie, kept, deleted, entity }
}

async function factRow(id: string) {
  const [row] = await db.select().from(knowledgeFacts).where(eq(knowledgeFacts.id, id))
  return row
}

const deleteViaRoute = (id: string, cookie: Record<string, string>) =>
  request(`/api/ai/documents/${id}`, { method: 'DELETE', headers: cookie }, { env })

describe('deleting a document through the API', () => {
  it('makes a fact it superseded current again', async () => {
    const { tenantId, cookie, kept, deleted, entity } = await twoDocuments()
    const older = await seedFact(db, {
      tenantId,
      entityId: entity.id,
      documentId: kept.id,
      value: 285,
    })
    const newer = await seedFact(db, {
      tenantId,
      entityId: entity.id,
      documentId: deleted.id,
      value: 310,
    })
    await db
      .update(knowledgeFacts)
      .set({ state: 'superseded', supersededById: newer.id })
      .where(eq(knowledgeFacts.id, older.id))

    expect((await deleteViaRoute(deleted.id, cookie)).status).toBe(204)
    expect(await factRow(newer.id)).toBeUndefined()
    expect(await factRow(older.id)).toMatchObject({ state: 'accepted', supersededById: null })
  })

  it('ends a conflict whose only other side came from it', async () => {
    const { tenantId, cookie, kept, deleted, entity } = await twoDocuments()
    const held = await seedFact(db, {
      tenantId,
      entityId: entity.id,
      documentId: kept.id,
      value: 285,
    })
    const other = await seedFact(db, {
      tenantId,
      entityId: entity.id,
      documentId: deleted.id,
      value: 310,
    })
    await linkConflict(db, tenantId, held.id, other.id)

    expect((await deleteViaRoute(deleted.id, cookie)).status).toBe(204)
    expect(await factRow(held.id)).toMatchObject({ state: 'accepted', conflictsWith: [] })
  })
})

describe('deleting a document a connector reports gone upstream', () => {
  it('repairs the facts the same way', async () => {
    const { tenantId, kept, deleted, entity } = await twoDocuments()
    await db
      .update(documents)
      .set({ source: 'test:drive', externalId: 'item-1' })
      .where(eq(documents.id, deleted.id))
    const superseded = await seedFact(db, {
      tenantId,
      entityId: entity.id,
      documentId: kept.id,
      value: 285,
    })
    const conflicting = await seedFact(db, {
      tenantId,
      entityId: entity.id,
      key: 'contract_start',
      documentId: kept.id,
      value: '2026-01-01',
    })
    const newer = await seedFact(db, {
      tenantId,
      entityId: entity.id,
      documentId: deleted.id,
      value: 310,
    })
    const rival = await seedFact(db, {
      tenantId,
      entityId: entity.id,
      key: 'contract_start',
      documentId: deleted.id,
      value: '2026-02-01',
    })
    await db
      .update(knowledgeFacts)
      .set({ state: 'superseded', supersededById: newer.id })
      .where(eq(knowledgeFacts.id, superseded.id))
    await linkConflict(db, tenantId, conflicting.id, rival.id)

    expect(
      await deleteExternalDocument(db, { tenantId, source: 'test:drive', externalId: 'item-1' })
    ).toBe(true)
    expect(await factRow(superseded.id)).toMatchObject({ state: 'accepted', supersededById: null })
    expect(await factRow(conflicting.id)).toMatchObject({ state: 'accepted', conflictsWith: [] })
  })
})
