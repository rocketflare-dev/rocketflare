/**
 * `document.convert` job (D7, D18) through the real consumer: a `pending` upload → the original is
 * read from R2, handed to `AI.toMarkdown` with its name and type, the text stored on the row,
 * chunks + embeddings written, `indexed`, `ack()`; a `format: 'error'` answer → `failed` with the
 * reason and `ack()` (permanent — no retry); a thrown binding error → `failed` and
 * `retry({ delaySeconds })`; converted text over the cap → `failed` + ack; a vanished row → warn +
 * ack; a vanished object → `failed` + ack.
 */
import { INGEST_TEXT_MAX_CHARS } from '@rocketflare/shared/ai/embeddings'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { backoffSeconds, processJobsBatch } from '@/api/queues/jobs'
import { buildJobEnvelope } from '@/api/services/jobs'
import { createR2Storage, storeUploadedFile } from '@/api/services/storage'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import { chunks, documents } from '@/db/schema'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

const db = setupTestDatabase()

function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as Logger & typeof log
}

function message(body: unknown, attempts = 1) {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  }
}

function batch(messages: ReturnType<typeof message>[]) {
  return {
    queue: 'rocketflare-jobs',
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>
}

/** An uploaded, not-yet-converted PDF: object + files row + pending document with `fileId`. */
async function pendingUpload(
  env: TestEnv,
  tenantId: string,
  userId: string,
  text = 'The volcano erupted. Bananas are yellow.'
) {
  const storage = createR2Storage(env.FILES as R2Bucket)
  const file = await storeUploadedFile(db, storage, {
    tenantId,
    ownerUserId: userId,
    scope: 'documents',
    file: new Blob([text], { type: 'application/pdf' }),
    filename: 'report.pdf',
    contentType: 'application/pdf',
  })
  const [row] = await db
    .insert(documents)
    .values({
      tenantId,
      ownerUserId: userId,
      title: 'report',
      contentType: 'application/pdf',
      sizeBytes: text.length,
      fileId: file.id,
      status: 'pending',
    })
    .returning()
  if (!row) throw new Error('insert failed')
  return { row, file }
}

async function run(env: TestEnv, tenantId: string, documentId: string, attempts = 1) {
  const logger = fakeLogger()
  const msg = message(
    buildJobEnvelope({ type: 'document.convert', payload: { tenantId, documentId } }),
    attempts
  )
  const close = vi.fn(async () => {})
  await processJobsBatch(batch([msg]), {
    env,
    config: loadConfig(env),
    logger,
    createDb: () => ({ db, close }),
  })
  return { msg, logger, close }
}

const rowOf = async (id: string) =>
  (await db.select().from(documents).where(eq(documents.id, id)))[0]

describe('document.convert', () => {
  it('converts the stored original, stores the text, indexes, acks, closes the DB handle', async () => {
    const { tenant, user } = await createTestTenantWithUser(db, 'owner')
    const env = createTestEnv()
    const { row: doc, file } = await pendingUpload(env, tenant.id, user.id)

    const { msg, logger, close } = await run(env, tenant.id, doc.id)

    expect(msg.ack).toHaveBeenCalledTimes(1)
    expect(msg.retry).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
    expect(stubs(env).ai?.conversions).toEqual([
      { name: file.filename, type: 'application/pdf', size: file.sizeBytes },
    ])
    const row = await rowOf(doc.id)
    expect(row).toMatchObject({ status: 'indexed', embeddingModel: '@cf/baai/bge-m3', error: null })
    expect(row?.content).toContain('# report.pdf')
    expect(row?.content).toContain('The volcano erupted.')
    expect(row?.chunkCount).toBeGreaterThan(0)
    const pieces = await db
      .select()
      .from(chunks)
      .where(and(eq(chunks.tenantId, tenant.id), eq(chunks.documentId, doc.id)))
    expect(pieces).toHaveLength(row?.chunkCount ?? -1)
    expect(pieces.every(p => p.embedding.length === 1024)).toBe(true)
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: doc.id }),
      'document.convert: indexed'
    )
  })

  it('a format: error answer is permanent → failed with the reason, acked, no retry', async () => {
    const { tenant, user } = await createTestTenantWithUser(db, 'owner')
    const env = createTestEnv()
    const ai = stubs(env).ai
    if (ai) {
      ai.convert = async doc => ({
        id: 'x',
        name: doc.name,
        mimeType: doc.blob.type,
        format: 'error',
        error: 'Unsupported or corrupt PDF',
      })
    }
    const { row: doc } = await pendingUpload(env, tenant.id, user.id)
    const { msg, logger } = await run(env, tenant.id, doc.id)
    expect(msg.ack).toHaveBeenCalledTimes(1)
    expect(msg.retry).not.toHaveBeenCalled()
    const row = await rowOf(doc.id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain('Unsupported or corrupt PDF')
    expect(row?.content).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(expect.anything(), 'document.convert: failed')
    expect(await db.select().from(chunks).where(eq(chunks.documentId, doc.id))).toEqual([])
  })

  it('a thrown binding error → failed (redacted) and retry with backoff', async () => {
    const { tenant, user } = await createTestTenantWithUser(db, 'owner')
    const env = createTestEnv()
    const ai = stubs(env).ai
    if (ai) {
      ai.convert = async () => {
        throw Object.assign(
          new Error('toMarkdown exploded Bearer sk-live-0123456789abcdefghijkl'),
          {
            status: 503,
          }
        )
      }
    }
    const { row: doc } = await pendingUpload(env, tenant.id, user.id)
    const { msg } = await run(env, tenant.id, doc.id, 2)
    expect(msg.ack).not.toHaveBeenCalled()
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: backoffSeconds(2) })
    const row = await rowOf(doc.id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toBeTruthy()
    expect(row?.error).not.toContain('sk-live')
  })

  it('converted text over the ingest cap → failed with the cap in the message, acked', async () => {
    const { tenant, user } = await createTestTenantWithUser(db, 'owner')
    const env = createTestEnv()
    const ai = stubs(env).ai
    if (ai) {
      ai.convert = async doc => ({
        id: 'x',
        name: doc.name,
        mimeType: doc.blob.type,
        format: 'markdown',
        tokens: 1,
        data: 'a'.repeat(INGEST_TEXT_MAX_CHARS + 1),
      })
    }
    const { row: doc } = await pendingUpload(env, tenant.id, user.id)
    const { msg } = await run(env, tenant.id, doc.id)
    expect(msg.ack).toHaveBeenCalledTimes(1)
    const row = await rowOf(doc.id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain(INGEST_TEXT_MAX_CHARS.toLocaleString())
    expect(row?.content).toBeNull()
  })

  it('a vanished document is acked with a warning; a vanished object fails the row and acks', async () => {
    const { tenant, user } = await createTestTenantWithUser(db, 'owner')
    const env = createTestEnv()
    const gone = await run(env, tenant.id, crypto.randomUUID())
    expect(gone.msg.ack).toHaveBeenCalledTimes(1)
    expect(gone.logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      'document.convert: document no longer exists'
    )

    const { row: doc, file } = await pendingUpload(env, tenant.id, user.id)
    stubs(env).files.objects.delete(file.key)
    const { msg } = await run(env, tenant.id, doc.id)
    expect(msg.ack).toHaveBeenCalledTimes(1)
    expect(msg.retry).not.toHaveBeenCalled()
    const row = await rowOf(doc.id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain('no longer in storage')
  })
})
