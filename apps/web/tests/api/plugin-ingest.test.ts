/**
 * Knowledge ingest on the plugin surface (D34), against real Postgres:
 * `ingestDocument` / `ingestDocumentFile` / `deleteIngestedDocument` with an `externalId` — a second
 * ingest of the same `(tenant, source, externalId)` UPDATES the row (text, owner, grants, chunks,
 * the stored original) instead of adding one; another source or tenant may reuse the id; delete
 * removes the row, its chunks and its stored original; a foreign group id is refused before
 * anything is written; an unreadable type is a 415.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { chunks, documentGroups, documents, files, groups, groupTypes } from '@/db/schema'
import { deleteIngestedDocument, ingestDocument, ingestDocumentFile } from '@/plugins/api'
import { createTestTenant, createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { makeJobCtx } from '../kit/unit'
import { createTestEnv, stubs } from '../mocks/bindings'

const db = setupTestDatabase()

async function aGroup(tenantId: string, name: string) {
  const [type] = await db
    .insert(groupTypes)
    .values({ tenantId, name: `Type ${name}` })
    .returning()
  const [group] = await db
    .insert(groups)
    .values({ tenantId, groupTypeId: type?.id as string, name })
    .returning()
  return group?.id as string
}

async function docsFor(tenantId: string, source: string) {
  return db
    .select()
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), eq(documents.source, source)))
}

describe('ingestDocument with an externalId', () => {
  it('updates the same row on a second ingest — text, owner, grants and chunks all move', async () => {
    const { tenant, user } = await createTestTenantWithUser(db, 'member')
    const finance = await aGroup(tenant.id, 'Finance')
    const ops = await aGroup(tenant.id, 'Ops')
    const ctx = makeJobCtx({ db })

    const first = await ingestDocument(ctx, {
      tenantId: tenant.id,
      userId: null,
      source: 'orders:mail',
      externalId: 'msg-1',
      title: 'Quote',
      text: 'The first version of the quote.',
      visibility: 'groups',
      groupIds: [finance],
    })
    expect(first).toMatchObject({ mode: 'inline', status: 'indexed' })

    const second = await ingestDocument(ctx, {
      tenantId: tenant.id,
      userId: user.id,
      source: 'orders:mail',
      externalId: 'msg-1',
      title: 'Quote (revised)',
      text: 'The second version of the quote, which is quite different.',
      visibility: 'groups',
      groupIds: [ops],
    })
    expect(second.documentId).toBe(first.documentId)

    const rows = await docsFor(tenant.id, 'orders:mail')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      title: 'Quote (revised)',
      ownerUserId: user.id,
      externalId: 'msg-1',
      status: 'indexed',
    })
    const grants = await db
      .select({ groupId: documentGroups.groupId })
      .from(documentGroups)
      .where(eq(documentGroups.documentId, first.documentId))
    expect(grants.map(g => g.groupId)).toEqual([ops])
    const texts = await db
      .select({ text: chunks.text })
      .from(chunks)
      .where(eq(chunks.documentId, first.documentId))
    expect(texts.map(t => t.text).join(' ')).toContain('second version')
    expect(texts.map(t => t.text).join(' ')).not.toContain('first version')
  })

  it('lets another source reuse the id, and never collides across tenants', async () => {
    const a = await createTestTenant(db)
    const b = await createTestTenant(db)
    const ctx = makeJobCtx({ db })
    const base = { userId: null, externalId: 'item-7', title: 'Seven', text: 'Seven.' }
    const mail = await ingestDocument(ctx, { ...base, tenantId: a.id, source: 'orders:mail' })
    const drive = await ingestDocument(ctx, { ...base, tenantId: a.id, source: 'orders:drive' })
    const other = await ingestDocument(ctx, { ...base, tenantId: b.id, source: 'orders:mail' })
    expect(new Set([mail.documentId, drive.documentId, other.documentId]).size).toBe(3)
  })

  it('refuses another organisation’s group before writing anything', async () => {
    const mine = await createTestTenant(db)
    const theirs = await createTestTenant(db)
    const foreign = await aGroup(theirs.id, 'Theirs')
    await expect(
      ingestDocument(makeJobCtx({ db }), {
        tenantId: mine.id,
        userId: null,
        source: 'orders:mail',
        externalId: 'x',
        title: 'x',
        text: 'x',
        visibility: 'groups',
        groupIds: [foreign],
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'group_not_found' })
    expect(await docsFor(mine.id, 'orders:mail')).toHaveLength(0)
  })

  it('deletes the row, its chunks and nothing else', async () => {
    const tenant = await createTestTenant(db)
    const ctx = makeJobCtx({ db })
    const kept = await ingestDocument(ctx, {
      tenantId: tenant.id,
      userId: null,
      source: 'orders:mail',
      externalId: 'keep',
      title: 'Keep',
      text: 'Keep me.',
    })
    const gone = await ingestDocument(ctx, {
      tenantId: tenant.id,
      userId: null,
      source: 'orders:mail',
      externalId: 'gone',
      title: 'Gone',
      text: 'Delete me.',
    })
    const target = { tenantId: tenant.id, source: 'orders:mail', externalId: 'gone' }
    expect(await deleteIngestedDocument(ctx, target)).toBe(true)
    expect(await deleteIngestedDocument(ctx, target)).toBe(false)
    const left = await docsFor(tenant.id, 'orders:mail')
    expect(left.map(d => d.id)).toEqual([kept.documentId])
    expect(
      await db.select().from(chunks).where(eq(chunks.documentId, gone.documentId))
    ).toHaveLength(0)
  })
})

describe('ingestDocumentFile with an externalId', () => {
  it('replaces the stored original on a re-ingest, and delete removes it', async () => {
    const { tenant, user } = await createTestTenantWithUser(db, 'member')
    const env = createTestEnv()
    const ctx = makeJobCtx({ db, env })
    const input = {
      tenantId: tenant.id,
      userId: user.id,
      source: 'orders:drive',
      externalId: 'file-1',
      filename: 'notes.md',
    }
    const first = await ingestDocumentFile(ctx, {
      ...input,
      file: new Blob(['# One\n\nFirst draft.'], { type: 'text/markdown' }),
    })
    const [before] = await docsFor(tenant.id, 'orders:drive')
    const second = await ingestDocumentFile(ctx, {
      ...input,
      file: new Blob(['# Two\n\nSecond draft.'], { type: 'text/markdown' }),
    })
    expect(second.documentId).toBe(first.documentId)
    const [after] = await docsFor(tenant.id, 'orders:drive')
    expect(after?.fileId).not.toBe(before?.fileId)
    expect(after?.content).toContain('Second draft')
    // The first original is gone from both the table and the bucket; only the second remains.
    const stored = await db.select().from(files).where(eq(files.tenantId, tenant.id))
    expect(stored.map(f => f.id)).toEqual([after?.fileId])
    expect(stubs(env).files.objects.size).toBe(1)

    await deleteIngestedDocument(ctx, {
      tenantId: tenant.id,
      source: 'orders:drive',
      externalId: 'file-1',
    })
    expect(await db.select().from(files).where(eq(files.tenantId, tenant.id))).toHaveLength(0)
    expect(stubs(env).files.objects.size).toBe(0)
  })

  it('answers 415 for a type the knowledge base cannot read', async () => {
    const { tenant, user } = await createTestTenantWithUser(db, 'member')
    await expect(
      ingestDocumentFile(makeJobCtx({ db }), {
        tenantId: tenant.id,
        userId: user.id,
        source: 'orders:drive',
        filename: 'photo.png',
        file: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      })
    ).rejects.toMatchObject({ statusCode: 415, code: 'unsupported_media_type' })
  })
})
