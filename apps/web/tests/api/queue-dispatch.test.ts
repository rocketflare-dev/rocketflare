/**
 * The Worker's `queue()` export (D7): routes every environment's jobs queue by prefix
 * (`gmgo-starter-jobs`, `gmgo-starter-jobs-staging`) to the jobs consumer, and acks a batch from
 * any queue it does not know so a stray binding cannot retry forever.
 */
import { describe, expect, it, vi } from 'vitest'
import { queue } from '@/api/queue'
import { buildJobEnvelope } from '@/api/services/jobs'
import { createExecutionContext, createTestEnv } from '../mocks/bindings'

const TENANT = '11111111-1111-4111-8111-111111111111'

function pingMessage() {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body: buildJobEnvelope({ type: 'example.ping', payload: { tenantId: TENANT } }),
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  }
}

function batchFor(queueName: string, messages = [pingMessage()]) {
  const batch = {
    queue: queueName,
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  }
  return { batch: batch as unknown as MessageBatch<unknown>, spies: batch }
}

describe('queue() dispatcher', () => {
  for (const name of ['gmgo-starter-jobs', 'gmgo-starter-jobs-staging']) {
    it(`routes '${name}' to the jobs consumer (per-message ack)`, async () => {
      const { batch, spies } = batchFor(name)
      await queue(batch, createTestEnv(), createExecutionContext())
      expect(spies.messages[0]?.ack).toHaveBeenCalledTimes(1)
      expect(spies.messages[0]?.retry).not.toHaveBeenCalled()
      expect(spies.ackAll).not.toHaveBeenCalled()
    })
  }

  it('acks an unknown queue wholesale without touching the messages', async () => {
    const { batch, spies } = batchFor('some-other-queue')
    await queue(batch, createTestEnv(), createExecutionContext())
    expect(spies.ackAll).toHaveBeenCalledTimes(1)
    expect(spies.messages[0]?.ack).not.toHaveBeenCalled()
    expect(spies.messages[0]?.retry).not.toHaveBeenCalled()
  })

  it('validates config like fetch does', async () => {
    const { batch } = batchFor('gmgo-starter-jobs')
    await expect(
      queue(batch, createTestEnv({ APP_URL: 'not a url' }), createExecutionContext())
    ).rejects.toThrow(/Invalid environment configuration/)
  })
})
