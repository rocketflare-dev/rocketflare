/**
 * `tenant.purge` (D7): the out-of-database half of deleting an organisation. The FK cascade is
 * complete inside Postgres and reaches nothing else, so this covers the seam that closes the gap —
 * the route ENQUEUES, the handler deletes the tenant's R2 objects and nobody else's, a second
 * delivery is a clean no-op, a Worker with no `FILES` binding acks rather than retrying for ever,
 * and a plugin's `onTenantDeleted` runs without one bad hook costing the next its turn.
 */
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { processJobsBatch } from '@/api/queues/jobs'
import { buildJobEnvelope } from '@/api/services/jobs'
import { createR2Storage, purgeTenantObjects, tenantStoragePrefix } from '@/api/services/storage'
import type { Logger } from '@/api/utils/core/logger'
import { runTenantDeletedHooks } from '@/api/utils/db/tenant-helpers'
import { loadConfig } from '@/config'
import { tenants } from '@/db/schema'
import type { AnyServerPlugin } from '@/plugins/server'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { request } from '../helpers/request'
import { createTestEnv, MemoryR2Bucket, stubs, type TestEnv } from '../mocks/bindings'

const db = setupTestDatabase()

function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
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

function fakeBatch(messages: ReturnType<typeof fakeMessage>[]) {
  return {
    queue: 'rocketflare-jobs',
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>
}

function deps(env: TestEnv) {
  const logger = fakeLogger()
  return {
    deps: { env, config: loadConfig(env), logger, createDb: () => ({ db, close: async () => {} }) },
    logger,
  }
}

/** Run the purge job for a tenant and hand back the one message so `ack`/`retry` can be asserted. */
async function runPurge(env: TestEnv, tenantId: string) {
  const { deps: d, logger } = deps(env)
  const message = fakeMessage(
    buildJobEnvelope({ type: 'tenant.purge', payload: { tenantId, tenantSlug: 'acme' } })
  )
  await processJobsBatch(fakeBatch([message]), d)
  return { message, logger }
}

async function putObject(env: TestEnv, key: string) {
  await stubs(env).files.put(key, 'bytes', { httpMetadata: { contentType: 'text/plain' } })
}

describe('DELETE /api/tenant', () => {
  it('enqueues tenant.purge with the id and slug of the organisation it deleted', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const env = createTestEnv()

    const res = await request(
      '/api/tenant',
      { method: 'DELETE', headers: cookie },
      { env, json: { confirm: tenant.slug } }
    )

    expect(res.status).toBe(204)
    expect(await db.select().from(tenants).where(eq(tenants.id, tenant.id))).toHaveLength(0)
    const purges = stubs(env)
      .queue.messages.map(m => m.body as { type: string; payload: Record<string, unknown> })
      .filter(b => b.type === 'tenant.purge')
    expect(purges).toHaveLength(1)
    expect(purges[0]?.payload).toMatchObject({ tenantId: tenant.id, tenantSlug: tenant.slug })
  })
})

describe('the tenant.purge handler', () => {
  it('deletes every object of the tenant, leaves another tenant’s alone, and acks', async () => {
    const env = createTestEnv()
    const mine = '11111111-1111-4111-8111-111111111111'
    const theirs = '22222222-2222-4222-8222-222222222222'
    await putObject(env, `tenants/${mine}/avatars/a-face.png`)
    await putObject(env, `tenants/${mine}/uploads/b-report.pdf`)
    await putObject(env, `tenants/${mine}/documents/c-notes.md`)
    await putObject(env, `tenants/${theirs}/uploads/d-keep.pdf`)

    const { message, logger } = await runPurge(env, mine)

    expect(message.ack).toHaveBeenCalledTimes(1)
    expect(message.retry).not.toHaveBeenCalled()
    const keys = [...stubs(env).files.objects.keys()]
    expect(keys).toEqual([`tenants/${theirs}/uploads/d-keep.pdf`])
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: mine, deleted: 3 }),
      'tenant.purge: storage purged'
    )
  })

  it('is idempotent: a second delivery deletes nothing and still acks', async () => {
    const env = createTestEnv()
    const tenantId = '33333333-3333-4333-8333-333333333333'
    await putObject(env, `tenants/${tenantId}/uploads/a-one.txt`)

    await runPurge(env, tenantId)
    const { message, logger } = await runPurge(env, tenantId)

    expect(message.ack).toHaveBeenCalledTimes(1)
    expect(message.retry).not.toHaveBeenCalled()
    expect(stubs(env).files.objects.size).toBe(0)
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ deleted: 0 }),
      'tenant.purge: storage purged'
    )
  })

  it('acks rather than retrying when there is no FILES binding — no binding, no objects', async () => {
    const env = createTestEnv({ FILES: undefined })
    const { message, logger } = await runPurge(env, '44444444-4444-4444-8444-444444444444')

    expect(message.ack).toHaveBeenCalledTimes(1)
    expect(message.retry).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: '44444444-4444-4444-8444-444444444444' }),
      'tenant.purge: no FILES binding, no stored objects to delete'
    )
  })

  it('retries when R2 itself fails — a tenant’s files must not survive a timed-out list', async () => {
    const env = createTestEnv()
    const bucket = stubs(env).files as unknown as { list: () => Promise<never> }
    bucket.list = async () => {
      throw new Error('R2 unavailable')
    }
    const { message } = await runPurge(env, '55555555-5555-4555-8555-555555555555')

    expect(message.retry).toHaveBeenCalledTimes(1)
    expect(message.ack).not.toHaveBeenCalled()
  })
})

describe('purgeTenantObjects', () => {
  it('pages through the prefix rather than assuming one page', async () => {
    const bucket = new MemoryR2Bucket()
    const tenantId = '66666666-6666-4666-8666-666666666666'
    for (let i = 0; i < 5; i++) {
      await bucket.put(`${tenantStoragePrefix(tenantId)}uploads/${i}-f.txt`, 'x')
    }
    await bucket.put('tenants/other/uploads/keep.txt', 'x')
    const storage = createR2Storage(bucket as unknown as R2Bucket)

    // A page size the fixture exceeds: one page would silently leave three objects behind.
    expect(await purgeTenantObjects(storage, tenantId, { limit: 2 })).toBe(5)
    expect([...bucket.objects.keys()]).toEqual(['tenants/other/uploads/keep.txt'])
  })
})

describe('onTenantDeleted', () => {
  const plugin = (id: string, onTenantDeleted: () => Promise<void>) =>
    ({ shared: { id }, hooks: { onTenantDeleted } }) as unknown as AnyServerPlugin

  it('runs every plugin’s hook, and one that throws costs the next nothing', async () => {
    const env = createTestEnv()
    const calls: string[] = []
    const logger = fakeLogger()
    const plugins = [
      plugin('first', async () => {
        calls.push('first')
      }),
      plugin('broken', async () => {
        calls.push('broken')
        throw new Error('hook exploded')
      }),
      plugin('last', async () => {
        calls.push('last')
      }),
    ]

    await expect(
      runTenantDeletedHooks(db, '77777777-7777-4777-8777-777777777777', env, logger, plugins)
    ).resolves.toBeUndefined()

    expect(calls).toEqual(['first', 'broken', 'last'])
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: 'broken' }),
      'tenant.purge: plugin onTenantDeleted hook failed'
    )
  })

  it('is called by the job, with the bindings a plugin needs to reach its own state', async () => {
    const env = createTestEnv()
    const seen: { tenantId: string; hasFiles: boolean }[] = []
    const plugins = [
      plugin('recorder', (async (_db: unknown, tenantId: string, e: TestEnv) => {
        seen.push({ tenantId, hasFiles: Boolean(e.FILES) })
      }) as unknown as () => Promise<void>),
    ]
    await runTenantDeletedHooks(db, '88888888-8888-4888-8888-888888888888', env, undefined, plugins)
    expect(seen).toEqual([{ tenantId: '88888888-8888-4888-8888-888888888888', hasFiles: true }])
  })
})
