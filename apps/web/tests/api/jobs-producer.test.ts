/**
 * `JOBS_QUEUE` producer (D7): `enqueueJob` validates and stamps the envelope; the invitation routes
 * (create / bulk / resend) enqueue `email.send` instead of sending inline; the magic-link request
 * stays inline (a person is waiting) and enqueues nothing. Assertions run against the
 * `RecordingQueue` behind `stubs(env).queue`.
 */
import { jobEnvelopeSchema } from '@gmgo/shared/jobs'
import { describe, expect, it } from 'vitest'
import {
  buildJobEnvelope,
  enqueueJob,
  enqueueJobs,
  isJobsQueue,
  JOBS_QUEUE_NAME_PREFIX,
  JobsQueueNotConfiguredError,
} from '@/api/services/jobs'
import {
  createTestSession,
  createTestTenantWithUser,
  sessionCookieHeader,
  uniqueId,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv, RecordingQueue, stubs } from '../mocks/bindings'

const db = setupTestDatabase()
const TENANT = '11111111-1111-4111-8111-111111111111'
const newEmail = () => `job_${uniqueId().toLowerCase()}@example.test`

async function tenantWithOwner() {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  return {
    owner: user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

type EmailJob = { type: string; payload: Record<string, unknown> }

describe('enqueueJob / enqueueJobs', () => {
  it('validates the input and stamps id + enqueuedAt', async () => {
    const queue = new RecordingQueue()
    const before = Date.now()
    const job = await enqueueJob(queue, {
      type: 'example.ping',
      payload: { tenantId: TENANT, note: 'hi' },
    })
    expect(job.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(Date.parse(job.enqueuedAt)).toBeGreaterThanOrEqual(before - 1000)
    expect(job.attempt).toBeUndefined()
    expect(queue.messages).toHaveLength(1)
    expect(queue.messages[0]?.body).toEqual(job)
    expect(queue.messages[0]?.options).toBeUndefined()
    expect(jobEnvelopeSchema.parse(queue.messages[0]?.body)).toEqual(job)
  })

  it('passes delaySeconds through and rejects an invalid payload without sending', async () => {
    const queue = new RecordingQueue()
    await enqueueJob(
      queue,
      { type: 'example.ping', payload: { tenantId: TENANT } },
      { delaySeconds: 30 }
    )
    expect(queue.messages[0]?.options).toEqual({ delaySeconds: 30 })

    await expect(
      enqueueJob(queue, {
        type: 'email.send',
        // @ts-expect-error — missing `to` on purpose
        payload: { subject: 's', html: '<p>x</p>', reason: 'test' },
      })
    ).rejects.toThrow()
    expect(queue.messages).toHaveLength(1)
    expect(() => buildJobEnvelope({ type: 'nope' } as never)).toThrow()
  })

  it('a missing binding is a clear configuration error, never a silent drop', async () => {
    await expect(
      enqueueJob(undefined, { type: 'example.ping', payload: { tenantId: TENANT } })
    ).rejects.toBeInstanceOf(JobsQueueNotConfiguredError)
    await expect(
      enqueueJobs(null, [{ type: 'example.ping', payload: { tenantId: TENANT } }])
    ).rejects.toThrow(/JOBS_QUEUE/)
  })

  it('enqueueJobs chunks sendBatch at 100 and returns every envelope', async () => {
    const queue = new RecordingQueue()
    const jobs = await enqueueJobs(
      queue,
      Array.from({ length: 150 }, (_, i) => ({
        type: 'example.ping' as const,
        payload: { tenantId: TENANT, note: String(i) },
      }))
    )
    expect(jobs).toHaveLength(150)
    expect(queue.messages).toHaveLength(150)
    expect(new Set(jobs.map(j => j.id)).size).toBe(150)
  })

  it('isJobsQueue matches every environment of the queue by prefix', () => {
    expect(isJobsQueue(JOBS_QUEUE_NAME_PREFIX)).toBe(true)
    expect(isJobsQueue('gmgo-starter-jobs')).toBe(true)
    expect(isJobsQueue('gmgo-starter-jobs-staging')).toBe(true)
    expect(isJobsQueue('gmgo-starter-jobs-dlq')).toBe(true)
    expect(isJobsQueue('other-queue')).toBe(false)
    expect(isJobsQueue('')).toBe(false)
  })
})

describe('invitation routes enqueue email.send', () => {
  it('POST /api/invitations → one email.send with the accept link, tenant and reason', async () => {
    const { tenant, cookie } = await tenantWithOwner()
    const env = createTestEnv()
    const email = newEmail()
    const res = await request(
      '/api/invitations',
      { method: 'POST', headers: cookie },
      { env, json: { email, role: 'member' } }
    )
    expect(res.status).toBe(201)
    const { messages } = stubs(env).queue
    expect(messages).toHaveLength(1)
    const job = jobEnvelopeSchema.parse(messages[0]?.body)
    expect(job.type).toBe('email.send')
    if (job.type !== 'email.send') throw new Error('unreachable')
    expect(job.payload).toMatchObject({ to: email, tenantId: tenant.id, reason: 'invitation' })
    expect(job.payload.subject).toContain(tenant.name)
    expect(job.payload.link).toMatch(/\/invite\/[A-Za-z0-9_-]+$/)
    expect(job.payload.html).toContain(job.payload.link ?? '')
  })

  it('a 409 (already invited) enqueues nothing', async () => {
    const { cookie } = await tenantWithOwner()
    const env = createTestEnv()
    const email = newEmail()
    await request('/api/invitations', { method: 'POST', headers: cookie }, { env, json: { email } })
    stubs(env).queue.clear()
    const dup = await request(
      '/api/invitations',
      { method: 'POST', headers: cookie },
      { env, json: { email } }
    )
    expect(dup.status).toBe(409)
    expect(stubs(env).queue.messages).toHaveLength(0)
  })

  it('POST /api/invitations/bulk → one email.send per distinct address', async () => {
    const { cookie } = await tenantWithOwner()
    const env = createTestEnv()
    const a = newEmail()
    const b = newEmail()
    const res = await request(
      '/api/invitations/bulk',
      { method: 'POST', headers: cookie },
      { env, json: { emails: [a, b, a.toUpperCase()], role: 'member' } }
    )
    expect(res.status).toBe(200)
    const body = await json<{ results: { status: string }[] }>(res)
    expect(body.results.map(r => r.status)).toEqual(['invited', 'invited', 'skipped'])
    const jobs = stubs(env).queue.messages.map(m => m.body as EmailJob)
    expect(jobs.map(j => j.type)).toEqual(['email.send', 'email.send'])
    expect(jobs.map(j => j.payload.to).sort()).toEqual([a, b].sort())
  })

  it('POST /api/invitations/:id/resend → another email.send with a NEW link', async () => {
    const { cookie } = await tenantWithOwner()
    const env = createTestEnv()
    const created = await request(
      '/api/invitations',
      { method: 'POST', headers: cookie },
      { env, json: { email: newEmail() } }
    )
    const { id } = await json<{ id: string }>(created)
    const first = (stubs(env).queue.messages[0]?.body as EmailJob | undefined)?.payload.link
    expect(first).toBeDefined()
    const res = await request(
      `/api/invitations/${id}/resend`,
      { method: 'POST', headers: cookie },
      { env }
    )
    expect(res.status).toBe(200)
    const jobs = stubs(env).queue.messages.map(m => m.body as EmailJob)
    expect(jobs).toHaveLength(2)
    expect(jobs[1]?.type).toBe('email.send')
    expect(jobs[1]?.payload.link).not.toBe(first)
  })
})

describe('magic link stays inline', () => {
  it('POST /auth/magic-link/request enqueues nothing', async () => {
    const env = createTestEnv()
    const res = await request(
      '/auth/magic-link/request',
      { method: 'POST' },
      { env, json: { email: newEmail() } }
    )
    expect(res.status).toBe(202)
    expect(stubs(env).queue.messages).toHaveLength(0)
  })
})
