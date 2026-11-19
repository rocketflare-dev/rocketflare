/**
 * A suspended organisation's queued work does not run: the jobs consumer acknowledges, without
 * dispatching, every job that names a tenant that is not active — re-embeds, indexing,
 * conversion, fact extraction, chat compaction — so none of it spends a model call. A document
 * whose index or conversion was dropped is left `failed`, so Retry picks it up after
 * reactivation. Teardown and the activity record still run: `tenant.purge` for a tenant that no
 * longer exists, `activity.record` for a suspended one.
 */

import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { processJobsBatch } from '@/api/queues/jobs'
import { setTenantSuspended } from '@/api/services/admin'
import { ingestText } from '@/api/services/ai/ingest'
import { resolveEmbeddingsModel } from '@/api/services/ai/resolve'
import { buildJobEnvelope } from '@/api/services/jobs'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import { activityEvents, chunks, documents } from '@/db/schema'
import { createTestTenantWithUser, createTestUser } from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { createTestEnv, stubs } from '../../mocks/bindings'

const db = setupTestDatabase()
const STALE = 'an-earlier-embeddings-model'

function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as Logger & typeof log
}

function message(body: unknown) {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  }
}

async function consume(env: ReturnType<typeof createTestEnv>, body: unknown) {
  const msg = message(body)
  const logger = fakeLogger()
  await processJobsBatch(
    { queue: 'rocketflare-jobs', messages: [msg], ackAll: vi.fn(), retryAll: vi.fn() } as never,
    { env, config: loadConfig(env), logger, createDb: () => ({ db, close: async () => {} }) }
  )
  return { msg, logger }
}

const skipped = (logger: ReturnType<typeof fakeLogger>) =>
  logger.info.mock.calls.some(args =>
    args.includes('jobs: tenant not active, acknowledged without running')
  )

/** A tenant with one indexed document, then suspended. */
async function suspendedTenantWithDocument(env: ReturnType<typeof createTestEnv>) {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  const cfg = loadConfig(env)
  const { document } = await ingestText(db, cfg, env, {
    tenantId: tenant.id,
    userId: user.id,
    title: 'Handbook',
    text: `Handbook. ${'Plain words for a small document. '.repeat(10)}`,
  })
  const admin = await createTestUser(db)
  const suspend = (suspended: boolean) =>
    setTenantSuspended(db, {
      tenantId: tenant.id,
      suspended,
      admin,
      env,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })
  await suspend(true)
  return { tenant, user, document, suspend }
}

const modelCalls = (env: ReturnType<typeof createTestEnv>) => stubs(env).ai?.runs.length ?? 0

describe('a suspended tenant’s queued jobs', () => {
  it('a re-embed makes no model call, is acked, and runs again once reactivated', async () => {
    const env = createTestEnv()
    const { tenant, document, suspend } = await suspendedTenantWithDocument(env)
    const model = await resolveEmbeddingsModel(db, loadConfig(env), env, tenant.id)
    if (!model) throw new Error('the test env resolves an embeddings model')
    await db
      .update(chunks)
      .set({ embeddingModel: STALE })
      .where(and(eq(chunks.tenantId, tenant.id), eq(chunks.documentId, document.id)))
    const body = buildJobEnvelope({
      type: 'document.reembed',
      payload: { tenantId: tenant.id, model },
    })
    const chunkModels = async () =>
      (
        await db
          .select({ m: chunks.embeddingModel })
          .from(chunks)
          .where(eq(chunks.documentId, document.id))
      ).map(r => r.m)

    const before = modelCalls(env)
    const { msg, logger } = await consume(env, body)
    expect(msg.ack).toHaveBeenCalledTimes(1)
    expect(msg.retry).not.toHaveBeenCalled()
    expect(skipped(logger)).toBe(true)
    expect(modelCalls(env)).toBe(before)
    expect((await chunkModels()).every(m => m === STALE)).toBe(true)
    // The chain is not continued either: nothing re-enqueued itself.
    expect(
      stubs(env).queue.messages.some(m => (m.body as { type?: string }).type === 'document.reembed')
    ).toBe(false)

    await suspend(false)
    await consume(env, body)
    expect(modelCalls(env)).toBeGreaterThan(before)
    expect((await chunkModels()).every(m => m === model)).toBe(true)
  })

  it('an index is dropped with the document left failed, so it can be retried', async () => {
    const env = createTestEnv()
    const { tenant, document } = await suspendedTenantWithDocument(env)
    await db.update(documents).set({ status: 'pending' }).where(eq(documents.id, document.id))

    const before = modelCalls(env)
    const { msg, logger } = await consume(
      env,
      buildJobEnvelope({
        type: 'document.index',
        payload: { tenantId: tenant.id, documentId: document.id },
      })
    )
    expect(msg.ack).toHaveBeenCalledTimes(1)
    expect(skipped(logger)).toBe(true)
    expect(modelCalls(env)).toBe(before)
    const row = await db.query.documents.findFirst({ where: eq(documents.id, document.id) })
    expect(row?.status).toBe('failed')
    expect(row?.error).toBeTruthy()
  })

  it('a document already indexed is not marked failed by a dropped job', async () => {
    const env = createTestEnv()
    const { tenant, document } = await suspendedTenantWithDocument(env)
    await consume(
      env,
      buildJobEnvelope({
        type: 'document.index',
        payload: { tenantId: tenant.id, documentId: document.id },
      })
    )
    const row = await db.query.documents.findFirst({ where: eq(documents.id, document.id) })
    expect(row?.status).toBe('indexed')
  })

  it('fact extraction, conversion, compaction and email are acked without running', async () => {
    const env = createTestEnv()
    const { tenant, document } = await suspendedTenantWithDocument(env)
    const bodies = [
      buildJobEnvelope({
        type: 'knowledge.extract',
        payload: { tenantId: tenant.id, documentId: document.id },
      }),
      buildJobEnvelope({
        type: 'document.convert',
        payload: { tenantId: tenant.id, documentId: document.id },
      }),
      buildJobEnvelope({
        type: 'chat.compact',
        payload: { tenantId: tenant.id, conversationId: crypto.randomUUID(), force: true },
      }),
      buildJobEnvelope({
        type: 'email.send',
        payload: {
          to: 'someone@example.test',
          subject: 'Hello',
          html: '<p>Hello</p>',
          tenantId: tenant.id,
          reason: 'invitation',
        },
      }),
    ]
    const before = modelCalls(env)
    for (const body of bodies) {
      const { msg, logger } = await consume(env, body)
      expect(msg.ack).toHaveBeenCalledTimes(1)
      expect(msg.retry).not.toHaveBeenCalled()
      expect(skipped(logger)).toBe(true)
    }
    expect(modelCalls(env)).toBe(before)
    expect(stubs(env).ai?.conversions?.length ?? 0).toBe(0)
  })

  it('the activity record of a suspended tenant is still written', async () => {
    const env = createTestEnv()
    const { tenant, user } = await suspendedTenantWithDocument(env)
    const { msg, logger } = await consume(
      env,
      buildJobEnvelope({
        type: 'activity.record',
        payload: {
          tenantId: tenant.id,
          userId: user.id,
          type: 'document.viewed',
          subjectType: 'Document',
        },
      })
    )
    expect(msg.ack).toHaveBeenCalledTimes(1)
    expect(skipped(logger)).toBe(false)
    const rows = await db
      .select()
      .from(activityEvents)
      .where(
        and(eq(activityEvents.tenantId, tenant.id), eq(activityEvents.type, 'document.viewed'))
      )
    expect(rows).toHaveLength(1)
  })

  it('a deleted tenant’s purge still runs', async () => {
    const env = createTestEnv()
    const tenantId = crypto.randomUUID()
    const key = `tenants/${tenantId}/files/report.pdf`
    await env.FILES?.put(key, new Uint8Array([1, 2, 3]))
    const { msg, logger } = await consume(
      env,
      buildJobEnvelope({ type: 'tenant.purge', payload: { tenantId, tenantSlug: 'gone' } })
    )
    expect(msg.ack).toHaveBeenCalledTimes(1)
    expect(skipped(logger)).toBe(false)
    expect(stubs(env).files?.objects.has(key)).toBe(false)
  })
})
