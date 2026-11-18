/**
 * Browsing knowledge facts (D43) in the UI: the document viewer's Facts tab (grouped by entity,
 * the entity linked, "Show in document" deep-linking the quote's span, the empty state's hint) and
 * the Knowledge page's Facts view (rows linking to the entity page, filters in the URL and on the
 * wire, the review badge untouched). With the flag off neither exists and nothing under
 * `/api/knowledge` is requested.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DocumentsPage from '@/ui/pages/documents/DocumentsPage'
import DocumentViewPage from '@/ui/pages/documents/DocumentViewPage'
import {
  IDS,
  makeSession,
  paged,
  type RouteTable,
  renderWithProviders,
  stubFetch,
} from './helpers/renderWithProviders'

const now = '2025-06-01T00:00:00Z'
const DOC = '55555555-5555-4555-8555-555555555555'
const ACME = '99999999-9999-4999-8999-999999999999'
const F_PLAN = '70000000-0000-4000-8000-000000000001'
const F_FEE = '70000000-0000-4000-8000-000000000002'
const ON = makeSession({ features: ['knowledge-facts'] })

const doc = {
  id: DOC,
  tenantId: IDS.tenant,
  ownerUserId: IDS.user,
  title: 'Rate card',
  source: 'upload',
  contentType: 'text/plain',
  sizeBytes: 60,
  fileId: null,
  chunkCount: 1,
  status: 'indexed',
  error: null,
  visibility: 'tenant',
  groups: [],
  createdAt: now,
  updatedAt: now,
}

const TEXT = 'Acme Logistics is on the gold plan. The monthly fee is £40 per pallet.'

function fact(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    entityKind: 'staging',
    entityType: 'customer',
    entityId: ACME,
    key: 'plan',
    value: 'gold',
    valueText: 'gold',
    source: {
      kind: 'upload',
      documentId: DOC,
      documentTitle: 'Rate card',
      chunkId: null,
      charStart: 25,
      charEnd: 34,
      quote: 'gold plan',
    },
    confidence: 0.9,
    state: 'accepted',
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

const documentFacts = {
  documentId: DOC,
  entityTypesRegistered: 1,
  groups: [
    {
      entity: {
        kind: 'staging',
        type: 'customer',
        id: ACME,
        name: 'Acme Logistics',
        typeLabel: 'Customer',
      },
      facts: [
        fact(F_PLAN),
        fact(F_FEE, {
          key: 'monthly_fee_gbp',
          valueText: '40',
          state: 'unconfirmed',
          source: { ...fact(F_FEE).source, charStart: 52, charEnd: 70, quote: '£40 per pallet' },
        }),
      ],
    },
  ],
}

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="location">{location.pathname + location.search}</span>
}

function mountViewer(routes: RouteTable, route: string, session = ON) {
  const fetchMock = stubFetch({
    [`/api/ai/documents/${DOC}`]: doc,
    [`/api/ai/documents/${DOC}/content`]: {
      documentId: DOC,
      title: 'Rate card',
      source: 'upload',
      contentType: 'text/plain',
      status: 'indexed',
      totalChars: TEXT.length,
      passages: 1,
      offset: 0,
      returnedChars: TEXT.length,
      text: TEXT,
      hasMore: false,
      nextOffset: null,
    },
    [`/api/ai/documents/${DOC}/passages`]: paged([]),
    '/api/knowledge/review': paged([]),
    ...routes,
  })
  renderWithProviders(
    <>
      <Routes>
        <Route path="/documents/:documentId" element={<DocumentViewPage />} />
      </Routes>
      <LocationProbe />
    </>,
    { session, route }
  )
  return fetchMock
}

const knowledgeCalls = (fetchMock: ReturnType<typeof stubFetch>, path: string) =>
  fetchMock.mock.calls
    .map(([input]) => new URL(String(input), 'http://localhost'))
    .filter(url => url.pathname === path)

describe('Document viewer: Facts tab', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lists the facts grouped by entity, linking the entity and the quote’s span', async () => {
    mountViewer(
      { [`/api/knowledge/documents/${DOC}/facts`]: documentFacts },
      `/documents/${DOC}?tab=facts`
    )
    const group = await screen.findByRole('list', { name: 'Facts about Acme Logistics' })
    expect(screen.getByRole('link', { name: 'Acme Logistics' })).toHaveAttribute(
      'href',
      `/knowledge/entities/customer/${ACME}`
    )
    expect(group).toHaveTextContent('Plan:')
    expect(group).toHaveTextContent('gold')
    expect(group).toHaveTextContent('Unconfirmed')
    // The open fact carries the inline review, not a queue.
    expect(within(group).getByText('Is this still right?')).toBeInTheDocument()
    const show = within(group).getAllByRole('link', { name: /Show in document/ })[1]
    expect(show).toHaveAttribute('href', `/documents/${DOC}?tab=document&offset=52&end=70`)
  })

  it('a span link marks exactly the quote in the text', async () => {
    // jsdom has no layout; the viewer scrolls the anchor into view on mount.
    Element.prototype.scrollIntoView = vi.fn()
    mountViewer({}, `/documents/${DOC}?tab=document&offset=52&end=70`)
    const anchor = await screen.findByTestId('text-anchor')
    expect(anchor.textContent).toBe(TEXT.slice(52, 70))
  })

  it('says why there are none when no entity types are registered', async () => {
    mountViewer(
      {
        [`/api/knowledge/documents/${DOC}/facts`]: {
          documentId: DOC,
          entityTypesRegistered: 0,
          groups: [],
        },
      },
      `/documents/${DOC}?tab=facts`
    )
    expect(await screen.findByText('No facts were read from this document')).toBeInTheDocument()
    expect(screen.getByText(/no entity types to look for yet/)).toBeInTheDocument()
  })

  it('without the flag there is no Facts tab and no knowledge request', async () => {
    const fetchMock = mountViewer({}, `/documents/${DOC}`, makeSession())
    await screen.findByRole('tab', { name: /Document/ })
    expect(screen.queryByRole('tab', { name: /Facts/ })).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/knowledge'))).toBe(
      false
    )
  })
})

const entityList = {
  items: [
    {
      entity: {
        kind: 'staging',
        type: 'customer',
        id: ACME,
        name: 'Acme Logistics',
        typeLabel: 'Customer',
      },
      facts: 4,
      needsLook: 2,
      lastObservedAt: now,
    },
  ],
  pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
  facets: {
    types: [
      { value: 'customer', label: 'Customer', count: 1 },
      { value: 'supplier', label: 'Supplier', count: 3 },
    ],
    sourceKinds: [{ value: 'upload', label: 'Uploaded documents', count: 1 }],
  },
}

function mountKnowledge(route = '/documents?view=facts') {
  const fetchMock = stubFetch({
    '/api/ai/documents': paged([]),
    '/api/knowledge/review': {
      items: [],
      pagination: { page: 1, pageSize: 1, total: 3, totalPages: 3 },
    },
    '/api/knowledge/entities': entityList,
    '/api/groups/mine': paged([]),
    ...{},
  })
  renderWithProviders(
    <>
      <DocumentsPage />
      <LocationProbe />
    </>,
    { session: ON, route }
  )
  return fetchMock
}

describe('Knowledge page: Facts view', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lists entities with counts, each opening its entity page; the review badge is unchanged', async () => {
    mountKnowledge()
    const table = await screen.findByRole('table', { name: 'Entities' })
    const row = within(table).getAllByRole('row')[1] as HTMLElement
    expect(within(row).getByRole('link', { name: 'Acme Logistics' })).toHaveAttribute(
      'href',
      `/knowledge/entities/customer/${ACME}`
    )
    expect(row).toHaveTextContent('Customer')
    expect(row).toHaveTextContent('4')
    expect(row).toHaveTextContent('2')
    const tabs = screen.getByRole('tablist', { name: 'Knowledge view' })
    expect(within(tabs).getByRole('tab', { name: 'Facts' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(within(tabs).getByRole('tab', { name: /To review/ })).toHaveTextContent('3')
  })

  it('filters live in the URL and on the wire', async () => {
    const fetchMock = mountKnowledge()
    const filters = await screen.findByRole('complementary', { name: 'Fact filters' })
    fireEvent.click(await within(filters).findByLabelText(/Supplier/))
    fireEvent.click(within(filters).getByLabelText('Needs a look'))
    fireEvent.click(within(filters).getByLabelText(/Uploaded documents/))
    await waitFor(() => {
      const last = knowledgeCalls(fetchMock, '/api/knowledge/entities').at(-1)
      expect(last?.searchParams.get('type')).toBe('supplier')
      expect(last?.searchParams.get('needsLook')).toBe('true')
      expect(last?.searchParams.get('sourceKind')).toBe('upload')
    })
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/documents?view=facts&ftype=supplier&needs=1&fsource=upload'
    )
    fireEvent.click(within(filters).getByRole('button', { name: 'Clear all' }))
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/documents\?view=facts$/)
    )
  })

  it('switching views drops the Facts filters', async () => {
    mountKnowledge('/documents?view=facts&ftype=supplier')
    fireEvent.click(await screen.findByRole('tab', { name: 'Documents' }))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/documents$/))
  })
})
