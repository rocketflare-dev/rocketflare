/**
 * `document.index` job (D7, D18) through the real consumer: a `pending` document with stored
 * content → chunks with embeddings + `indexed` + `ack()`; a vanished document → `ack()` (nothing to
 * retry); an embeddings failure → row `failed` with a redacted error and `retry({ delaySeconds })`.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { backoffSeconds, processJobsBatch } from '@/api/queues/jobs'
import { buildJobEnvelope } from '@/api/services/jobs'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import { chunks, documents } from '@/db/schema'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createTestEnv, stubs } from '../mocks/bindings'

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
    queue: 'gmgo-starter-jobs',
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>
}

async function pendingDocument(tenantId: string, content: string) {
  const [row] = await db
    .insert(documents)
    .values({ tenantId, title: 'Queued', content, sizeBytes: content.length, status: 'pending' })
    .returning()
  if (!row) throw new Error('insert failed')
  return row
}

describe('document.index', () => {
  it('indexes the stored content: chunks + embeddings, status indexed, ack, DB handle closed', async () => {
    const { tenant } = await createTestTenantWithUser(db, 'owner')
    const env = createTestEnv()
    const content = Array.from(
      { length: 6 },
      (_, i) => `Paragraph ${i}. ${'word '.repeat(700)}`
    ).join('\n\n')
    const doc = await pendingDocument(tenant.id, content)
    const close = vi.fn(async () => {})
    const logger = fakeLogger()
    const msg = message(
      buildJobEnvelope({
        type: 'document.index',
        payload: { tenantId: tenant.id, documentId: doc.id },
      })
    )
    await processJobsBatch(batch([msg]), {
      env,
      config: loadConfig(env),
      logger,
      createDb: () => ({ db, close }),
    })

    expect(msg.ack).toHaveBeenCalledTimes(1)
    expect(msg.retry).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
    const [row] = await db.select().from(documents).where(eq(documents.id, doc.id))
    expect(row).toMatchObject({ status: 'indexed', embeddingModel: '@cf/baai/bge-m3', error: null })
    expect(row?.chunkCount).toBeGreaterThan(1)
    const pieces = await db
      .select()
      .from(chunks)
      .where(and(eq(chunks.tenantId, tenant.id), eq(chunks.documentId, doc.id)))
    expect(pieces).toHaveLength(row?.chunkCount ?? -1)
    expect(pieces.every(p => p.embedding.length === 1024)).toBe(true)
    // Batched: 32 texts per embeddings call.
    for (const run of stubs(env).ai?.runs ?? []) {
      expect((run.inputs.text as string[]).length).toBeLessThanOrEqual(32)
    }
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: doc.id }),
      'document.index: indexed'
    )
  })

  it('a document that no longer exists is acked with a warning', async () => {
    const { tenant } = await createTestTenantWithUser(db, 'owner')
    const env = createTestEnv()
    const logger = fakeLogger()
    const msg = message(
      buildJobEnvelope({
        type: 'document.index',
        payload: { tenantId: tenant.id, documentId: crypto.randomUUID() },
      })
    )
    await processJobsBatch(batch([msg]), {
      env,
      config: loadConfig(env),
      logger,
      createDb: () => ({ db, close: async () => {} }),
    })
    expect(msg.ack).toHaveBeenCalledTimes(1)
    expect(msg.retry).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      'document.index: document no longer exists'
    )
  })

  it('an embeddings failure marks the row failed (redacted) and retries with backoff', async () => {
    const { tenant } = await createTestTenantWithUser(db, 'owner')
    const env = createTestEnv()
    const ai = stubs(env).ai
    if (ai) {
      ai.respond = () => {
        throw Object.assign(new Error('upstream exploded Bearer sk-live-0123456789abcdefghijkl'), {
          status: 503,
        })
      }
    }
    const doc = await pendingDocument(tenant.id, 'Some text to index.')
    const msg = message(
      buildJobEnvelope({
        type: 'document.index',
        payload: { tenantId: tenant.id, documentId: doc.id },
      }),
      2
    )
    await processJobsBatch(batch([msg]), {
      env,
      config: loadConfig(env),
      logger: fakeLogger(),
      createDb: () => ({ db, close: async () => {} }),
    })
    expect(msg.ack).not.toHaveBeenCalled()
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: backoffSeconds(2) })
    const [row] = await db.select().from(documents).where(eq(documents.id, doc.id))
    expect(row?.status).toBe('failed')
    expect(row?.error).toBeTruthy()
    expect(row?.error).not.toContain('sk-live')
    expect(await db.select().from(chunks).where(eq(chunks.documentId, doc.id))).toEqual([])
  })
})
