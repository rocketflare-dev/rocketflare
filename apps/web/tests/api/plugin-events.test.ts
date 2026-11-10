// @vitest-isolate
// Mocks the plugin barrels to install the fixture events plugin (tests/helpers/fixture-events.ts),
// so this file needs its own module registry.
/**
 * Plugin events and agent triggers (D42), end to end through the real queue consumer:
 *   - emit validates against the declaration (400), refuses an undeclared name, records ONE
 *     `plugin_events` row and queues one `event.deliver` per subscriber carrying ids only — never
 *     the payload; no `JOBS_QUEUE` writes nothing;
 *   - an `idempotencyKey` deduplicates per (tenant, name, key); a recorded-but-undispatched event
 *     is queued by the retry;
 *   - fan-out: each subscriber is its own message, so a failing handler retries ALONE;
 *   - triggers: a run per matching event with the event on the row and its activity, no requester,
 *     idempotent across redelivery; `where` skips; an invalid `input(...)` is acknowledged, not
 *     retried;
 *   - bindable: the list (function and route), the start — and a forged, unknown or merely
 *     triggered agent key refused 403 `agent_not_bindable`, starting nothing;
 *   - tenant isolation: a delivery naming another tenant finds nothing, and every handler context
 *     is bound to the event's own tenant;
 *   - retention: the nightly prune drops old events across tenants; a delivery after it is acked;
 *     a deleted tenant takes its events with it.
 */
import { ERROR_CODES } from '@rocketflare/shared/errors'
import { makeJobCtx } from '@testkit/unit'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { processJobsBatch } from '@/api/queues/jobs'
import { runPruneEvents } from '@/api/scheduled'
import { bindableAgents } from '@/api/services/agents/triggers'
import { emitEvent } from '@/api/services/events/emit'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import { activityEvents, agentRuns, pluginEvents, tenants } from '@/db/schema'
import { eventCtx } from '@/plugins/api/emit'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import {
  BINDABLE_AGENT,
  flaky,
  handled,
  OTHER_EVENT,
  PLAIN_AGENT,
  THING_HAPPENED,
  TRIGGERED_AGENT,
} from '../helpers/fixture-events'
import { json, request } from '../helpers/request'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

vi.mock('@rocketflare/shared/plugins', async importOriginal =>
  (await import('../helpers/fixture-events')).withFixtureEventsShared(await importOriginal())
)
vi.mock('@/plugins/server', async importOriginal =>
  (await import('../helpers/fixture-events')).withFixtureEventsServer(await importOriginal())
)

const db = setupTestDatabase()

beforeEach(() => {
  handled.length = 0
  flaky.fail = false
})

function silentLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as Logger & typeof log
}

interface FakeMessage {
  id: string
  body: unknown
  attempts: number
  ack: ReturnType<typeof vi.fn>
  retry: ReturnType<typeof vi.fn>
}

/** The `event.deliver` envelopes the queue holds, as consumer messages; the queue is drained. */
function drain(env: TestEnv): FakeMessage[] {
  const queue = stubs(env).queue
  const out = queue.messages.map(m => ({
    id: crypto.randomUUID(),
    body: m.body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  }))
  queue.clear()
  return out
}

async function consume(env: TestEnv, messages: FakeMessage[], logger = silentLogger()) {
  const batch = {
    queue: 'rocketflare-jobs',
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>
  await processJobsBatch(batch, {
    env,
    config: loadConfig(env),
    logger,
    createDb: () => ({ db, close: async () => {} }),
  })
  return logger
}

const subscriberOf = (m: FakeMessage) =>
  (m.body as { payload: { subscriber: string } }).payload.subscriber

const payload = (over: Partial<{ thingId: string; kind: string; text: string }> = {}) => ({
  thingId: crypto.randomUUID(),
  kind: 'note',
  text: 'Something worth a run.',
  ...over,
})

async function emit(env: TestEnv, tenantId: string, body: unknown, idempotencyKey?: string) {
  return emitEvent(db, env, {
    name: THING_HAPPENED,
    tenantId,
    payload: body,
    ...(idempotencyKey && { idempotencyKey }),
  })
}

const runsOf = (tenantId: string) =>
  db.select().from(agentRuns).where(eq(agentRuns.tenantId, tenantId))

describe('emit', () => {
  it('records the event once and queues one delivery per subscriber, carrying ids only', async () => {
    const env = createTestEnv()
    const { tenant } = await createTestTenantWithUser(db)
    const body = payload({ text: 'A secret the queue must never carry.' })
    const result = await emit(env, tenant.id, body)

    expect(result).toEqual({ eventId: expect.any(String), deduplicated: false, deliveries: 3 })
    const [row] = await db.select().from(pluginEvents).where(eq(pluginEvents.id, result.eventId))
    expect(row).toMatchObject({
      tenantId: tenant.id,
      name: THING_HAPPENED,
      source: 'fixture-ev',
      payload: body,
      dispatchedAt: expect.any(Date),
    })
    const messages = stubs(env).queue.messages
    expect(messages.map(m => (m.body as { type: string }).type)).toEqual([
      'event.deliver',
      'event.deliver',
      'event.deliver',
    ])
    expect(messages.map(m => subscriberOf(m as unknown as FakeMessage))).toEqual([
      'handler:fixture-ev:steady',
      'handler:fixture-ev:flaky',
      `trigger:${TRIGGERED_AGENT}:0`,
    ])
    expect(JSON.stringify(messages)).not.toContain('A secret')
  })

  it('refuses a payload the declaration refuses, and an undeclared event, writing nothing', async () => {
    const env = createTestEnv()
    const { tenant } = await createTestTenantWithUser(db)
    await expect(emit(env, tenant.id, { thingId: 'not-a-uuid' })).rejects.toMatchObject({
      statusCode: 400,
      code: ERROR_CODES.validationFailed,
    })
    await expect(
      emitEvent(db, env, { name: 'fixture-ev.nope', tenantId: tenant.id, payload: {} })
    ).rejects.toMatchObject({ statusCode: 400, code: ERROR_CODES.eventUnknown })
    expect(
      await db.select().from(pluginEvents).where(eq(pluginEvents.tenantId, tenant.id))
    ).toEqual([])
    expect(stubs(env).queue.messages).toEqual([])
  })

  it('records nothing without a JOBS_QUEUE', async () => {
    const env = createTestEnv({ JOBS_QUEUE: undefined })
    const { tenant } = await createTestTenantWithUser(db)
    await expect(emit(env, tenant.id, payload())).rejects.toThrow(/JOBS_QUEUE/)
    expect(
      await db.select().from(pluginEvents).where(eq(pluginEvents.tenantId, tenant.id))
    ).toEqual([])
  })

  it('an event with no subscriber is still recorded', async () => {
    const env = createTestEnv()
    const { tenant } = await createTestTenantWithUser(db)
    const result = await emitEvent(db, env, {
      name: OTHER_EVENT,
      tenantId: tenant.id,
      payload: { n: 1 },
    })
    expect(result.deliveries).toBe(0)
    expect(stubs(env).queue.messages).toEqual([])
    expect(
      await db.select().from(pluginEvents).where(eq(pluginEvents.id, result.eventId))
    ).toHaveLength(1)
  })
})

describe('dedup', () => {
  it('one event per (tenant, name, key); keyless emits and other tenants are their own', async () => {
    const env = createTestEnv()
    const { tenant } = await createTestTenantWithUser(db)
    const { tenant: other } = await createTestTenantWithUser(db)
    const body = payload()

    const first = await emit(env, tenant.id, body, 'thing:1')
    const again = await emit(env, tenant.id, body, 'thing:1')
    expect(again).toEqual({ eventId: first.eventId, deduplicated: true, deliveries: 0 })
    expect(stubs(env).queue.messages).toHaveLength(3)

    const elsewhere = await emit(env, other.id, body, 'thing:1')
    expect(elsewhere.eventId).not.toBe(first.eventId)
    const a = await emit(env, tenant.id, body)
    const b = await emit(env, tenant.id, body)
    expect(a.eventId).not.toBe(b.eventId)
  })

  it('queues an event that was recorded but never dispatched', async () => {
    const env = createTestEnv()
    const { tenant } = await createTestTenantWithUser(db)
    const first = await emit(env, tenant.id, payload(), 'thing:half')
    stubs(env).queue.clear()
    // The shape a crash between the insert and the enqueue leaves behind.
    await db
      .update(pluginEvents)
      .set({ dispatchedAt: null })
      .where(and(eq(pluginEvents.id, first.eventId), eq(pluginEvents.tenantId, tenant.id)))

    const retry = await emit(env, tenant.id, payload(), 'thing:half')
    expect(retry).toEqual({ eventId: first.eventId, deduplicated: true, deliveries: 3 })
    expect(stubs(env).queue.messages).toHaveLength(3)
  })
})

describe('fan-out', () => {
  it('delivers each subscriber its own message, so a failing one retries alone', async () => {
    const env = createTestEnv()
    const { tenant } = await createTestTenantWithUser(db)
    const { eventId } = await emit(env, tenant.id, payload())
    flaky.fail = true

    const messages = drain(env)
    await consume(env, messages)
    const bySubscriber = Object.fromEntries(messages.map(m => [subscriberOf(m), m]))
    expect(bySubscriber['handler:fixture-ev:steady']?.ack).toHaveBeenCalled()
    expect(bySubscriber[`trigger:${TRIGGERED_AGENT}:0`]?.ack).toHaveBeenCalled()
    const flakyMessage = bySubscriber['handler:fixture-ev:flaky']
    expect(flakyMessage?.retry).toHaveBeenCalled()
    expect(flakyMessage?.ack).not.toHaveBeenCalled()
    expect(handled.map(h => h.handler)).toEqual(['steady'])
    expect(await runsOf(tenant.id)).toHaveLength(1)

    // The retry delivers to the flaky handler only — the others are not run a second time.
    flaky.fail = false
    const retried = { ...(flakyMessage as FakeMessage), ack: vi.fn(), retry: vi.fn(), attempts: 2 }
    await consume(env, [retried])
    expect(retried.ack).toHaveBeenCalled()
    expect(handled.map(h => h.handler)).toEqual(['steady', 'flaky'])
    expect(handled[1]?.event).toMatchObject({ id: eventId, name: THING_HAPPENED })
    expect(await runsOf(tenant.id)).toHaveLength(1)
  })
})

describe('agent triggers', () => {
  it('start a run naming the event, with no requester, once however often it is delivered', async () => {
    const env = createTestEnv()
    const { tenant } = await createTestTenantWithUser(db)
    const { eventId } = await emit(env, tenant.id, payload({ text: 'Triage this.' }))
    const messages = drain(env)
    await consume(env, messages)

    const [run] = await runsOf(tenant.id)
    expect(run).toMatchObject({
      agentKey: TRIGGERED_AGENT,
      input: { text: 'Triage this.' },
      requestedByUserId: null,
      triggerEvent: THING_HAPPENED,
      triggerEventId: eventId,
    })
    expect(stubs(env).workflow?.created.map(c => c.id)).toEqual([run?.id])
    const [activity] = await db
      .select()
      .from(activityEvents)
      .where(
        and(eq(activityEvents.tenantId, tenant.id), eq(activityEvents.subjectId, run?.id ?? ''))
      )
    expect(activity).toMatchObject({
      type: 'agent_run.requested',
      metadata: { agentKey: TRIGGERED_AGENT, via: 'event', event: THING_HAPPENED, eventId },
    })

    // A redelivered trigger message answers the same run.
    const trigger = messages.find(m => subscriberOf(m) === `trigger:${TRIGGERED_AGENT}:0`)
    await consume(env, [{ ...(trigger as FakeMessage), ack: vi.fn(), retry: vi.fn() }])
    expect(await runsOf(tenant.id)).toHaveLength(1)
  })

  it('`where` skips an event; an invalid input is acknowledged, not retried', async () => {
    const env = createTestEnv()
    const { tenant } = await createTestTenantWithUser(db)
    await emit(env, tenant.id, payload({ kind: 'skip' }))
    await emit(env, tenant.id, payload({ text: '   ' }))
    const messages = drain(env).filter(m => subscriberOf(m).startsWith('trigger:'))
    expect(messages).toHaveLength(2)
    const logger = await consume(env, messages)
    for (const m of messages) {
      expect(m.ack).toHaveBeenCalled()
      expect(m.retry).not.toHaveBeenCalled()
    }
    expect(await runsOf(tenant.id)).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 400, code: ERROR_CODES.validationFailed }),
      'event.deliver: the subscriber refused; acknowledging'
    )
  })
})

describe('bindable agents', () => {
  it('lists only the agents that opt in to the event — through the function and the route', async () => {
    expect(bindableAgents(THING_HAPPENED).map(a => a.key)).toEqual([BINDABLE_AGENT])
    expect(bindableAgents(OTHER_EVENT)).toEqual([])

    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const res = await request(`/api/agents/bindable?event=${THING_HAPPENED}`, { headers: cookie })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({
      items: [
        {
          key: BINDABLE_AGENT,
          title: `Fixture ${BINDABLE_AGENT}`,
          description: `${BINDABLE_AGENT} (a test fixture).`,
        },
      ],
    })
    const unknown = await request('/api/agents/bindable?event=fixture-ev.nope', {
      headers: cookie,
    })
    expect(unknown.status).toBe(400)
    expect(await json(unknown)).toMatchObject({ code: ERROR_CODES.eventUnknown })
    expect((await request(`/api/agents/bindable?event=${THING_HAPPENED}`)).status).toBe(401)
  })

  it('starts the named agent for the delivered event, and refuses a forged key', async () => {
    const env = createTestEnv()
    const { tenant } = await createTestTenantWithUser(db)
    const { eventId } = await emit(env, tenant.id, payload({ text: 'Bound start.' }))
    const [row] = await db.select().from(pluginEvents).where(eq(pluginEvents.id, eventId))
    if (!row) throw new Error('no event row')
    const base = makeJobCtx({ db, env })
    const ctx = eventCtx({
      db: base.db,
      config: base.config,
      env,
      logger: silentLogger(),
      event: {
        id: row.id,
        name: row.name as never,
        tenantId: row.tenantId,
        payload: row.payload as never,
        occurredAt: row.createdAt,
      },
    })

    for (const forged of [PLAIN_AGENT, TRIGGERED_AGENT, 'summarize-everything']) {
      await expect(ctx.startBoundAgent(forged)).rejects.toMatchObject({
        statusCode: 403,
        code: ERROR_CODES.agentNotBindable,
      })
    }
    expect(await runsOf(tenant.id)).toEqual([])

    const started = await ctx.startBoundAgent(BINDABLE_AGENT)
    expect(started.deduplicated).toBe(false)
    const again = await ctx.startBoundAgent(BINDABLE_AGENT)
    expect(again).toMatchObject({ runId: started.runId, deduplicated: true })
    const runs = await runsOf(tenant.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      agentKey: BINDABLE_AGENT,
      input: { text: 'Bound start.' },
      triggerEvent: THING_HAPPENED,
      triggerEventId: eventId,
    })
  })
})

describe('tenant isolation', () => {
  it('a delivery naming another tenant finds nothing; a handler sees only its event’s tenant', async () => {
    const env = createTestEnv()
    const { tenant: a } = await createTestTenantWithUser(db)
    const { tenant: b } = await createTestTenantWithUser(db)
    await emit(env, a.id, payload())
    const forged = drain(env).map(m => {
      const body = m.body as { payload: { tenantId: string } }
      return { ...m, body: { ...body, payload: { ...body.payload, tenantId: b.id } } }
    })
    await consume(env, forged)
    for (const m of forged) expect(m.ack).toHaveBeenCalled()
    expect(handled).toEqual([])
    expect(await runsOf(a.id)).toEqual([])
    expect(await runsOf(b.id)).toEqual([])

    await emit(env, b.id, payload())
    await consume(env, drain(env))
    expect(handled.map(h => h.tenantId)).toEqual([b.id, b.id])
    expect((await runsOf(b.id)).map(r => r.tenantId)).toEqual([b.id])
    expect(await runsOf(a.id)).toEqual([])
  })

  it('an event context is bound to its tenant: startAgentRun lands there', async () => {
    const env = createTestEnv()
    const { tenant } = await createTestTenantWithUser(db)
    const base = makeJobCtx({ db, env })
    const ctx = eventCtx({
      db,
      config: base.config,
      env,
      logger: silentLogger(),
      event: {
        id: crypto.randomUUID(),
        name: THING_HAPPENED as never,
        tenantId: tenant.id,
        payload: payload() as never,
        occurredAt: new Date(),
      },
    })
    expect(ctx.tenantId).toBe(tenant.id)
    const { runId } = await ctx.startAgentRun({
      agentKey: PLAIN_AGENT,
      input: { text: 'x' },
      idempotencyKey: 'event-ctx:1',
    })
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId))
    expect(run?.tenantId).toBe(tenant.id)
  })
})

describe('retention', () => {
  it('prunes events past the window across tenants; a later delivery is acknowledged', async () => {
    const env = createTestEnv()
    const { tenant: a } = await createTestTenantWithUser(db)
    const { tenant: b } = await createTestTenantWithUser(db)
    const old = await emit(env, a.id, payload())
    const oldB = await emit(env, b.id, payload())
    const fresh = await emit(env, a.id, payload())
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    for (const [id, tenantId] of [
      [old.eventId, a.id],
      [oldB.eventId, b.id],
    ] as const) {
      await db
        .update(pluginEvents)
        .set({ createdAt: tenDaysAgo })
        .where(and(eq(pluginEvents.id, id), eq(pluginEvents.tenantId, tenantId)))
    }

    const result = await runPruneEvents(db, loadConfig(env).EVENTS_RETENTION_DAYS)
    expect(result.events).toBeGreaterThanOrEqual(2)
    const left = await db.select({ id: pluginEvents.id }).from(pluginEvents)
    const ids = left.map(r => r.id)
    expect(ids).not.toContain(old.eventId)
    expect(ids).not.toContain(oldB.eventId)
    expect(ids).toContain(fresh.eventId)

    const stale = drain(env).filter(
      m => (m.body as { payload: { eventId: string } }).payload.eventId === old.eventId
    )
    await consume(env, stale)
    for (const m of stale) expect(m.ack).toHaveBeenCalled()
    expect(handled.filter(h => h.event.id === old.eventId)).toEqual([])
  })

  it('a deleted tenant takes its events with it', async () => {
    const env = createTestEnv()
    const { tenant } = await createTestTenantWithUser(db)
    const { eventId } = await emit(env, tenant.id, payload())
    await db.delete(tenants).where(eq(tenants.id, tenant.id))
    expect(await db.select().from(pluginEvents).where(eq(pluginEvents.id, eventId))).toEqual([])
  })

  it('defaults to a short window', () => {
    expect(loadConfig(createTestEnv()).EVENTS_RETENTION_DAYS).toBe(7)
  })
})
