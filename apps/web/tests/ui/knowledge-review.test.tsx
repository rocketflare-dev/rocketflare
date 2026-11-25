/**
 * Knowledge facts review (D43) in the shell: the count badge on the Knowledge nav item (MY open
 * items, `GET /api/knowledge/review?mine=true` total), the "To review" view on the Knowledge page
 * (`/documents?view=review` — items with their entity link, both sides of a conflict, possible
 * matches), and that NONE of it shows — or fetches — without the `knowledge-facts` feature.
 * Drives the REAL `useNavGuard`, for an owner and a member.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SideNav from '@/ui/components/SideNav'
import DocumentsPage from '@/ui/pages/documents/DocumentsPage'
import { withoutRepeatedConflicts } from '@/ui/pages/documents/ReviewList'
import {
  IDS,
  makeSession,
  makeTenant,
  paged,
  type RouteTable,
  renderWithProviders,
  stubFetch,
} from './helpers/renderWithProviders'

const ENTITY = '99999999-9999-4999-8999-999999999999'
const TWIN = '98989898-9898-4989-8989-989898989898'
const F_A = '70000000-0000-4000-8000-000000000002'
const F_B = '70000000-0000-4000-8000-000000000003'
const DOC_A = '55555555-5555-4555-8555-555555555555'
const now = '2026-02-01T09:00:00Z'

function fact(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    entityKind: 'staging',
    entityType: 'customer',
    entityId: ENTITY,
    key: 'monthly_fee_gbp',
    value: 285,
    valueText: '285',
    source: {
      kind: 'upload',
      documentId: DOC_A,
      documentTitle: 'Contract 2025',
      chunkId: null,
      charStart: null,
      charEnd: null,
      quote: 'Monthly Fee: £285',
    },
    confidence: 0.9,
    state: 'conflicting',
    supersededById: null,
    conflictsWith: [],
    validFrom: null,
    validTo: null,
    observedAt: now,
    confirmedBy: null,
    confirmedAt: null,
    reviewerUserId: IDS.user,
    visibility: 'tenant',
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

const ITEMS = [
  {
    kind: 'fact',
    fact: fact(F_A, { conflictsWith: [F_B] }),
    entity: { kind: 'staging', type: 'customer', id: ENTITY, name: 'Harbour View Dental' },
    conflicts: [
      fact(F_B, {
        valueText: '310',
        conflictsWith: [F_A],
        source: { ...fact(F_B).source, documentTitle: 'Email 2026', quote: 'now £310' },
      }),
    ],
  },
  {
    kind: 'possibleMatch',
    entity: {
      id: TWIN,
      type: 'customer',
      name: 'HVD Ltd',
      aliases: [],
      promotedTo: null,
      mergedInto: null,
      createdAt: now,
      updatedAt: now,
    },
    candidates: [{ kind: 'staging', id: ENTITY, label: 'Harbour View Dental', score: 0.7 }],
    reviewerUserId: IDS.user,
  },
]

/** The other side of ITEMS[0]'s conflict, as the API also lists it: shown once, not twice. */
const OTHER_SIDE = {
  kind: 'fact',
  fact: fact(F_B, { valueText: '310', conflictsWith: [F_A] }),
  entity: ITEMS[0]?.entity,
  conflicts: [fact(F_A, { conflictsWith: [F_B] })],
}

const REVIEW = {
  items: [...ITEMS, OTHER_SIDE],
  pagination: { page: 1, pageSize: 25, total: 3, totalPages: 1 },
}
const COUNT = { items: [ITEMS[0]], pagination: { page: 1, pageSize: 1, total: 3, totalPages: 3 } }

const ON = makeSession({ features: ['knowledge-facts'] })

function stub(routes: RouteTable = {}) {
  return stubFetch({
    '/api/health': { status: 'ok', version: '1.2.3', env: 'staging' },
    '/api/ai/documents': paged([]),
    '/api/knowledge/review': (_init: RequestInit | undefined, url: URL) =>
      url.searchParams.get('mine') === 'true' && url.searchParams.get('pageSize') === '1'
        ? COUNT
        : REVIEW,
    ...routes,
  })
}

const knowledgeCalls = (fetchMock: ReturnType<typeof stub>) =>
  fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/knowledge'))

afterEach(() => vi.unstubAllGlobals())

describe('the Knowledge nav badge', () => {
  it('counts MY open items, from the review list’s total', async () => {
    const fetchMock = stub()
    renderWithProviders(<SideNav />, { session: ON })
    const link = await screen.findByRole('link', { name: /Knowledge/ })
    await waitFor(() => expect(within(link).getByText('3')).toBeInTheDocument())
    expect(within(link).getByText('3 waiting for you')).toBeInTheDocument()
    const url = String(knowledgeCalls(fetchMock)[0]?.[0])
    expect(url).toContain('mine=true')
    expect(url).toContain('pageSize=1')
  })

  it('is absent, and never asked for, without the feature', async () => {
    const fetchMock = stub()
    renderWithProviders(<SideNav />, { session: makeSession() })
    const link = await screen.findByRole('link', { name: /Knowledge/ })
    expect(within(link).queryByText('3')).not.toBeInTheDocument()
    expect(knowledgeCalls(fetchMock)).toEqual([])
  })
})

describe('the To review view on the Knowledge page', () => {
  it('without the feature: no view switch, no request', async () => {
    const fetchMock = stub()
    renderWithProviders(<DocumentsPage />, {
      session: makeSession(),
      route: '/documents?view=review',
    })
    expect(await screen.findByText('No documents yet')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /To review/ })).not.toBeInTheDocument()
    expect(knowledgeCalls(fetchMock)).toEqual([])
  })

  it('carries my count on the tab, and lists items linking to their entity', async () => {
    stub()
    renderWithProviders(<DocumentsPage />, { session: ON, route: '/documents?view=review' })
    const tab = await screen.findByRole('tab', { name: /To review/ })
    expect(tab).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(within(tab).getByText('3')).toBeInTheDocument())

    const list = await screen.findByRole('list', { name: 'Review items' })
    // The fact item's entity, and the possible match's candidate: both the same entity page.
    const links = within(list).getAllByRole('link', { name: 'Harbour View Dental' })
    expect(links).toHaveLength(2)
    for (const link of links) {
      expect(link).toHaveAttribute('href', `/knowledge/entities/customer/${ENTITY}`)
    }
    // Both sides of the conflict, each with its own source and "Use this one".
    expect(within(list).getByText('now £310')).toBeInTheDocument()
    expect(within(list).getByText('Monthly Fee: £285')).toBeInTheDocument()
    expect(within(list).getAllByRole('button', { name: 'Use this one' })).toHaveLength(2)
    // The possible match, with Merge and Keep separate.
    expect(
      within(list).getByRole('button', { name: 'Merge HVD Ltd into Harbour View Dental' })
    ).toBeInTheDocument()
    expect(within(list).getByRole('button', { name: 'Keep separate' })).toBeInTheDocument()
    // The documents table is not on this view.
    expect(screen.queryByRole('table', { name: 'Documents' })).not.toBeInTheDocument()
  })

  it('shows a member no "Only mine" toggle (they only ever see theirs)', async () => {
    stub()
    renderWithProviders(<DocumentsPage />, {
      session: makeSession({
        tenant: makeTenant({ role: 'member' }),
        features: ['knowledge-facts'],
      }),
      route: '/documents?view=review',
    })
    await screen.findByRole('list', { name: 'Review items' })
    expect(screen.queryByLabelText('Only mine')).not.toBeInTheDocument()
  })

  it('an owner can narrow to their own', async () => {
    stub()
    renderWithProviders(<DocumentsPage />, { session: ON, route: '/documents?view=review' })
    expect(await screen.findByLabelText('Only mine')).toBeInTheDocument()
  })
})

describe('withoutRepeatedConflicts', () => {
  it('drops a fact item an earlier item already shows as a conflict', () => {
    const out = withoutRepeatedConflicts([...ITEMS, OTHER_SIDE] as never)
    expect(out).toHaveLength(2)
    expect(out.map(i => i.kind)).toEqual(['fact', 'possibleMatch'])
  })
})
