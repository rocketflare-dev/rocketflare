/**
 * `deliverEvents(env, db)` — run the `event.deliver` jobs an emit queued (D42) through the REAL
 * jobs consumer, as the platform would, and say what happened to each. Re-exported by
 * `@testkit/integration`, so a plugin's test can prove "emitting X runs my handler / starts that
 * agent" without naming a kit internal.
 *
 * Only `event.deliver` messages are taken off the `RecordingQueue`; any other job stays where it is
 * for the test to assert on. Each message is processed on its own, with the test's shared handle.
 */

import { processJobsBatch } from '@/api/queues/jobs'
import { createLogger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import type { Database } from '@/db/client'
import { stubs, type TestEnv } from '../mocks/bindings'

export interface EventDelivery {
  /** `handler:<plugin id>:<name>`, `app:<name>` or `trigger:<agent key>:<index>`. */
  subscriber: string
  eventId: string
  /** `ack` — delivered, or refused for good; `retry` — the subscriber threw and would be retried. */
  outcome: 'ack' | 'retry'
}

export async function deliverEvents(env: TestEnv, db: Database): Promise<EventDelivery[]> {
  const queue = stubs(env).queue
  const isDelivery = (body: unknown) => (body as { type?: string })?.type === 'event.deliver'
  const taken = queue.messages.filter(m => isDelivery(m.body))
  const kept = queue.messages.filter(m => !isDelivery(m.body))
  queue.clear()
  queue.messages.push(...kept)

  const config = loadConfig(env)
  const out: EventDelivery[] = []
  for (const m of taken) {
    let outcome: EventDelivery['outcome'] = 'ack'
    const message = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      body: m.body,
      attempts: 1,
      ack: () => {},
      retry: () => {
        outcome = 'retry'
      },
    }
    await processJobsBatch(
      { queue: 'jobs', messages: [message], ackAll: () => {}, retryAll: () => {} } as never,
      {
        env,
        config,
        logger: createLogger({ level: 'silent' }),
        createDb: () => ({ db, close: async () => {} }),
      }
    )
    const { subscriber, eventId } = (m.body as { payload: { subscriber: string; eventId: string } })
      .payload
    out.push({ subscriber, eventId, outcome })
  }
  return out
}
