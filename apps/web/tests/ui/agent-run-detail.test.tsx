/**
 * Run detail (D7, D8): events render in `seq` order (steps merged by key, tool details, text as
 * markdown, error); an active run shows Cancel (POST …/cancel) and polls (`runPollInterval`); an
 * `entity.changed { entity: 'agent-run' }` nudge through `WebSocketProvider` refetches the run.
 */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketProvider } from '@/ui/components/WebSocketProvider'
import { RUN_POLL_MS, runPollInterval } from '@/ui/hooks/useAgents'
import { websocketClient } from '@/ui/lib/websocketClient'
import { buildTimeline } from '@/ui/pages/agents/AgentSteps'
import { formatDuration, RunDetailDrawer } from '@/ui/pages/agents/RunDetailDrawer'
import { useWebSocketStore } from '@/ui/stores/websocketStore'
import {
  IDS,
  makeSession,
  type RouteTable,
  renderWithProviders,
  stubFetch,
} from './helpers/renderWithProviders'

const RUN_ID = '99999999-9999-4999-8999-999999999999'
const t = (s: number) => `2025-06-01T00:00:${String(s).padStart(2, '0')}Z`
const eid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`

const event = (seq: number, type: string, data: unknown) => ({
  id: eid(seq),
  runId: RUN_ID,
  seq,
  type,
  data,
  at: t(seq),
})

const EVENTS = [
  event(1, 'status', { status: 'running', attempt: 1 }),
  event(2, 'step', {
    key: 'precheck',
    label: 'Checking the input',
    status: 'done',
    detail: '12 characters',
  }),
  event(3, 'step', { key: 'summarize', label: 'Summarising', status: 'running' }),
  event(4, 'tool.start', { name: 'submit_summary', input: { style: 'bullets' } }),
  event(5, 'tool.end', { name: 'submit_summary', result: { keyPoints: 2 } }),
  event(6, 'text', { text: '**Bold** summary' }),
  event(7, 'step', {
    key: 'summarize',
    label: 'Summarising',
    status: 'done',
    detail: '2 key points',
  }),
]

const run = (overrides: Record<string, unknown> = {}) => ({
  id: RUN_ID,
  tenantId: IDS.tenant,
  agentKey: 'summarize-text',
  status: 'running',
  input: { text: 'hello', style: 'bullets', index: false },
  output: null,
  error: null,
  requestedByUserId: IDS.user,
  instanceId: RUN_ID,
  attempt: 1,
  startedAt: t(0),
  finishedAt: null,
  cancelRequestedAt: null,
  createdAt: t(0),
  events: EVENTS,
  ...overrides,
})

const AGENTS = {
  items: [
    {
      key: 'summarize-text',
      title: 'Summarize text',
      description: 'Summarises a block of text.',
      promptKey: 'summarize-text',
      exclusive: true,
    },
  ],
}

class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
  send() {}
  close() {
    this.readyState = 3
  }
}

function mount(routes: RouteTable = {}, withSocket = false) {
  const onClose = vi.fn()
  const fetchMock = stubFetch({
    '/api/agents': AGENTS,
    [`/api/agents/runs/${RUN_ID}`]: run(),
    ...routes,
  })
  const ui = <RunDetailDrawer runId={RUN_ID} onClose={onClose} />
  renderWithProviders(withSocket ? <WebSocketProvider>{ui}</WebSocketProvider> : ui, {
    session: makeSession(),
  })
  return { fetchMock, onClose }
}

const detailCalls = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([input]) => String(input).endsWith(`/api/agents/runs/${RUN_ID}`))
    .length

describe('buildTimeline', () => {
  it('orders by seq and merges step rows by key', () => {
    const rows = buildTimeline(
      [...EVENTS].reverse().map(e => ({ ...e, at: new Date(e.at) })) as never
    )
    // One row per tool CALL: the `tool.end` merges into the `tool.start` it answers.
    expect(rows.map(r => r.kind)).toEqual(['status', 'step', 'step', 'tool', 'text'])
    const summarise = rows[2]
    expect(summarise.kind === 'step' && summarise.step.status).toBe('done')
    expect(summarise.kind === 'step' && summarise.step.detail).toBe('2 key points')
    const call = rows[3]
    expect(call.kind === 'tool' && call.done).toBe(true)
    expect(call.kind === 'tool' && call.input).toEqual({ style: 'bullets' })
    expect(call.kind === 'tool' && call.result).toEqual({ keyPoints: 2 })
  })
})

describe('runPollInterval / formatDuration', () => {
  it('polls only while the run is active', () => {
    expect(runPollInterval('queued')).toBe(RUN_POLL_MS)
    expect(runPollInterval('running')).toBe(RUN_POLL_MS)
    expect(runPollInterval('succeeded')).toBe(false)
    expect(runPollInterval('failed')).toBe(false)
    expect(runPollInterval('cancelled')).toBe(false)
    expect(runPollInterval(undefined)).toBe(false)
  })
  it('formats durations', () => {
    expect(formatDuration(840)).toBe('840ms')
    expect(formatDuration(4000)).toBe('4s')
    expect(formatDuration(72_000)).toBe('1m 12s')
  })
})

describe('RunDetailDrawer', () => {
  beforeEach(() => {
    FakeSocket.instances = []
    websocketClient.setFactory(url => new FakeSocket(url) as unknown as WebSocket)
  })
  afterEach(() => {
    cleanup()
    websocketClient.disconnect()
    websocketClient.setFactory(null)
    useWebSocketStore.getState().reset()
    vi.unstubAllGlobals()
  })

  it('renders the events in order with tool details and markdown text', async () => {
    mount()
    expect(await screen.findByText('Checking the input')).toBeInTheDocument()
    const items = screen.getByRole('list', { name: 'Run timeline' }).querySelectorAll('li')
    expect(Array.from(items).map(li => li.getAttribute('data-event-kind'))).toEqual([
      'status',
      'step',
      'step',
      'tool',
      'text',
    ])
    // The merged step shows its final detail once, not twice
    expect(screen.getAllByText('Summarising')).toHaveLength(1)
    expect(screen.getByText('· 2 key points')).toBeInTheDocument()
    // One row for the call and its answer, with both payloads behind the one details toggle
    expect(screen.getAllByText('Submit summary')).toHaveLength(1)
    const details = screen.getAllByText('Details')[0].closest('details')
    expect(details).toHaveTextContent('"style": "bullets"')
    expect(details).toHaveTextContent('"keyPoints": 2')
    // Markdown rendered
    expect(screen.getByText('Bold').tagName).toBe('STRONG')
    expect(screen.getByText('Running')).toBeInTheDocument()
  })

  it('shows Cancel while active and posts to /cancel', async () => {
    const { fetchMock } = mount({
      [`POST /api/agents/runs/${RUN_ID}/cancel`]: run({
        cancelRequestedAt: t(9),
        events: undefined,
      }),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel run' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith(`/api/agents/runs/${RUN_ID}/cancel`) && init?.method === 'POST'
        )
      ).toBe(true)
    )
  })

  it('hides Cancel and shows the typed output + document link once settled', async () => {
    mount({
      [`/api/agents/runs/${RUN_ID}`]: run({
        status: 'succeeded',
        finishedAt: t(4),
        output: {
          summary: 'Short summary',
          keyPoints: ['One', 'Two'],
          documentId: '55555555-5555-4555-8555-555555555555',
        },
        events: [event(1, 'error', { message: 'Model hiccup', attempt: 1, willRetry: true })],
      }),
    })
    expect(await screen.findByText('Short summary')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument()
    expect(screen.getByText('One')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Indexed as a searchable document/ })).toHaveAttribute(
      'href',
      '/search?documentId=55555555-5555-4555-8555-555555555555'
    )
    expect(screen.getByText('Model hiccup')).toBeInTheDocument()
    expect(screen.getByText('· retrying')).toBeInTheDocument()
    expect(screen.getByText('4s')).toBeInTheDocument()
    // Raw toggle
    fireEvent.click(screen.getByRole('button', { name: 'Raw JSON' }))
    expect(screen.getByText(/"keyPoints"/)).toBeInTheDocument()
  })

  it('keeps the cancel button usable as Force cancel once a cancel was requested', async () => {
    mount({
      [`/api/agents/runs/${RUN_ID}`]: run({ cancelRequestedAt: t(2) }),
    })
    const button = await screen.findByRole('button', { name: 'Force cancel' })
    expect(button).toBeEnabled()
  })

  it("renders a research run's answer with its citations as search links", async () => {
    mount({
      [`/api/agents/runs/${RUN_ID}`]: run({
        agentKey: 'research-topic',
        status: 'succeeded',
        input: { topic: 'Who reviews access requests?' },
        finishedAt: t(4),
        output: {
          answer: 'A global admin reviews them.',
          citations: [
            { documentId: '66666666-6666-4666-8666-666666666666', title: 'Onboarding handbook' },
          ],
          turns: 2,
        },
        events: [],
      }),
    })
    expect(await screen.findByText('A global admin reviews them.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Onboarding handbook' })).toHaveAttribute(
      'href',
      '/search?documentId=66666666-6666-4666-8666-666666666666'
    )
  })

  it('refetches the run on an entity.changed agent-run nudge', async () => {
    const { fetchMock } = mount({}, true)
    await screen.findByText('Checking the input')
    await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0))
    const socket = FakeSocket.instances.at(-1) as FakeSocket
    act(() => socket.open())
    const before = detailCalls(fetchMock)

    act(() =>
      socket.message({
        type: 'entity.changed',
        tenantId: IDS.tenant,
        at: t(8),
        payload: { entity: 'agent-run', id: RUN_ID },
      })
    )
    await waitFor(() => expect(detailCalls(fetchMock)).toBeGreaterThan(before))
  })
})
