// @vitest-isolate
// Spies on the global fetch (Resend failure path), so this file needs its own module registry.
/**
 * `JOBS_QUEUE` consumer (D7) as a plain function over a hand-built `MessageBatch`: valid
 * `email.send` → email service ran (dev fallback line) + `ack()`; invalid envelope → `ack()` and no
 * retry (poison never loops); provider failure → `retry({ delaySeconds })` with backoff;
 * `activity.record` → row; `example.ping` → log line. Every message gets and closes its own DB handle.
 */
import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BACKOFF_BASE_SECONDS,
  BACKOFF_MAX_SECONDS,
  backoffSeconds,
  processJobsBatch,
} from '@/api/queues/jobs'
import { buildJobEnvelope } from '@/api/services/jobs'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import { activityEvents } from '@/db/schema'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const TENANT = '11111111-1111-4111-8111-111111111111'

function fakeLogger() {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => log,
  }
  return log as unknown as Logger & typeof log
}

function fakeMessage(body: unknown, attempts = 1) {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  }
}

function fakeBatch(messages: ReturnType<typeof fakeMessage>[], queue = 'gmgo-starter-jobs') {
  return { queue, messages, ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch<unknown>
}

/** Deps with the shared test pool and a close spy — no real connection per message. */
function deps(overrides: Record<string, unknown> = {}) {
  const env = createTestEnv(overrides)
  const close = vi.fn(async () => {})
  const logger = fakeLogger()
  return {
    deps: { env, config: loadConfig(env), logger, createDb: () => ({ db, close }) },
    logger,
    close,
  }
}

const infoLines = (logger: ReturnType<typeof fakeLogger>) =>
  logger.info.mock.calls.map(args => args.map(a => (typeof a === 'string' ? a : '')).join(' '))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('backoffSeconds', () => {
  it('doubles from the base and caps', () => {
    expect(backoffSeconds(1)).toBe(BACKOFF_BASE_SECONDS)
    expect(backoffSeconds(2)).toBe(BACKOFF_BASE_SECONDS * 2)
    expect(backoffSeconds(3)).toBe(BACKOFF_BASE_SECONDS * 4)
    expect(backoffSeconds(20)).toBe(BACKOFF_MAX_SECONDS)
    expect(backoffSeconds(0)).toBe(BACKOFF_BASE_SECONDS)
  })
})

describe('processJobsBatch', () => {
  it('email.send without RESEND_API_KEY: dev fallback logged, message acked, DB handle closed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { deps: d, logger, close } = deps({ RESEND_API_KEY: '' })
    const job = buildJobEnvelope({
      type: 'email.send',
      payload: {
        to: 'a@example.test',
        subject: 'Hello',
        html: '<p>hi</p>',
        text: 'hi',
        link: 'http://localhost:3001/invite/tok',
        tenantId: TENANT,
        reason: 'test',
      },
    })
    const message = fakeMessage(job)
    await processJobsBatch(fakeBatch([message]), d)

    expect(message.ack).toHaveBeenCalledTimes(1)
    expect(message.retry).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(infoLines(logger).join('\n')).toContain(
      '[email:dev] To: a@example.test Subject: Hello Link: http://localhost:3001/invite/tok'
    )
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('an invalid envelope is acked (never retried) and logged at error', async () => {
    const { deps: d, logger, close } = deps()
    const poison = fakeMessage({ type: 'not-a-job', payload: {} }, 3)
    const garbage = fakeMessage('just a string')
    await processJobsBatch(fakeBatch([poison, garbage]), d)
    for (const m of [poison, garbage]) {
      expect(m.ack).toHaveBeenCalledTimes(1)
      expect(m.retry).not.toHaveBeenCalled()
    }
    expect(logger.error).toHaveBeenCalledTimes(2)
    // No handler ran, so no DB handle was opened either.
    expect(close).not.toHaveBeenCalled()
  })

  it('a provider failure retries with exponential backoff and still closes the DB handle', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }))
    const { deps: d, logger, close } = deps({ RESEND_API_KEY: 're_test_123' })
    const job = buildJobEnvelope({
      type: 'email.send',
      payload: { to: 'b@example.test', subject: 'S', html: '<p>x</p>', reason: 'test' },
    })
    const first = fakeMessage(job, 1)
    const second = fakeMessage(job, 2)
    await processJobsBatch(fakeBatch([first, second]), d)

    expect(first.ack).not.toHaveBeenCalled()
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: backoffSeconds(1) })
    expect(second.retry).toHaveBeenCalledWith({ delaySeconds: backoffSeconds(2) })
    expect(logger.warn).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('one failing message does not stop the rest of the batch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 502 }))
    const { deps: d } = deps({ RESEND_API_KEY: 're_test_123' })
    const failing = fakeMessage(
      buildJobEnvelope({
        type: 'email.send',
        payload: { to: 'c@example.test', subject: 'S', html: '<p>x</p>', reason: 'test' },
      })
    )
    const fine = fakeMessage(
      buildJobEnvelope({ type: 'example.ping', payload: { tenantId: TENANT } })
    )
    await processJobsBatch(fakeBatch([failing, fine]), d)
    expect(failing.retry).toHaveBeenCalledTimes(1)
    expect(fine.ack).toHaveBeenCalledTimes(1)
  })

  it('activity.record inserts the row through the shared writer', async () => {
    const { tenant, user } = await createTestTenantWithUser(db, 'owner')
    const { deps: d } = deps()
    const subjectId = crypto.randomUUID()
    const message = fakeMessage(
      buildJobEnvelope({
        type: 'activity.record',
        payload: {
          tenantId: tenant.id,
          userId: user.id,
          type: 'thing.happened',
          subjectType: 'Thing',
          subjectId,
          metadata: { via: 'queue' },
        },
      })
    )
    await processJobsBatch(fakeBatch([message]), d)
    expect(message.ack).toHaveBeenCalledTimes(1)
    const rows = await db
      .select()
      .from(activityEvents)
      .where(and(eq(activityEvents.tenantId, tenant.id), eq(activityEvents.subjectId, subjectId)))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      userId: user.id,
      type: 'thing.happened',
      subjectType: 'Thing',
      metadata: { via: 'queue' },
    })
  })

  it('example.ping logs and acks (default DB factory: lazy, nothing connects)', async () => {
    const env = createTestEnv()
    const logger = fakeLogger()
    const message = fakeMessage(
      buildJobEnvelope({ type: 'example.ping', payload: { tenantId: TENANT, note: 'smoke' } })
    )
    await processJobsBatch(fakeBatch([message]), { env, config: loadConfig(env), logger })
    expect(message.ack).toHaveBeenCalledTimes(1)
    expect(infoLines(logger).some(l => l.includes('example.ping: pong'))).toBe(true)
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, note: 'smoke' }),
      'example.ping: pong'
    )
  })
})
