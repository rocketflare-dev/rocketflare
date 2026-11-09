/**
 * Re-ingesting an item under the same external id replaces its text, its grants and its searchable
 * copy together: while the re-index is pending or after it fails, search finds the new text or
 * nothing, never the revision that was replaced.
 */
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { accessScopeForUser } from '@/api/services/access'
import { ingestText } from '@/api/services/ai/ingest'
import { searchChunks } from '@/api/services/ai/retrieval'
import { loadConfig } from '@/config'
import { chunks } from '@/db/schema'
import { createTestTenant, createTestUser, linkUserToTenant } from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { createTestEnv, stubs } from '../../mocks/bindings'

const db = setupTestDatabase()
const env = createTestEnv()
const cfg = loadConfig(env)
const { ai, queue } = stubs(env)
if (!ai) throw new Error('the test env has no AI stub')

const OLD_TEXT = 'First revision: quarterly bonus pool allocation for the owner only.'
const NEW_TEXT = 'Second revision: the team lunch is on Thursday.'
const SOURCE = 'test:mail'

let tenantId: string
let ownerId: string
let otherId: string

beforeAll(async () => {
  tenantId = (await createTestTenant(db)).id
  const owner = await createTestUser(db)
  const other = await createTestUser(db)
  await linkUserToTenant(db, owner.id, tenantId, 'member')
  await linkUserToTenant(db, other.id, tenantId, 'member')
  ownerId = owner.id
  otherId = other.id
})

async function restrictedItem(externalId: string) {
  const { document } = await ingestText(db, cfg, env, {
    tenantId,
    userId: ownerId,
    title: 'Restricted',
    text: OLD_TEXT,
    source: SOURCE,
    externalId,
    visibility: 'groups',
    groupIds: [],
  })
  expect(document.status).toBe('indexed')
  return document.id
}

async function otherMemberSees(documentId: string): Promise<string> {
  const scope = await accessScopeForUser(db, tenantId, otherId)
  const hits = await searchChunks(db, cfg, env, scope, {
    query: 'bonus pool allocation',
    limit: 10,
    documentId,
  })
  return hits.map(h => h.text).join('\n')
}

async function storedChunks(id: string) {
  const rows = await db
    .select({ text: chunks.text })
    .from(chunks)
    .where(and(eq(chunks.tenantId, tenantId), eq(chunks.documentId, id)))
  return rows.map(r => r.text).join('\n')
}

describe('an external-id re-ingest', () => {
  it('removes the replaced text when the re-index fails', async () => {
    const id = await restrictedItem('failed')
    const previous = ai.respond
    ai.respond = (model, inputs) => {
      if (Array.isArray(inputs.text)) throw new Error('embeddings unavailable')
      return previous(model, inputs)
    }
    try {
      const { document } = await ingestText(db, cfg, env, {
        tenantId,
        userId: ownerId,
        title: 'Lunch',
        text: NEW_TEXT,
        source: SOURCE,
        externalId: 'failed',
      })
      expect(document).toMatchObject({ id, status: 'failed', visibility: 'tenant' })
    } finally {
      ai.respond = previous
    }
    expect(await otherMemberSees(id)).not.toContain('bonus pool')
    expect(await storedChunks(id)).not.toContain('bonus pool')
  })

  it('removes the replaced text while the re-index is queued', async () => {
    const id = await restrictedItem('queued')
    const paragraph = 'The team lunch is on Thursday and everyone is welcome to attend it. '
    const large = Array.from({ length: 220 }, () => paragraph.repeat(12)).join('\n\n')
    const before = queue.messages.length
    const { document, mode } = await ingestText(
      db,
      cfg,
      env,
      {
        tenantId,
        userId: ownerId,
        title: 'Lunch',
        text: large,
        source: SOURCE,
        externalId: 'queued',
      },
      { jobs: env.JOBS_QUEUE }
    )
    expect(mode).toBe('queued')
    expect(document).toMatchObject({ id, status: 'pending', visibility: 'tenant' })
    expect(queue.messages.length).toBe(before + 1)
    expect(await otherMemberSees(id)).not.toContain('bonus pool')
    expect(await storedChunks(id)).not.toContain('bonus pool')
  })

  it('replaces the chunks when the re-index succeeds', async () => {
    const id = await restrictedItem('indexed')
    const { document } = await ingestText(db, cfg, env, {
      tenantId,
      userId: ownerId,
      title: 'Lunch',
      text: NEW_TEXT,
      source: SOURCE,
      externalId: 'indexed',
    })
    expect(document).toMatchObject({ id, status: 'indexed' })
    expect(await storedChunks(id)).toContain('team lunch')
    expect(await storedChunks(id)).not.toContain('bonus pool')
  })
})
