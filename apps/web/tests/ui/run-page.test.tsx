/**
 * The run workspace (issue #17). It is a PAGE — no `role="dialog"`, a breadcrumb back to `/agents`,
 * its own route — and the things it is arranged to get right are all here:
 *
 * - the action panel is pinned above the timeline and posts the right payload per kind;
 * - a 409 is INFORMATION ("someone else answered this"), not a red toast;
 * - a non-approver sees one sentence, not disabled buttons;
 * - focus lands on the heading, never on Approve;
 * - a parked run does not poll and its badge does not pulse;
 * - the input is ONE block above the columns (never a tab), labelled from the agent's own schema
 *   and falling back to the JSON whole;
 * - the column split follows the run's state until the reader overrides it, and then never again;
 * - an `entity.changed { entity: 'agent-run' }` nudge refetches the run and leaves
 *   `['agent-run-agui']` — the key the stream owns — untouched.
 */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '@/ui/components/shared/Toast'
import { WebSocketProvider } from '@/ui/components/WebSocketProvider'
import { RUN_POLL_MS, runOwesAnswer, runPollInterval } from '@/ui/hooks/useAgents'
import { formatDuration } from '@/ui/lib/format'
import { queryKeys } from '@/ui/lib/query-keys'
import { websocketClient } from '@/ui/lib/websocketClient'
import RunPage from '@/ui/pages/agents/RunPage'
import { useWebSocketStore } from '@/ui/stores/websocketStore'
import {
  errorResponse,
  IDS,
  makeSession,
  paged,
  type RouteTable,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'

const RUN_ID = '99999999-9999-4999-8999-999999999999'
const ASK_ID = '77777777-7777-4777-8777-777777777777'
const DOC_ID = '66666666-6666-4666-8666-666666666666'
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
  interrupts: [],
  artifacts: [],
  ...overrides,
})

const ask = (spec: unknown, overrides: Record<string, unknown> = {}) => ({
  id: ASK_ID,
  tenantId: IDS.tenant,
  runId: RUN_ID,
  key: 'send',
  kind: (spec as { kind: string }).kind,
  reason: 'confirmation',
  message: (spec as { message: string }).message,
  toolCallId: null,
  responseSchema: null,
  spec,
  status: 'pending',
  payload: null,
  expiresAt: null,
  resolvedAt: null,
  resolvedByUserId: null,
  createdAt: t(8),
  updatedAt: t(8),
  ...overrides,
})

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', title: 'Text' },
    style: { type: 'string', title: 'Style', enum: ['bullets', 'paragraph'] },
    index: { type: 'boolean', title: 'Index the result' },
  },
  required: ['text'],
}

const agents = (overrides: Record<string, unknown> = {}) => ({
  items: [
    {
      key: 'summarize-text',
      title: 'Summarize text',
      description: 'Summarises a block of text.',
      promptKey: 'summarize-text',
      exclusive: true,
      approvers: 'requester',
      inputJsonSchema: INPUT_SCHEMA,
      ...overrides,
    },
  ],
})

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

function mount(routes: RouteTable = {}, options: { socket?: boolean; session?: object } = {}) {
  const fetchMock = stubFetch({
    '/api/agents': agents(),
    '/api/agents/interrupts': paged([]),
    [`/api/agents/runs/${RUN_ID}`]: run(),
    // The stream's snapshot. The page is built against the poll path, so this only ever adds.
    [`/api/agents/runs/${RUN_ID}/agui`]: { events: [], lastSeq: 0 },
    ...routes,
  })
  // The same route App.tsx mounts, so `useParams().runId` is real rather than injected.
  const ui = (
    <Routes>
      <Route path="/agents/runs/:runId" element={<RunPage />} />
    </Routes>
  )
  const { queryClient } = renderWithProviders(
    options.socket ? <WebSocketProvider>{ui}</WebSocketProvider> : ui,
    { session: makeSession(options.session ?? {}), route: `/agents/runs/${RUN_ID}` }
  )
  return { fetchMock, queryClient }
}

const detailCalls = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([input]) => String(input).endsWith(`/api/agents/runs/${RUN_ID}`))
    .length

describe('runOwesAnswer / runPollInterval / formatDuration', () => {
  it('stops polling a run parked on a human — days of requests, otherwise', () => {
    expect(runOwesAnswer('queued')).toBe(true)
    expect(runOwesAnswer('running')).toBe(true)
    // `isRunActive('awaiting_input')` is TRUE (the exclusive index needs it) and this must not be.
    expect(runOwesAnswer('awaiting_input')).toBe(false)
    expect(runPollInterval('running')).toBe(RUN_POLL_MS)
    expect(runPollInterval('awaiting_input')).toBe(false)
    expect(runPollInterval('succeeded')).toBe(false)
    expect(runPollInterval(undefined)).toBe(false)
  })
  it('formats durations', () => {
    expect(formatDuration(840)).toBe('840ms')
    expect(formatDuration(4000)).toBe('4s')
    expect(formatDuration(72_000)).toBe('1m 12s')
  })
})

describe('RunPage', () => {
  beforeEach(() => {
    FakeSocket.instances = []
    websocketClient.setFactory(url => new FakeSocket(url) as unknown as WebSocket)
  })
  afterEach(() => {
    cleanup()
    websocketClient.disconnect()
    websocketClient.setFactory(null)
    useWebSocketStore.getState().reset()
    useToastStore.setState({ toasts: [] })
    vi.unstubAllGlobals()
  })

  it('is a page, not a dialog: breadcrumb, grouped timeline, tabs', async () => {
    mount()
    expect(await screen.findByText('Summarising')).toBeInTheDocument()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(screen.getByRole('link', { name: 'Agents' })).toHaveAttribute('href', '/agents')
    // Two stages, each a disclosure; the tool call and the text live inside the one that is open.
    expect(screen.getByRole('button', { name: /Checking the input/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.getByText('Bold').tagName).toBe('STRONG')
    expect(screen.getByText('Submit summary')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Output/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Usage/ })).toBeInTheDocument()
  })

  it('renders the input ABOVE the columns from the agent’s schema, and has no Input tab', async () => {
    mount()
    const input = await screen.findByRole('region', { name: 'Run input' })
    // One home for one fact: it was `?tab=input`, four clicks from the thing it explains.
    expect(screen.queryByRole('tab', { name: /Input/ })).not.toBeInTheDocument()
    expect(input).toHaveTextContent('Text')
    expect(input).toHaveTextContent('hello')
    // Labelled values, not a JSON blob.
    expect(input.querySelector('pre')).toBeNull()
    expect(input.compareDocumentPosition(screen.getByLabelText('Run timeline'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  it('falls back to the JSON WHOLE when the schema cannot label the input', async () => {
    mount({ '/api/agents': agents({ inputJsonSchema: null }) })
    const input = await screen.findByRole('region', { name: 'Run input' })
    expect(input.querySelector('pre')?.textContent).toContain('"style": "bullets"')
  })

  it('moves the timestamps into Usage and keeps duration in the header', async () => {
    mount()
    const summary = await screen.findByRole('region', { name: 'Run summary' })
    expect(summary).toHaveTextContent('Duration')
    // Three rows of chrome above the fold, read once in a hundred visits: they live with the rest
    // of what the rows know instead.
    expect(summary).not.toHaveTextContent('Requested')
    fireEvent.click(screen.getByRole('tab', { name: /Usage/ }))
    expect(await screen.findByText('Requested')).toBeInTheDocument()
    expect(screen.getByText('Started')).toBeInTheDocument()
    expect(screen.getByText('Finished')).toBeInTheDocument()
  })

  it('gives the timeline the major column while working, the output once settled', async () => {
    mount()
    await screen.findByText('Summarising')
    expect(document.querySelector('[data-layout]')).toHaveAttribute('data-layout', 'timeline-major')
    cleanup()
    mount({ [`/api/agents/runs/${RUN_ID}`]: run({ status: 'succeeded', finishedAt: t(4) }) })
    await screen.findByText('Summarising')
    expect(document.querySelector('[data-layout]')).toHaveAttribute('data-layout', 'output-major')
  })

  it('keeps the reader’s split once they choose one', async () => {
    mount()
    await screen.findByText('Summarising')
    fireEvent.click(screen.getByRole('button', { name: /Widen output/ }))
    expect(document.querySelector('[data-layout]')).toHaveAttribute('data-layout', 'output-major')
    // And the button now offers the other way round, which is the whole control.
    expect(screen.getByRole('button', { name: /Widen timeline/ })).toBeInTheDocument()
  })

  it('renders a knowledge tool’s documents as one line each, not as cards', async () => {
    mount({
      [`/api/agents/runs/${RUN_ID}`]: run({
        events: [
          ...EVENTS,
          event(8, 'tool.start', { name: 'search_knowledge', input: { query: 'leave' } }),
          event(9, 'tool.end', {
            name: 'search_knowledge',
            result: {
              documents: [{ documentId: DOC_ID, title: 'Handbook', totalPassages: 3 }],
            },
          }),
        ],
      }),
    })
    const link = await screen.findByRole('link', { name: 'Handbook' })
    expect(link).toHaveAttribute('href', `/documents/${DOC_ID}`)
    // `DocumentCard` renders an <article>; in a timeline row four of those bury the next stage.
    expect(document.querySelector('article[data-document]')).toBeNull()
    expect(link.closest('[data-document]')).toHaveTextContent('3 passages')
  })

  it('expands a collapsed stage on click and keeps the choice', async () => {
    mount()
    const header = await screen.findByRole('button', { name: /Checking the input/ })
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'true')
  })

  it('shows the typed output through the outputs registry once settled', async () => {
    mount({
      [`/api/agents/runs/${RUN_ID}`]: run({
        status: 'succeeded',
        finishedAt: t(4),
        output: {
          summary: 'Short summary',
          keyPoints: ['One', 'Two'],
          documentId: '55555555-5555-4555-8555-555555555555',
        },
      }),
    })
    expect(await screen.findByText('Short summary')).toBeInTheDocument()
    expect(screen.getByText('One')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open the indexed document/ })).toHaveAttribute(
      'href',
      '/documents/55555555-5555-4555-8555-555555555555'
    )
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument()
  })

  it('renders a failure above the tabs, never inside one', async () => {
    mount({
      [`/api/agents/runs/${RUN_ID}`]: run({
        status: 'failed',
        finishedAt: t(4),
        error: 'The model refused',
      }),
    })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The model refused')
    // Above the tab bar: it is visible whichever tab is selected.
    expect(alert.compareDocumentPosition(screen.getByRole('tab', { name: /Output/ }))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  it('keeps Cancel usable as Force cancel once a cancel was requested', async () => {
    mount({ [`/api/agents/runs/${RUN_ID}`]: run({ cancelRequestedAt: t(2) }) })
    expect(await screen.findByRole('button', { name: 'Force cancel' })).toBeEnabled()
  })

  it('refetches the run on an entity.changed agent-run nudge without wiping the stream’s key', async () => {
    const { fetchMock, queryClient } = mount({}, { socket: true })
    await screen.findByText('Summarising')
    queryClient.setQueryData(queryKeys.agentRunAgui.detail(RUN_ID), {
      events: [],
      lastSeq: 0,
      marker: 'kept',
    })
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
    // The stream owns `['agent-run-agui']`; a run nudge must not throw away what it built, or the
    // stream becomes a more expensive poll.
    expect(queryClient.getQueryData(queryKeys.agentRunAgui.detail(RUN_ID))).toMatchObject({
      marker: 'kept',
    })
  })
})

describe('the action panel', () => {
  beforeEach(() => {
    websocketClient.setFactory(url => new FakeSocket(url) as unknown as WebSocket)
  })
  afterEach(() => {
    cleanup()
    websocketClient.setFactory(null)
    useToastStore.setState({ toasts: [] })
    vi.unstubAllGlobals()
  })

  const parked = (spec: unknown, overrides: Record<string, unknown> = {}) => ({
    [`/api/agents/runs/${RUN_ID}`]: run({
      status: 'awaiting_input',
      interrupts: [ask(spec, overrides)],
    }),
  })

  const APPROVAL = {
    kind: 'approval',
    title: 'Send this summary?',
    message: 'Send this summary to 412 subscribers?',
    tool: {
      name: 'send_email',
      input: { subject: 'Weekly', recipients: 412 },
      allowEdits: false,
    },
  }

  it('pins the question above the timeline and focuses the heading, never Approve', async () => {
    mount(parked(APPROVAL))
    const heading = await screen.findByRole('heading', { name: 'Send this summary?' })
    // An autofocused destructive button plus a stray Enter is how 412 subscribers get an email.
    expect(document.activeElement).toBe(heading)
    const panel = screen.getByRole('region', { name: 'Action required' })
    expect(panel).toHaveTextContent('Send this summary to 412 subscribers?')
    expect(panel).toHaveTextContent('Declining stops the run.')
    // Above the timeline, which is what somebody arriving from a notification needs.
    expect(panel.compareDocumentPosition(screen.getByLabelText('Run timeline'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(screen.getByText('Send email')).toBeInTheDocument()
  })

  it('posts status resolved for approve and status cancelled for reject', async () => {
    const { fetchMock } = mount(parked(APPROVAL), {})
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    const url = `/api/agents/runs/${RUN_ID}/interrupts/${ASK_ID}`
    await waitFor(() =>
      // No `approved` boolean anywhere: `status` IS the decision, AG-UI's own vocabulary.
      expect(requestBody(fetchMock, `POST ${url}`)).toEqual({ status: 'resolved', payload: {} })
    )
  })

  it('posts a rejection as status cancelled', async () => {
    const { fetchMock } = mount(parked(APPROVAL), {})
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }))
    const url = `/api/agents/runs/${RUN_ID}/interrupts/${ASK_ID}`
    await waitFor(() =>
      expect(requestBody(fetchMock, `POST ${url}`)).toEqual({ status: 'cancelled', payload: {} })
    )
  })

  it('posts the chosen value for a choice ask', async () => {
    const { fetchMock } = mount(
      parked({
        kind: 'choice',
        message: 'Which customer?',
        options: [
          { value: 'acme', label: 'Acme' },
          { value: 'globex', label: 'Globex' },
        ],
        allowOther: false,
      })
    )
    fireEvent.click(await screen.findByLabelText('Globex'))
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    const url = `/api/agents/runs/${RUN_ID}/interrupts/${ASK_ID}`
    await waitFor(() =>
      expect(requestBody(fetchMock, `POST ${url}`)).toEqual({
        status: 'resolved',
        payload: { value: 'globex' },
      })
    )
  })

  it('validates an input ask with the shared schema before posting', async () => {
    const { fetchMock } = mount(
      parked({ kind: 'input', message: 'What subject line?', multiline: false })
    )
    const url = `/api/agents/runs/${RUN_ID}/interrupts/${ASK_ID}`
    fireEvent.click(await screen.findByRole('button', { name: 'Send answer' }))
    // A green client-side pass can never become a 400, because it is the SAME schema.
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0))
    expect(requestBody(fetchMock, `POST ${url}`)).toBeUndefined()

    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Weekly digest' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, `POST ${url}`)).toEqual({
        status: 'resolved',
        payload: { text: 'Weekly digest' },
      })
    )
  })

  it('renders a form ask through the one field renderer and drops empty optionals', async () => {
    const { fetchMock } = mount(
      parked({
        kind: 'form',
        message: 'Fill this in',
        fields: [
          { name: 'subject', label: 'Subject', type: 'text', required: true },
          { name: 'copies', label: 'Copies', type: 'number', required: false },
        ],
      })
    )
    fireEvent.change(await screen.findByLabelText(/Subject/), { target: { value: 'Hi' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    const url = `/api/agents/runs/${RUN_ID}/interrupts/${ASK_ID}`
    await waitFor(() =>
      // `formValuesSchemaFor` is `.strict()`: an empty optional must not travel as `''`.
      expect(requestBody(fetchMock, `POST ${url}`)).toEqual({
        status: 'resolved',
        payload: { values: { subject: 'Hi' } },
      })
    )
  })

  it('renders a 409 as information — not a toast, not red', async () => {
    mount({
      ...parked(APPROVAL),
      [`POST /api/agents/runs/${RUN_ID}/interrupts/${ASK_ID}`]: () =>
        errorResponse(409, 'That question has already been answered', 'interrupt_not_pending'),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    expect(await screen.findByText(/Someone else answered this/)).toBeInTheDocument()
    expect(document.querySelector('.alert-info')).toBeTruthy()
    expect(document.querySelector('.alert-error')).toBeNull()
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('shows a non-approver one sentence, not disabled buttons', async () => {
    mount(
      {
        '/api/agents': agents({ approvers: 'admin' }),
        ...parked(APPROVAL),
      },
      { session: { tenant: { id: IDS.tenant, name: 'Acme', slug: 'acme', role: 'member' } } }
    )
    expect(await screen.findByText('Waiting for an administrator to answer.')).toBeInTheDocument()
    // A disabled control with a tooltip is how you tell a member they are second-class.
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    // They still SEE the panel: they need to know the run is blocked, and on whom.
    expect(screen.getByRole('region', { name: 'Action required' })).toHaveTextContent(
      'Send this summary to 412 subscribers?'
    )
  })

  it('unmounts the moment the run is no longer parked', async () => {
    mount({
      [`/api/agents/runs/${RUN_ID}`]: run({
        status: 'running',
        interrupts: [ask(APPROVAL, { status: 'resolved' })],
      }),
    })
    await screen.findByText('Summarising')
    expect(screen.queryByRole('region', { name: 'Action required' })).not.toBeInTheDocument()
  })
})
