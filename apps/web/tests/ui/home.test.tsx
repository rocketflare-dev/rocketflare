/**
 * Home: the sections registry (order, placement, guards), each core and feature section in its
 * populated and empty state from ONE `GET /api/home/summary`, the composer's "Connect a model"
 * card and its hand-over to Chat, the poll decision, and the activity feed's arrival motion. The
 * agents section is in `home-runs.test.tsx` (it needs the fixture agent).
 */
import type { ActivityEvent } from '@rocketflare/shared/activity'
import type { HomeDocument, HomeSummary, HomeTeam as HomeTeamPart } from '@rocketflare/shared/home'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes, useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'
import { HOME_POLL_MS, homePollInterval } from '@/ui/hooks/useHome'
import { queryKeys } from '@/ui/lib/query-keys'
import HomeComposer, { friendlyTitle, suggestedPrompts } from '@/ui/pages/chat/HomeComposer'
import HomeDocuments, { documentState } from '@/ui/pages/documents/HomeDocuments'
import Home, { greeting } from '@/ui/pages/Home'
import { arrivedIds, HomeActivity } from '@/ui/pages/home/HomeActivity'
import { HomeSpend, spendDirection } from '@/ui/pages/home/HomeSpend'
import { HomeTeam, roleCounts, teamDescription } from '@/ui/pages/home/HomeTeam'
import { HOME_SECTIONS, type HomeSection, sectionsFor } from '@/ui/pages/home-sections'
import {
  IDS,
  jsonResponse,
  makeSession,
  makeTenant,
  renderWithProviders,
  stubFetch,
} from './helpers/renderWithProviders'

const DOC_ID = '33333333-3333-4333-8333-333333333333'
const at = '2025-06-01T10:00:00.000Z'
const days = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    date: `2025-05-${String(i + 10).padStart(2, '0')}`,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    active: 0,
  }))

const DOC: HomeDocument = {
  id: DOC_ID,
  title: 'Fire safety audit',
  status: 'indexed',
  error: null,
  chunkCount: 12,
  factCount: null,
  createdAt: new Date(at),
}

const TEAM: HomeTeamPart = {
  members: [
    { userId: IDS.user, name: 'Olivia Bennett', avatarUrl: null, role: 'owner' },
    { userId: IDS.otherUser, name: 'Marcus Adeyemi', avatarUrl: null, role: 'admin' },
  ],
  total: 2,
  roles: { owner: 1, admin: 1, member: 0 },
  support: 0,
  invitations: {
    total: 1,
    recent: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        email: 'bob@example.test',
        createdAt: new Date(at),
      },
    ],
  },
}

const INVITED: ActivityEvent = {
  id: '55555555-5555-4555-8555-555555555555',
  tenantId: IDS.tenant,
  userId: IDS.user,
  type: 'member.invited',
  subjectType: 'Invitation',
  subjectId: null,
  metadata: { email: 'bob@example.test', role: 'member' },
  createdAt: new Date(at),
  actor: { name: 'Olivia Bennett', email: 'owner@example.test' },
}

function summary(overrides: Partial<HomeSummary> = {}): HomeSummary {
  return {
    chat: { ready: true },
    agents: { days: days(14), recent: [], previous: { runs: 0, succeeded: 0 }, byAgent: [] },
    knowledge: { recent: [DOC], total: 1, pending: 0 },
    team: TEAM,
    spend: null,
    activity: [INVITED],
    ...overrides,
  }
}

const member = () => makeSession({ tenant: makeTenant({ role: 'member' }) })

/** Render one section with the summary already cached (no fetch needed for the summary). */
function renderSection(ui: React.ReactElement, data: HomeSummary, session = makeSession()) {
  stubFetch({ 'GET /api/home/summary': data })
  const result = renderWithProviders(ui, { session })
  result.queryClient.setQueryData(queryKeys.home.summary, data)
  return result
}

describe('home-sections registry', () => {
  const Stub = () => null
  it('orders each placement by order, then id', () => {
    const sections: HomeSection[] = [
      { id: 'b', placement: 'main', order: 0, Component: Stub },
      { id: 'a', placement: 'main', order: 0, Component: Stub },
      { id: 'first', placement: 'main', order: -1, Component: Stub },
      { id: 'side', placement: 'aside', order: 0, Component: Stub },
    ]
    expect(sectionsFor(sections, 'main').map(s => s.id)).toEqual(['first', 'a', 'b'])
    expect(sectionsFor(sections, 'aside').map(s => s.id)).toEqual(['side'])
  })

  it('puts the composer first and owns one section per area', () => {
    expect(sectionsFor(HOME_SECTIONS, 'lead').map(s => s.id)).toEqual(['chat'])
    expect(HOME_SECTIONS.map(s => s.id).sort()).toEqual(
      ['activity', 'agents', 'chat', 'knowledge', 'spend', 'team'].sort()
    )
  })

  it('renders only the sections whose guard passes, in their columns', async () => {
    const Section = (label: string) => () => <p>{label}</p>
    const sections: HomeSection[] = [
      { id: 'lead', placement: 'lead', order: 0, Component: Section('Lead area') },
      { id: 'work', placement: 'main', order: 0, Component: Section('Work area') },
      {
        id: 'admin',
        placement: 'aside',
        order: 0,
        guard: 'admin',
        Component: Section('Admin area'),
      },
    ]
    stubFetch()
    renderWithProviders(<Home sections={sections} />, { session: member() })
    expect(await screen.findByText('Lead area')).toBeInTheDocument()
    expect(screen.getByText('Work area')).toBeInTheDocument()
    expect(screen.queryByText('Admin area')).not.toBeInTheDocument()
    // A greeting, not the organisation's name and role again (the switcher and rail carry those).
    expect(screen.getByRole('heading', { level: 1, name: /, Olive$/ })).toBeInTheDocument()
  })

  it('isolates a section that throws', async () => {
    const Boom = () => {
      throw new Error('boom')
    }
    const sections: HomeSection[] = [
      { id: 'boom', placement: 'main', order: 0, Component: Boom },
      { id: 'ok', placement: 'main', order: 1, Component: () => <p>Still here</p> },
    ]
    const error = console.error
    console.error = () => {}
    try {
      stubFetch()
      renderWithProviders(<Home sections={sections} />, { session: makeSession() })
      expect(await screen.findByText('Still here')).toBeInTheDocument()
    } finally {
      console.error = error
    }
  })

  it('renders the real sections from one summary request', async () => {
    const fetch = stubFetch({ 'GET /api/home/summary': summary() })
    renderWithProviders(<Home />, { session: makeSession() })
    expect(await screen.findByText('Olivia invited bob@example.test')).toBeInTheDocument()
    expect(await screen.findByRole('textbox', { name: 'Ask anything' })).toBeInTheDocument()
    const calls = fetch.mock.calls.filter(([input]) => String(input).includes('/api/home/summary'))
    expect(calls).toHaveLength(1)
  })
})

describe('greeting', () => {
  it('greets by first name and the time of day', () => {
    expect(greeting('Olivia Bennett', 9)).toBe('Good morning, Olivia')
    expect(greeting('Olivia Bennett', 14)).toBe('Good afternoon, Olivia')
    expect(greeting('Olivia Bennett', 20)).toBe('Good evening, Olivia')
    expect(greeting('Olivia', 2)).toBe('Welcome back, Olivia')
    expect(greeting(null, 9)).toBe('Good morning')
  })
})

describe('homePollInterval', () => {
  it('polls only while a run or a document on Home is in progress', () => {
    expect(homePollInterval(undefined)).toBe(false)
    expect(homePollInterval(summary())).toBe(false)
    const run = {
      id: IDS.tenant,
      agentKey: 'x',
      agentTitle: 'X',
      subject: null,
      error: null,
      requestedBy: null,
      createdAt: new Date(at),
      startedAt: null,
      finishedAt: null,
      tokens: null,
      costUsd: null,
    }
    const agents = (status: string) => ({
      days: [],
      recent: [{ ...run, status }],
      previous: { runs: 0, succeeded: 0 },
      byAgent: [],
    })
    expect(homePollInterval(summary({ agents: agents('running') }))).toBe(HOME_POLL_MS)
    // Parked on a person: the server owes nothing, so no poll.
    expect(homePollInterval(summary({ agents: agents('awaiting_input') }))).toBe(false)
    const pending = { ...DOC, status: 'pending' }
    expect(
      homePollInterval(summary({ knowledge: { recent: [pending], total: 1, pending: 1 } }))
    ).toBe(HOME_POLL_MS)
  })
})

describe('HomeComposer', () => {
  it('reads a machine-made title as nothing, and a file name as words', () => {
    expect(friendlyTitle('Summary 2026-09-17 08:31')).toBeNull()
    expect(friendlyTitle('2026-09-17')).toBeNull()
    expect(friendlyTitle('fleet_maintenance_schedule.pdf')).toBe('fleet maintenance schedule')
    expect(friendlyTitle('Board minutes 2026-09-17')).toBe('Board minutes 2026-09-17')
    expect(friendlyTitle('A'.repeat(60))).toHaveLength(40)
  })

  it('skips machine-made titles, and falls back to one plain prompt', () => {
    const doc = DOC
    expect(suggestedPrompts([{ ...doc, id: 'a', title: 'Summary 2026-09-17 08:31' }, doc])).toEqual(
      ['Summarise “Fire safety audit”']
    )
    expect(suggestedPrompts([{ ...doc, title: 'Summary 2026-09-17 08:31' }])).toEqual([
      'What is in our newest documents?',
    ])
  })

  it('suggests prompts from indexed documents only', () => {
    const doc = DOC
    expect(suggestedPrompts([doc, { ...doc, id: 'x', title: 'Draft', status: 'pending' }])).toEqual(
      ['Summarise “Fire safety audit”']
    )
    expect(suggestedPrompts(undefined)).toEqual([])
  })

  it('becomes "Connect a model" with a link to AI settings when no model resolves', async () => {
    renderSection(<HomeComposer />, summary({ chat: { ready: false } }))
    expect(await screen.findByRole('heading', { name: 'Connect a model' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Connect a model' })).toHaveAttribute(
      'href',
      '/settings?tab=ai'
    )
  })

  it('tells a member to ask an administrator, with no dead link', async () => {
    renderSection(<HomeComposer />, summary({ chat: { ready: false } }), member())
    expect(await screen.findByText(/Ask an administrator/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Connect a model' })).not.toBeInTheDocument()
  })

  it('on Enter starts a conversation and opens Chat carrying the message', async () => {
    const CONVERSATION = '66666666-6666-4666-8666-666666666666'
    function ChatProbe() {
      const location = useLocation()
      return <p>Chat opened with {JSON.stringify(location.state)}</p>
    }
    const data = summary()
    const fetch = stubFetch({
      'GET /api/home/summary': data,
      'POST /api/chat/conversations': jsonResponse({
        id: CONVERSATION,
        tenantId: IDS.tenant,
        userId: IDS.user,
        title: 'New conversation',
        provider: 'anthropic',
        model: 'claude',
        lastMessageAt: null,
        createdAt: at,
        updatedAt: at,
      }),
    })
    const { queryClient } = renderWithProviders(
      <Routes>
        <Route path="/" element={<HomeComposer />} />
        <Route path="/chat/:id" element={<ChatProbe />} />
      </Routes>,
      { session: makeSession() }
    )
    queryClient.setQueryData(queryKeys.home.summary, data)
    const box = await screen.findByRole('textbox', { name: 'Ask anything' })
    fireEvent.change(box, { target: { value: 'What changed this week?' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(
      await screen.findByText('Chat opened with {"chatHandOver":"What changed this week?"}')
    ).toBeInTheDocument()
    expect(
      fetch.mock.calls.some(
        ([input, init]) =>
          String(input).includes('/api/chat/conversations') && init?.method === 'POST'
      )
    ).toBe(true)
  })
})

describe('HomeDocuments', () => {
  it('lists documents with where each one is', async () => {
    const data = summary()
    const doc = DOC
    expect(documentState(doc)).toBe('12 passages')
    expect(documentState({ ...doc, factCount: 1 })).toBe('12 passages · 1 fact')
    expect(documentState({ ...doc, status: 'pending' })).toBe('Indexing…')
    expect(documentState({ ...doc, status: 'failed' })).toBe('Could not be indexed')

    renderSection(<HomeDocuments />, data)
    expect(await screen.findByRole('link', { name: /Fire safety audit/ })).toHaveAttribute(
      'href',
      `/documents/${DOC_ID}`
    )
  })

  it('is a drop zone when the organisation has no documents', async () => {
    renderSection(<HomeDocuments />, summary({ knowledge: { recent: [], total: 0, pending: 0 } }))
    expect(
      await screen.findByRole('button', { name: /Drop a document here, or choose one/ })
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Upload document')).toBeInTheDocument()
  })

  it('renders nothing when the reader may not read documents', async () => {
    const { container } = renderSection(<HomeDocuments />, summary({ knowledge: null }))
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })
})

describe('HomeTeam', () => {
  it('counts the roles in words', () => {
    expect(roleCounts({ owner: 1, admin: 2, member: 0 })).toBe('1 owner · 2 admins')
  })

  it('names a support visitor apart, so the count reconciles with People', () => {
    const roles = { owner: 1, admin: 2, member: 5 }
    expect(teamDescription({ total: 8, roles, support: 0 })).toBe(
      '8 people · 1 owner · 2 admins · 5 members'
    )
    expect(teamDescription({ total: 8, roles, support: 1 })).toBe(
      '8 people · 1 owner · 2 admins · 5 members · 1 support visitor'
    )
  })

  it('shows the faces and the invitations waiting', async () => {
    renderSection(<HomeTeam />, summary())
    expect(
      await screen.findByRole('img', { name: 'Olivia Bennett and Marcus Adeyemi' })
    ).toBeInTheDocument()
    expect(screen.getByText('1 invitation waiting')).toBeInTheDocument()
    expect(screen.getByText('bob@example.test')).toBeInTheDocument()
    expect(screen.queryByLabelText('Email address to invite')).not.toBeInTheDocument()
  })

  it('offers an invite field when it is just you, and sends through the invitation route', async () => {
    const data = summary({
      team: {
        members: [{ userId: IDS.user, name: 'Olivia Bennett', avatarUrl: null, role: 'owner' }],
        total: 1,
        roles: { owner: 1, admin: 0, member: 0 },
        support: 0,
        invitations: { total: 0, recent: [] },
      },
    })
    const fetch = stubFetch({
      'GET /api/home/summary': data,
      'POST /api/invitations': (init: RequestInit | undefined) => {
        const body = JSON.parse(String(init?.body))
        return {
          id: '77777777-7777-4777-8777-777777777777',
          tenantId: IDS.tenant,
          email: body.email,
          role: 'member',
          invitedByUserId: IDS.user,
          status: 'pending',
          invitedByName: 'Olivia Bennett',
          expiresAt: '2025-07-01T00:00:00.000Z',
          acceptedAt: null,
          revokedAt: null,
          createdAt: at,
        }
      },
    })
    const { queryClient } = renderWithProviders(<HomeTeam />, { session: makeSession() })
    queryClient.setQueryData(queryKeys.home.summary, data)
    const input = await screen.findByLabelText('Email address to invite')
    fireEvent.change(input, { target: { value: 'not an email' } })
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter an email address')
    fireEvent.change(input, { target: { value: 'bob@example.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([u, init]) => String(u).includes('/api/invitations') && init?.method === 'POST'
        )
      ).toBe(true)
    )
  })

  it('a member sees who is here, but no invite field and no way into People', async () => {
    const data = summary({
      team: {
        ...TEAM,
        total: 1,
        invitations: null,
        roles: { owner: 1, admin: 0, member: 0 },
      },
    })
    renderSection(<HomeTeam />, data, member())
    expect(await screen.findByRole('heading', { name: 'Team' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Email address to invite')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Manage people' })).not.toBeInTheDocument()
  })
})

describe('HomeSpend', () => {
  const line = (todayUsd: number) => ({
    scope: 'agents' as const,
    dailyBudgetUsd: 5,
    todayUsd,
    days: [
      ...Array.from({ length: 13 }, (_, i) => ({ date: `2025-05-${10 + i}`, costUsd: 0.1 })),
      { date: '2025-05-23', costUsd: todayUsd },
    ],
  })

  it('is absent without a budget', async () => {
    const { container } = renderSection(<HomeSpend />, summary({ spend: null }))
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('reads today against the budget, its history beside it', async () => {
    renderSection(<HomeSpend />, summary({ spend: { lines: [line(1.25)] } }))
    expect(await screen.findByText('$1.25')).toBeInTheDocument()
    expect(screen.getByText(/of \$5\.00 a day/)).toBeInTheDocument()
    expect(
      screen.getByRole('img', { name: /Agents spend per day over the last 14 days/ })
    ).toBeInTheDocument()
    expect(screen.queryByText(/Budget reached/)).not.toBeInTheDocument()
  })

  it('says so when the budget is reached', async () => {
    renderSection(<HomeSpend />, summary({ spend: { lines: [line(5)] } }))
    expect(await screen.findByText(/Budget reached/)).toBeInTheDocument()
  })

  it('names the direction of the history', () => {
    const flat = Array.from({ length: 14 }, () => ({ costUsd: 1 }))
    expect(spendDirection(flat)).toBe('steady')
    expect(
      spendDirection([...flat.slice(0, 7), ...flat.slice(7).map(() => ({ costUsd: 3 }))])
    ).toBe('rising')
  })
})

describe('HomeActivity', () => {
  it('reads in plain words, admin-level only', async () => {
    renderSection(<HomeActivity />, summary())
    expect(await screen.findByText('Olivia invited bob@example.test')).toBeInTheDocument()
    expect(screen.queryByText('member.invited')).not.toBeInTheDocument()
  })

  it('renders nothing for a reader without the activity part', async () => {
    const { container } = renderSection(<HomeActivity />, summary({ activity: null }), member())
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('animates only an item that arrives after the first render', async () => {
    const data = summary()
    const { queryClient } = renderSection(<HomeActivity />, data)
    const first = await screen.findByText('Olivia invited bob@example.test')
    expect(first.closest('li')).not.toHaveAttribute('data-arrived')

    const arrived = {
      ...INVITED,
      id: '88888888-8888-4888-8888-888888888888',
      type: 'conversation.created',
      metadata: {},
    }
    act(() => {
      queryClient.setQueryData(queryKeys.home.summary, {
        ...data,
        activity: [arrived, INVITED],
      })
    })
    const item = await screen.findByText('Olivia started a conversation')
    expect(item.closest('li')).toHaveAttribute('data-arrived', 'true')
    expect(item.closest('li')).toHaveClass('activity-arrive')
    const old = screen.getByText('Olivia invited bob@example.test').closest('li')
    expect(old).not.toHaveAttribute('data-arrived')
  })

  it('arrivedIds: nothing on the first render, then only the new ids', () => {
    expect([...arrivedIds(null, ['a'])]).toEqual([])
    expect([...arrivedIds(new Set(['a']), ['b', 'a'])]).toEqual(['b'])
  })
})
