/**
 * The demo seed's run timelines (`scripts/lib/seed-run-events.ts`), read through the REAL timeline
 * model: a seeded run must show the steps its output claims, in the shapes the runtime records,
 * and a failed or cancelled one must stop where it stopped — never a bare Started → Finished.
 */
import { describe, expect, it } from 'vitest'
import {
  buildTimeline,
  groupTimeline,
  selectWorkStats,
  type TimelineEvent,
} from '@/ui/pages/agents/run/timeline/timelineModel'
import {
  modelCall,
  pastRunEvents,
  type SeedRunEvent,
  seedEvent,
} from '../../scripts/lib/seed-run-events'

const START = Date.UTC(2026, 0, 1)
const toTimeline = (events: SeedRunEvent[]): TimelineEvent[] =>
  events.map((e, i) => ({
    id: `${String(i + 1).padStart(8, '0')}-0000-4000-8000-000000000000`,
    seq: i + 1,
    type: e.type,
    data: e.data,
    at: new Date(START + e.offsetSeconds * 1000),
  }))

/** A two-turn loop: a model call asks for a tool, the tool answers, a second call finishes. */
const BASE: SeedRunEvent[] = [
  seedEvent('status', { status: 'running', attempt: 1 }, 0),
  seedEvent('step', { key: 'work', label: 'Working', status: 'running' }, 0.2),
  ...modelCall({
    model: 'm',
    n: 1,
    from: 0.3,
    to: 4,
    messages: 1,
    tools: 2,
    maxTokens: 1024,
    usage: { inputTokens: 100, outputTokens: 20 },
    toolCalls: ['lookup'],
  }),
  seedEvent('tool.start', { name: 'lookup', input: { q: 'x' }, toolCallId: 't1' }, 4.1),
  seedEvent('tool.end', { name: 'lookup', toolCallId: 't1', isError: false, result: {} }, 5),
  ...modelCall({
    model: 'm',
    n: 2,
    from: 5.1,
    to: 18,
    messages: 3,
    tools: 2,
    maxTokens: 1024,
    usage: { inputTokens: 300, outputTokens: 200 },
    toolCalls: ['finish'],
  }),
  seedEvent('step', { key: 'work', label: 'Working', status: 'done' }, 18.1),
  seedEvent('status', { status: 'succeeded' }, 20),
]

describe('seeded run timelines', () => {
  it('records a model call the way the runtime does: one model row with its usage', () => {
    const rows = buildTimeline(toTimeline(BASE))
    const stats = selectWorkStats(rows)
    expect(stats).toMatchObject({ steps: 1, modelCalls: 2, toolCalls: 1 })
    const model = rows.find(row => row.kind === 'tool' && row.model)
    expect(model).toMatchObject({ done: true, isError: false })
  })

  it('a past success replays every step at its own duration', () => {
    const events = pastRunEvents(BASE, { status: 'succeeded', durationSeconds: 40 })
    expect(events).toHaveLength(BASE.length)
    expect(events.at(-1)?.offsetSeconds).toBe(40)
    expect(selectWorkStats(buildTimeline(toTimeline(events)))).toMatchObject({
      modelCalls: 2,
      toolCalls: 1,
    })
  })

  it('a past failure shows what it got through, closes the call in flight as an error, and settles', () => {
    const events = pastRunEvents(BASE, {
      status: 'failed',
      error: 'The provider timed out',
      durationSeconds: 60,
    })
    // Never past the base's first half: a failure must not show a finished answer.
    expect(
      events.some(e => e.type === 'step' && (e.data as { status: string }).status === 'done')
    ).toBe(false)
    const rows = buildTimeline(toTimeline(events))
    const calls = rows.filter(row => row.kind === 'tool')
    expect(calls.every(row => row.kind === 'tool' && row.done)).toBe(true)
    expect(calls.at(-1)).toMatchObject({ model: true, isError: true })
    expect(rows.some(row => row.kind === 'error')).toBe(true)
    expect(events.at(-1)).toMatchObject({
      type: 'status',
      data: { status: 'failed', error: 'The provider timed out' },
      offsetSeconds: 60,
    })
    // The step that was working when it failed is shown stopped, not finished.
    expect(groupTimeline(rows).find(group => group.key === 'work')?.status).not.toBe('done')
  })

  it('a quick cancel keeps only what happened before it', () => {
    const events = pastRunEvents(BASE, { status: 'cancelled', durationSeconds: 2 })
    expect(events.map(e => e.type)).toEqual(['status', 'step', 'tool.start', 'tool.end', 'status'])
    expect(events.at(-1)?.data).toEqual({ status: 'cancelled' })
  })
})
