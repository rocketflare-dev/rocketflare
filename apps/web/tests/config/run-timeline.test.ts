/**
 * The pure half of the run workspace (issue #17): the timeline reducer and its grouping, the
 * column split, the input summary, the expiry tick chooser, and the JSON-Schema → fields
 * conversion. No database, no DOM — these are data functions, and each of them is guarding a
 * specific way the page could be silently wrong.
 */
import type { JsonSchema } from '@rocketflare/shared/ai/interrupts'
import { describe, expect, it } from 'vitest'
import {
  fieldsFromJsonSchema,
  initialValuesFor,
  submittableValues,
} from '@/ui/pages/agents/fields/schemaFields'
import { formFor, jsonForm } from '@/ui/pages/agents/forms'
import { INPUT_VALUE_PREVIEW_CHARS, summariseInput } from '@/ui/pages/agents/run/inputSummary'
import { expiryState } from '@/ui/pages/agents/run/interrupts/expiry'
import {
  buildTimeline,
  defaultExpanded,
  groupTimeline,
  PREAMBLE_KEY,
  runLayout,
  selectWorkStats,
  TAIL_KEY,
  type TimelineEvent,
  windowGroups,
} from '@/ui/pages/agents/run/timeline/timelineModel'

const at = (s: number) => new Date(`2025-06-01T00:00:${String(s).padStart(2, '0')}Z`)
const eid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const ev = (seq: number, type: string, data: unknown): TimelineEvent => ({
  id: eid(seq),
  seq,
  type,
  data,
  at: at(seq),
})

describe('buildTimeline', () => {
  it('orders by seq, merges a step by key and a tool pair into one row', () => {
    const events = [
      ev(1, 'status', { status: 'running', attempt: 1 }),
      ev(2, 'step', { key: 'search', label: 'Searching', status: 'running' }),
      ev(3, 'tool.start', { name: 'search_knowledge', input: { query: 'x' } }),
      ev(5, 'tool.end', { name: 'search_knowledge', result: { documents: [] } }),
      ev(6, 'text', { text: '**Bold**' }),
      ev(7, 'step', { key: 'search', label: 'Searching', status: 'done', detail: '2 hits' }),
    ]
    const rows = buildTimeline([...events].reverse())
    expect(rows.map(r => r.kind)).toEqual(['status', 'step', 'tool', 'text'])
    const step = rows[1]
    expect(step.kind === 'step' && step.step.detail).toBe('2 hits')
    // The stage keeps the START its `running` row announced; the `done` becomes its end.
    expect(step.at).toEqual(at(2))
    expect(step.kind === 'step' && step.endedAt).toEqual(at(7))
  })

  it('keeps a tool call’s start time and derives its duration — the `at`-overwrite regression', () => {
    const rows = buildTimeline([
      ev(1, 'tool.start', { name: 'get_document', input: { id: 'a' } }),
      ev(2, 'tool.end', { name: 'get_document', result: { text: 'hi' } }),
    ])
    const call = rows[0]
    expect(call.kind).toBe('tool')
    if (call.kind !== 'tool') throw new Error('not a tool row')
    // `at` is the START. The old reducer overwrote it with the answer's timestamp, which is why a
    // per-call duration was impossible.
    expect(call.at).toEqual(at(1))
    expect(call.endedAt).toEqual(at(2))
    expect(call.durationMs).toBe(1000)
    expect(call.input).toEqual({ id: 'a' })
    expect(call.result).toEqual({ text: 'hi' })
    expect(call.done).toBe(true)
  })

  it('is idempotent under duplicated events', () => {
    const events = [
      ev(1, 'tool.start', { name: 'search_knowledge', input: { q: 1 } }),
      ev(2, 'tool.start', { name: 'search_knowledge', input: { q: 2 } }),
      ev(3, 'tool.end', { name: 'search_knowledge', result: { n: 1 } }),
      ev(4, 'tool.end', { name: 'search_knowledge', result: { n: 2 } }),
    ]
    const once = buildTimeline(events)
    // A stream and a fetch both delivering the same rows must not double-push the open-call FIFO.
    const twice = buildTimeline([...events, ...events])
    expect(twice).toEqual(once)
    expect(once).toHaveLength(2)
    expect(once[0].kind === 'tool' && once[0].result).toEqual({ n: 1 })
    expect(once[1].kind === 'tool' && once[1].result).toEqual({ n: 2 })
  })

  it('pairs two parallel calls to one tool by the model’s call id', () => {
    const rows = buildTimeline([
      ev(1, 'tool.start', { name: 'search_knowledge', toolCallId: 'a', input: { q: 'a' } }),
      ev(2, 'tool.start', { name: 'search_knowledge', toolCallId: 'b', input: { q: 'b' } }),
      ev(3, 'tool.end', { name: 'search_knowledge', toolCallId: 'b', result: 'B' }),
      ev(4, 'tool.end', { name: 'search_knowledge', toolCallId: 'a', result: 'A' }),
    ])
    expect(rows.map(r => (r.kind === 'tool' ? r.result : null))).toEqual(['A', 'B'])
  })

  it('reads the new event kinds', () => {
    const rows = buildTimeline([
      ev(1, 'interrupt', {
        interruptId: eid(9),
        key: 'send',
        kind: 'approval',
        message: 'Send it?',
      }),
      ev(2, 'steering', { text: 'try harder', authorUserId: null, authorName: 'Olive' }),
      ev(3, 'artifact', { artifactId: eid(8), key: 'draft', kind: 'markdown', title: 'Draft' }),
    ])
    expect(rows.map(r => r.kind)).toEqual(['interrupt', 'steering', 'artifact'])
  })
})

describe('groupTimeline', () => {
  it('opens on running, attaches, and closes on the matching done', () => {
    const groups = groupTimeline(
      buildTimeline([
        ev(1, 'status', { status: 'running' }),
        ev(2, 'step', { key: 'a', label: 'Stage A', status: 'running' }),
        ev(3, 'tool.start', { name: 't' }),
        ev(4, 'tool.end', { name: 't' }),
        ev(5, 'step', { key: 'a', label: 'Stage A', status: 'done' }),
        ev(6, 'status', { status: 'succeeded' }),
      ])
    )
    expect(groups.map(g => g.key)).toEqual([PREAMBLE_KEY, 'a', TAIL_KEY])
    expect(groups[1].toolCount).toBe(1)
    expect(groups[1].status).toBe('done')
    expect(groups[1].durationMs).toBe(3000)
    // The trailing status row is NOT swallowed by the stage that happened to be last.
    expect(groups[2].rows).toHaveLength(1)
  })

  it('implicitly closes an unfinished step when a different key opens', () => {
    const groups = groupTimeline(
      buildTimeline([
        ev(1, 'step', { key: 'a', label: 'A', status: 'running' }),
        ev(2, 'step', { key: 'b', label: 'B', status: 'running' }),
        ev(3, 'text', { text: 'in b' }),
      ])
    )
    expect(groups.map(g => g.key)).toEqual(['a', 'b'])
    // An unclosed step is a real state: it stays `running` and is shown spinning.
    expect(groups[0].status).toBe('running')
    expect(groups[0].rows).toHaveLength(0)
    expect(groups[1].rows).toHaveLength(1)
  })

  it('expands anything unfinished, the loose stretches and the last group', () => {
    const groups = groupTimeline(
      buildTimeline([
        ev(1, 'step', { key: 'a', label: 'A', status: 'done' }),
        ev(2, 'step', { key: 'b', label: 'B', status: 'running' }),
      ])
    )
    const expanded = defaultExpanded(groups)
    expect(expanded.has(groups[0].headerId)).toBe(false)
    expect(expanded.has(groups[1].headerId)).toBe(true)
  })

  it('windows from the end rather than virtualising', () => {
    const events = Array.from({ length: 50 }, (_, i) =>
      ev(i + 1, 'step', { key: `s${i}`, label: `S${i}`, status: 'done' })
    )
    const groups = groupTimeline(buildTimeline(events))
    const windowed = windowGroups(groups, false, 40)
    expect(windowed.visible).toHaveLength(40)
    expect(windowed.hiddenGroups).toBe(10)
    expect(windowGroups(groups, true, 40).hiddenGroups).toBe(0)
  })
})

describe('selectWorkStats', () => {
  it('counts what the rows genuinely know', () => {
    const stats = selectWorkStats(
      buildTimeline([
        ev(1, 'step', { key: 'a', label: 'A', status: 'done' }),
        ev(2, 'tool.start', { name: 'search_knowledge' }),
        ev(3, 'tool.end', { name: 'search_knowledge', isError: true }),
        ev(4, 'text', { text: 'hi' }),
        ev(5, 'error', { message: 'hiccup', willRetry: true }),
      ])
    )
    expect(stats).toMatchObject({
      steps: 1,
      toolCalls: 1,
      failedToolCalls: 1,
      textTurns: 1,
      errors: 1,
      retries: 1,
    })
    expect(stats.tools).toEqual([{ name: 'search_knowledge', calls: 1, totalMs: 1000 }])
  })
})

describe('expiryState', () => {
  const now = new Date('2025-06-01T00:00:00Z')
  const inMs = (ms: number) => new Date(now.getTime() + ms)

  it('has no state without a deadline', () => {
    expect(expiryState(null, now)).toBeNull()
  })

  it('chooses a tick rate from the distance — and none beyond a day', () => {
    // A seven-day park ticking every second would re-render the panel ~600,000 times.
    expect(expiryState(inMs(7 * 86_400_000), now)?.tickMs).toBeNull()
    expect(expiryState(inMs(2 * 3_600_000), now)?.tickMs).toBe(60_000)
    expect(expiryState(inMs(30_000), now)?.tickMs).toBe(1_000)
    expect(expiryState(inMs(-1), now)?.tickMs).toBeNull()
  })

  it('says how long is left, and that it is urgent under an hour', () => {
    expect(expiryState(inMs(7 * 86_400_000), now)?.label).toBe('expires in 7 days')
    expect(expiryState(inMs(4 * 60_000), now)?.label).toBe('expires in 4 minutes')
    expect(expiryState(inMs(4 * 60_000), now)?.urgent).toBe(true)
    expect(expiryState(inMs(2 * 86_400_000), now)?.urgent).toBe(false)
    expect(expiryState(inMs(-1000), now)).toMatchObject({ expired: true, label: 'expired' })
  })
})

describe('fieldsFromJsonSchema', () => {
  const object = (properties: Record<string, unknown>, required: string[] = []): JsonSchema => ({
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  })

  it('maps the five field types', () => {
    const fields = fieldsFromJsonSchema(
      object(
        {
          topic: { type: 'string', title: 'Topic', maxLength: 100 },
          notes: { type: 'string', description: 'Long' },
          count: { type: 'integer', minimum: 1, maximum: 9 },
          urgent: { type: 'boolean' },
          style: { type: 'string', enum: ['bullets', 'paragraph'], default: 'bullets' },
        },
        ['topic']
      )
    )
    expect(fields?.map(f => [f.name, f.type])).toEqual([
      ['topic', 'text'],
      ['notes', 'textarea'],
      ['count', 'number'],
      ['urgent', 'boolean'],
      ['style', 'select'],
    ])
    expect(fields?.[0].required).toBe(true)
    // A declared `title` wins; without one the property name is made presentable, because
    // `zodToJsonSchema` emits no title and `topic` is not a label anybody wrote.
    expect(fields?.map(f => f.label)).toEqual(['Topic', 'Notes', 'Count', 'Urgent', 'Style'])
    expect(fields?.[2]).toMatchObject({ min: 1, max: 9 })
    expect(fields?.[4].options?.map(o => o.value)).toEqual(['bullets', 'paragraph'])
  })

  it('refuses the WHOLE schema — never one field — for anything outside the closed set', () => {
    // A form that silently drops a field the agent requires is worse than a JSON box, and the
    // failure is invisible until the run 400s.
    const cases: JsonSchema[] = [
      object({ ok: { type: 'string' }, nested: { type: 'object', properties: {} } }),
      object({ ok: { type: 'string' }, list: { type: 'array', items: { type: 'string' } } }),
      object({ ok: { type: 'string' }, ref: { $ref: '#/$defs/Thing' } }),
      object({ ok: { type: 'string' }, either: { anyOf: [{ type: 'string' }] } }),
      object({ ok: { type: 'string' }, mixed: { enum: ['a', 3] } }),
      { type: 'array', items: { type: 'string' } },
    ]
    for (const schema of cases) expect(fieldsFromJsonSchema(schema)).toBeNull()
    expect(fieldsFromJsonSchema(null)).toBeNull()
  })

  it('seeds a draft and drops empty optional values on submit', () => {
    const fields = fieldsFromJsonSchema(
      object({
        topic: { type: 'string' },
        count: { type: 'integer' },
        urgent: { type: 'boolean', default: true },
      })
    )
    if (!fields) throw new Error('expected fields')
    expect(initialValuesFor(fields)).toEqual({ topic: '', count: '', urgent: true })
    // `formValuesSchemaFor` builds a `.strict()` object: an empty string where a number belongs is
    // a 400, so the empty optional is dropped rather than sent.
    expect(submittableValues(fields, { topic: '', count: '3', urgent: true })).toEqual({
      count: 3,
      urgent: true,
    })
  })
})

describe('formFor', () => {
  /**
   * The middle rung had never fired in the running app: the server left `inputJsonSchema`
   * undefined, so every unregistered agent fell to the JSON textarea. This pins the rung itself —
   * the route's half is `tests/api/agent-runs.test.ts`, which checks the registry really emits a
   * schema this renderer accepts.
   */
  it('builds a form from the schema for an agent with no registered form', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { topic: { type: 'string', maxLength: 2000 } },
      required: ['topic'],
    }
    const built = formFor({ key: 'research-topic' as never, inputJsonSchema: schema })
    expect(built).not.toBe(jsonForm)
    expect(built.initial).toEqual({ topic: '' })
    expect(formFor({ key: 'nope' as never, inputJsonSchema: null })).toBe(jsonForm)
    // A registered form still wins the first rung.
    expect(formFor({ key: 'summarize-text', inputJsonSchema: schema })).not.toBe(jsonForm)
  })
})

describe('runLayout', () => {
  it('follows the run while it is working, then the answer once it settles', () => {
    expect(runLayout('queued')).toBe('timeline-major')
    expect(runLayout('running')).toBe('timeline-major')
    // A parked run is still working as far as the reader is concerned: the story is the timeline.
    expect(runLayout('awaiting_input')).toBe('timeline-major')
    expect(runLayout('succeeded')).toBe('output-major')
    expect(runLayout('failed')).toBe('output-major')
    expect(runLayout('cancelled')).toBe('output-major')
  })

  it('lets the reader’s choice win permanently — including across the run settling', () => {
    // The hazard this exists for: somebody widens the timeline on a live run and reads it; the run
    // finishes mid-sentence, and without the override the columns swap underneath them.
    expect(runLayout('running', 'output-major')).toBe('output-major')
    expect(runLayout('succeeded', 'timeline-major')).toBe('timeline-major')
    expect(runLayout('running', null)).toBe('timeline-major')
  })
})

describe('summariseInput', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      question: { type: 'string', title: 'Question' },
      index: { type: 'boolean', title: 'Index the result' },
    },
    required: ['question'],
  }

  it('labels the values from the agent’s own schema', () => {
    const summary = summariseInput({ question: 'Why?', index: true }, schema)
    expect(summary).toEqual({
      kind: 'fields',
      values: [
        { name: 'question', label: 'Question', text: 'Why?', long: false },
        { name: 'index', label: 'Index the result', text: 'Yes', long: false },
      ],
    })
  })

  it('flags a long value for the expand control rather than clipping it silently', () => {
    const long = 'x'.repeat(INPUT_VALUE_PREVIEW_CHARS + 1)
    const summary = summariseInput({ question: long, index: false }, schema)
    expect(summary.kind === 'fields' && summary.values[0]).toMatchObject({ long: true, text: long })
    expect(summary.kind === 'fields' && summary.values[1].text).toBe('No')
  })

  it('falls back to the JSON WHOLE — never per field — and says so in one shape', () => {
    const input = { question: 'Why?', index: false }
    // No schema at all, and a schema outside the closed set: both are "we cannot label this".
    expect(summariseInput(input, null)).toEqual({
      kind: 'json',
      text: JSON.stringify(input, null, 2),
    })
    expect(
      summariseInput(input, { type: 'object', properties: { question: { $ref: '#/$defs/Q' } } })
    ).toMatchObject({ kind: 'json' })
    // A key the schema never declared: labelling the rest would HIDE it, which is the worse answer.
    expect(summariseInput({ ...input, secret: 1 }, schema)).toMatchObject({ kind: 'json' })
    // Not an object at all.
    expect(summariseInput('just a string', schema)).toMatchObject({ kind: 'json' })
  })

  it('renders nothing for an input that carries nothing', () => {
    expect(summariseInput(null, schema)).toEqual({ kind: 'empty' })
    expect(summariseInput({}, schema)).toEqual({ kind: 'empty' })
  })
})
