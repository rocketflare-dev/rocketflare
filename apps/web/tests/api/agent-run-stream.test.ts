/**
 * `GET /api/agents/runs/:id/agui/stream` (issue #7) — the live tail of a run's timeline.
 *
 * Split in two on purpose. The ROUTE is driven through the real Hono app for everything that
 * happens before the first frame (403 / 404 / 400) and for runs that close at once (settled,
 * parked); the LOOP is driven as a plain function over a recording sink with `{ now, sleep }`
 * injected, because a stream that ticks for ten minutes is not something a test should wait for.
 */
import {
  RUN_STREAM_HEARTBEAT_MS,
  RUN_STREAM_IDLE_CAP_MS,
  RUN_STREAM_IDLE_MS,
  RUN_STREAM_MAX_MS,
  RUN_STREAM_POLL_MS,
  RUN_STREAM_SLOW_MS,
  RUN_STREAM_TAIL_LIMIT,
} from '@rocketflare/shared/ai/agents'
import { kitAguiEventSchema } from '@rocketflare/shared/ai/agui'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { requestInterrupt } from '@/api/services/agents/interrupts'
import {
  type RunStreamSink,
  runStreamBody,
  runStreamTickMs,
  tailRunEvents,
} from '@/api/services/agents/run-stream'
import type { Database } from '@/db/client'
import { type AgentRunRow, agentRunEvents, agentRuns } from '@/db/schema'
import { splitSseFrames } from '../helpers/ai'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { request } from '../helpers/request'
import { createTestEnv, stubs } from '../mocks/bindings'

const db = setupTestDatabase()

const PROTO_ACCEPT = 'application/vnd.ag-ui.event+proto'

async function actor(role: 'owner' | 'member' = 'owner') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

async function makeRun(
  database: Database,
  tenantId: string,
  userId: string | null,
  status: AgentRunRow['status'] = 'running'
): Promise<AgentRunRow> {
  const [row] = await database
    .insert(agentRuns)
    .values({
      tenantId,
      agentKey: 'research-topic',
      status,
      input: { question: 'why' },
      requestedByUserId: userId,
      // No instance id: `reconcileRun` then has nothing to ask, which keeps the route tests off the
      // Workflow binding except where the spy is the point.
      instanceId: null,
    })
    .returning()
  if (!row) throw new Error('no run')
  return row
}

let nextSeq = 0
async function addEvent(
  database: Database,
  run: AgentRunRow,
  type: 'text' | 'step' | 'status' | 'tool.start' | 'tool.end',
  data: unknown
): Promise<number> {
  nextSeq += 1
  await database
    .insert(agentRunEvents)
    .values({ tenantId: run.tenantId, runId: run.id, seq: nextSeq, type, data })
  return nextSeq
}

/** A sink that records everything as text, and can be made to look like a closed tab. */
function recorder() {
  const decoder = new TextDecoder()
  let text = ''
  let aborted = false
  const sink: RunStreamSink = {
    write: async chunk => {
      text += typeof chunk === 'string' ? chunk : decoder.decode(chunk)
    },
    get aborted() {
      return aborted
    },
  }
  return {
    sink,
    abort: () => {
      aborted = true
    },
    get text() {
      return text
    },
    frames: () => splitSseFrames(text),
    events: () =>
      splitSseFrames(text)
        .filter(f => f.data)
        .map(f => kitAguiEventSchema.parse(JSON.parse(f.data))),
  }
}

/** A clock the loop cannot outrun: every `sleep` advances it, so the caps are reached in ticks. */
function fakeClock(start = 0) {
  let t = start
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('GET /api/agents/runs/:id/agui/stream — before the first frame', () => {
  it('404s a run in another tenant and a run another member requested', async () => {
    const a = await actor('owner')
    const other = await actor('owner')
    const mine = await makeRun(db, a.tenant.id, a.user.id, 'succeeded')

    const cross = await request(`/api/agents/runs/${mine.id}/agui/stream`, {
      headers: other.cookie,
    })
    expect(cross.status).toBe(404)

    const stranger = await createTestUser(db)
    await linkUserToTenant(db, stranger.id, a.tenant.id, 'member')
    const strangerCookie = sessionCookieHeader(
      await createTestSession(db, stranger.id, a.tenant.id)
    )
    const hidden = await request(`/api/agents/runs/${mine.id}/agui/stream`, {
      headers: strangerCookie,
    })
    expect(hidden.status).toBe(404)
    expect(await hidden.json()).toMatchObject({ statusCode: 404 })
  })

  it('401s anonymously and 404s a non-uuid id', async () => {
    const a = await actor()
    expect((await request('/api/agents/runs/abc/agui/stream')).status).toBe(401)
    expect(
      (await request('/api/agents/runs/not-a-uuid/agui/stream', { headers: a.cookie })).status
    ).toBe(404)
  })

  it('400s a garbage ?afterSeq= — as JSON, before any frame', async () => {
    const a = await actor()
    const run = await makeRun(db, a.tenant.id, a.user.id, 'succeeded')
    const res = await request(`/api/agents/runs/${run.id}/agui/stream?afterSeq=banana`, {
      headers: a.cookie,
    })
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toMatchObject({ code: 'validation_failed' })

    const negative = await request(`/api/agents/runs/${run.id}/agui/stream?afterSeq=-1`, {
      headers: a.cookie,
    })
    expect(negative.status).toBe(400)
  })

  it('ignores a garbage Last-Event-ID rather than refusing it — the browser sets that one', async () => {
    const a = await actor()
    const run = await makeRun(db, a.tenant.id, a.user.id, 'succeeded')
    const res = await request(`/api/agents/runs/${run.id}/agui/stream`, {
      headers: { ...a.cookie, 'Last-Event-ID': 'nonsense' },
    })
    expect(res.status).toBe(200)
    const events = splitSseFrames(await res.text())
      .filter(f => f.data)
      .map(f => kitAguiEventSchema.parse(JSON.parse(f.data)))
    expect(events[0]?.type).toBe('RUN_STARTED')
  })

  it('calls reconcileRun EXACTLY once — never per tick', async () => {
    const a = await actor()
    const env = createTestEnv()
    const workflow = stubs(env).workflow
    const run = await makeRun(db, a.tenant.id, a.user.id, 'running')
    await db.update(agentRuns).set({ instanceId: run.id }).where(eq(agentRuns.id, run.id))
    // The instance says it is over, so the read path settles the row and the stream closes at once.
    workflow?.setStatus(run.id, { status: 'complete' })

    const res = await request(
      `/api/agents/runs/${run.id}/agui/stream`,
      { headers: a.cookie },
      { env }
    )
    expect(res.status).toBe(200)
    await res.text()
    expect(workflow?.statusCalls.filter(id => id === run.id)).toHaveLength(1)
  })

  it('sets the SSE headers a buffering proxy would otherwise defeat', async () => {
    const a = await actor()
    const run = await makeRun(db, a.tenant.id, a.user.id, 'succeeded')
    const res = await request(`/api/agents/runs/${run.id}/agui/stream`, { headers: a.cookie })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(res.headers.get('x-accel-buffering')).toBe('no')
    await res.text()
  })
})

describe('GET /api/agents/runs/:id/agui/stream — runs that close at once', () => {
  it('a settled run emits its whole projection and closes', async () => {
    const a = await actor()
    const run = await makeRun(db, a.tenant.id, a.user.id, 'running')
    await addEvent(db, run, 'text', { text: 'Done thinking.' })
    await db
      .update(agentRuns)
      .set({ status: 'succeeded', output: { answer: 'yes' } })
      .where(eq(agentRuns.id, run.id))

    const res = await request(`/api/agents/runs/${run.id}/agui/stream`, { headers: a.cookie })
    const frames = splitSseFrames(await res.text())
    const events = frames.filter(f => f.data).map(f => kitAguiEventSchema.parse(JSON.parse(f.data)))
    expect(events.map(e => e.type)).toEqual([
      'RUN_STARTED',
      'STATE_SNAPSHOT',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED',
    ])
  })

  it('a PARKED run emits the interrupt outcome and CLOSES — the seven-day test', async () => {
    // A run waiting on a person holds no connection, no query and no invocation: the page
    // re-opens on the existing nudge when the answer lands.
    const a = await actor()
    const run = await makeRun(db, a.tenant.id, a.user.id, 'running')
    const interrupt = await requestInterrupt(db, {
      tenantId: a.tenant.id,
      runId: run.id,
      key: 'send-it',
      spec: { kind: 'approval', message: 'Send this email?' },
    })
    await addEvent(db, run, 'status', { status: 'awaiting_input' })
    await db.update(agentRuns).set({ status: 'awaiting_input' }).where(eq(agentRuns.id, run.id))

    const res = await request(`/api/agents/runs/${run.id}/agui/stream`, { headers: a.cookie })
    const events = splitSseFrames(await res.text())
      .filter(f => f.data)
      .map(f => kitAguiEventSchema.parse(JSON.parse(f.data)))
    const terminal = events.at(-1)
    expect(terminal).toMatchObject({
      type: 'RUN_FINISHED',
      // `'interrupt'`, never `'interrupted'` — the wrong literal silently drops the outcome.
      outcome: { type: 'interrupt', interrupts: [{ id: interrupt.id }] },
    })
  })
})

describe('the loop', () => {
  it('writes `id:` on the LAST frame of each row group and on no other frame in it', async () => {
    const a = await actor()
    const run = await makeRun(db, a.tenant.id, a.user.id, 'running')
    const textSeq = await addEvent(db, run, 'text', { text: 'One.' })
    await db.update(agentRuns).set({ status: 'succeeded' }).where(eq(agentRuns.id, run.id))

    const rec = recorder()
    await runStreamBody({ db, tenantId: a.tenant.id, run, afterSeq: 0 }, rec.sink, fakeClock())
    const frames = rec.frames().filter(f => f.data)
    const withIds = frames.map(f => ({
      type: JSON.parse(f.data).type as string,
      id: f.id,
    }))
    expect(withIds).toEqual([
      { type: 'RUN_STARTED', id: null },
      { type: 'STATE_SNAPSHOT', id: '0' },
      { type: 'TEXT_MESSAGE_START', id: null },
      { type: 'TEXT_MESSAGE_CONTENT', id: null },
      // Only here: a drop before this point resumes at the PREVIOUS row and replays the whole
      // group, rather than leaving the browser holding a message that never closes.
      { type: 'TEXT_MESSAGE_END', id: String(textSeq) },
      // The terminal event is derived from the run row, not from a `seq`.
      { type: 'RUN_FINISHED', id: null },
    ])
  })

  it('resumes from ?afterSeq= without replaying the head, and a mid-group drop resumes at the previous row', async () => {
    const a = await actor()
    const run = await makeRun(db, a.tenant.id, a.user.id, 'running')
    const first = await addEvent(db, run, 'text', { text: 'One.' })
    const second = await addEvent(db, run, 'text', { text: 'Two.' })
    await db.update(agentRuns).set({ status: 'succeeded' }).where(eq(agentRuns.id, run.id))

    // A client that got the whole first group (its `id:` was `first`) then lost the connection
    // half way through the second resumes here — and gets the second group WHOLE.
    const rec = recorder()
    await runStreamBody({ db, tenantId: a.tenant.id, run, afterSeq: first }, rec.sink, fakeClock())
    const events = rec.events()
    expect(events.map(e => e.type)).toEqual([
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED',
    ])
    expect(
      rec
        .frames()
        .filter(f => f.data)
        .at(2)?.id
    ).toBe(String(second))
    expect(rec.text).not.toContain('RUN_STARTED')
  })

  it('delivers rows that arrive AFTER the connection opened', async () => {
    const a = await actor()
    const run = await makeRun(db, a.tenant.id, a.user.id, 'running')
    const clock = fakeClock()
    let ticks = 0
    const rec = recorder()
    const sleep = async (ms: number) => {
      clock.sleep(ms)
      ticks += 1
      if (ticks === 2) await addEvent(db, run, 'text', { text: 'Late.' })
      if (ticks === 4) {
        await db.update(agentRuns).set({ status: 'succeeded' }).where(eq(agentRuns.id, run.id))
      }
    }
    await runStreamBody({ db, tenantId: a.tenant.id, run, afterSeq: 0 }, rec.sink, {
      now: clock.now,
      sleep,
    })
    expect(rec.events().map(e => e.type)).toContain('TEXT_MESSAGE_CONTENT')
    expect(rec.events().at(-1)?.type).toBe('RUN_FINISHED')
  })

  it('closes with NO terminal event at the idle cap', async () => {
    const a = await actor()
    const run = await makeRun(db, a.tenant.id, a.user.id, 'running')
    const rec = recorder()
    const clock = fakeClock()
    const outcome = await runStreamBody(
      { db, tenantId: a.tenant.id, run, afterSeq: 0 },
      rec.sink,
      clock
    )
    expect(outcome).toBe('idle_cap')
    expect(rec.events().map(e => e.type)).toEqual(['RUN_STARTED', 'STATE_SNAPSHOT'])
    expect(rec.text).not.toContain('RUN_ERROR')
    expect(rec.text).not.toContain('RUN_FINISHED')
  })

  it('closes with NO terminal event at the duration cap', async () => {
    const a = await actor()
    const run = await makeRun(db, a.tenant.id, a.user.id, 'running')
    const rec = recorder()
    const clock = fakeClock()
    let ticks = 0
    // A row every few ticks keeps the idle cap at bay, so the DURATION cap is what fires.
    const sleep = async (ms: number) => {
      clock.sleep(ms)
      ticks += 1
      if (ticks % 5 === 0) await addEvent(db, run, 'status', { status: 'running' })
    }
    const outcome = await runStreamBody({ db, tenantId: a.tenant.id, run, afterSeq: 0 }, rec.sink, {
      now: clock.now,
      sleep,
    })
    expect(outcome).toBe('duration_cap')
    expect(rec.text).not.toContain('RUN_ERROR')
    expect(rec.text).not.toContain('RUN_FINISHED')
  })

  it('stops as soon as the client goes away, and says nothing about it', async () => {
    const a = await actor()
    const run = await makeRun(db, a.tenant.id, a.user.id, 'running')
    const rec = recorder()
    const clock = fakeClock()
    const outcome = await runStreamBody({ db, tenantId: a.tenant.id, run, afterSeq: 0 }, rec.sink, {
      now: clock.now,
      sleep: async ms => {
        clock.sleep(ms)
        rec.abort()
      },
    })
    expect(outcome).toBe('aborted')
    expect(rec.text).not.toContain('RUN_ERROR')
  })

  it('emits NO RUN_ERROR when the body itself fails — decision 6', async () => {
    // A read-stream failure is not a run failure: the run is a durable Workflow in another isolate
    // and is almost certainly fine. Closing with no terminal event already means "reconnect".
    const a = await actor()
    const run = await makeRun(db, a.tenant.id, a.user.id, 'running')
    const rec = recorder()
    const broken = {
      ...rec.sink,
      write: async () => {
        throw new Error('socket went away')
      },
    } as RunStreamSink
    await expect(
      runStreamBody({ db, tenantId: a.tenant.id, run, afterSeq: 0 }, broken, fakeClock())
    ).rejects.toThrow('socket went away')
    expect(rec.text).toBe('')
  })

  it('heartbeats with a comment frame over SSE', async () => {
    const a = await actor()
    const run = await makeRun(db, a.tenant.id, a.user.id, 'running')
    const rec = recorder()
    const clock = fakeClock()
    await runStreamBody({ db, tenantId: a.tenant.id, run, afterSeq: 0 }, rec.sink, clock)
    expect(rec.text).toContain(': ping')
    // One every RUN_STREAM_HEARTBEAT_MS of silence, not one per tick.
    const pings = rec.text.split(': ping').length - 1
    expect(pings).toBeLessThanOrEqual(Math.ceil(RUN_STREAM_IDLE_CAP_MS / RUN_STREAM_HEARTBEAT_MS))
    expect(pings).toBeGreaterThan(0)
  })

  it('under protobuf: no `id:` lines, NO comment frames, and TOOL_CALL_RESULT still dropped', async () => {
    // A `: ping` is not a valid protobuf frame; writing one poisons everything after it.
    const a = await actor()
    const run = await makeRun(db, a.tenant.id, a.user.id, 'running')
    await addEvent(db, run, 'tool.start', { name: 'search_knowledge', toolCallId: 'c1' })
    await addEvent(db, run, 'tool.end', { name: 'search_knowledge', toolCallId: 'c1', result: 'x' })
    await db.update(agentRuns).set({ status: 'succeeded' }).where(eq(agentRuns.id, run.id))

    const rec = recorder()
    await runStreamBody(
      { db, tenantId: a.tenant.id, run, afterSeq: 0, accept: PROTO_ACCEPT },
      rec.sink,
      fakeClock()
    )
    expect(rec.text).not.toContain('id:')
    expect(rec.text).not.toContain(': ping')
    expect(rec.text).not.toContain('data:')
    expect(rec.text).not.toContain('TOOL_CALL_RESULT')
    expect(rec.text.length).toBeGreaterThan(0)
  })

  it('never heartbeats into a binary stream even after a long silence', async () => {
    const a = await actor()
    const run = await makeRun(db, a.tenant.id, a.user.id, 'running')
    const rec = recorder()
    const outcome = await runStreamBody(
      { db, tenantId: a.tenant.id, run, afterSeq: 0, accept: PROTO_ACCEPT },
      rec.sink,
      fakeClock()
    )
    expect(outcome).toBe('idle_cap')
    // A protobuf payload may well contain a `:` byte; what must never appear is the COMMENT frame.
    expect(rec.text).not.toContain(': ping')
    expect(rec.text).not.toContain('\n\n:')
  })
})

describe('the tail query and the cadence', () => {
  it('reads only rows after the cursor, in order, bounded', async () => {
    const a = await actor()
    const run = await makeRun(db, a.tenant.id, a.user.id, 'running')
    const one = await addEvent(db, run, 'status', { status: 'running' })
    const two = await addEvent(db, run, 'status', { status: 'running' })
    expect((await tailRunEvents(db, a.tenant.id, run.id, one)).map(r => r.seq)).toEqual([two])
    expect(await tailRunEvents(db, a.tenant.id, run.id, two)).toEqual([])
    // Another tenant's cursor sees nothing of this run.
    const other = await actor()
    expect(await tailRunEvents(db, other.tenant.id, run.id, 0)).toEqual([])
    expect(await tailRunEvents(db, a.tenant.id, run.id, 0, 1)).toHaveLength(1)
  })

  it('slows down only while nothing is happening, and never past the poll it replaces', () => {
    expect(runStreamTickMs(0)).toBe(RUN_STREAM_POLL_MS)
    expect(runStreamTickMs(9)).toBe(RUN_STREAM_POLL_MS)
    expect(runStreamTickMs(10)).toBe(RUN_STREAM_SLOW_MS)
    expect(runStreamTickMs(29)).toBe(RUN_STREAM_SLOW_MS)
    expect(runStreamTickMs(30)).toBe(RUN_STREAM_IDLE_MS)
    expect(runStreamTickMs(10_000)).toBeLessThan(3000)
  })

  it('bounds one tick and keeps the caps reachable', () => {
    expect(RUN_STREAM_TAIL_LIMIT).toBe(200)
    expect(RUN_STREAM_IDLE_CAP_MS).toBeLessThan(RUN_STREAM_MAX_MS)
  })
})
