/**
 * `/search`: search POSTs `{ query, limit, documentId?, filters? }` and renders hits ranked with
 * dense/lexical badges; `?documentId=` preselects the per-document filter and is sent; the filter
 * column offers the facets' sources and types (grouped by label) and a date range, all in the URL
 * and re-running the search; the facts block shows only with the flag; an empty knowledge base
 * shows an empty state pointing at `/documents`.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SearchPage from '@/ui/pages/documents/SearchPage'
import {
  IDS,
  makeSession,
  makeTenant,
  paged,
  type RouteTable,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'

const now = '2025-06-01T00:00:00Z'
const DOC_A = '55555555-5555-4555-8555-555555555555'
const DOC_B = '66666666-6666-4666-8666-666666666666'

const doc = (overrides: Record<string, unknown> = {}) => ({
  id: DOC_A,
  tenantId: IDS.tenant,
  ownerUserId: IDS.user,
  title: 'Onboarding guide',
  source: 'upload',
  contentType: 'text/plain',
  sizeBytes: 1200,
  fileId: null,
  chunkCount: 3,
  status: 'indexed',
  error: null,
  visibility: 'tenant',
  groups: [],
  createdAt: now,
  updatedAt: now,
  ...overrides,
})

const DOCS = paged([doc(), doc({ id: DOC_B, title: 'Release notes' })])

const hit = (rank: number, overrides: Record<string, unknown> = {}) => ({
  chunkId: `${String(rank).padStart(8, '0')}-0000-4000-8000-000000000000`,
  documentId: DOC_A,
  title: 'Onboarding guide',
  text: `Snippet ${rank}`,
  score: 0.5 / rank,
  rank,
  seq: rank - 1,
  documentPassages: 4,
  headingPath: null,
  page: null,
  charOffset: (rank - 1) * 1000,
  denseRank: rank,
  lexicalRank: null,
  rerankScore: null,
  ...overrides,
})

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="location">{location.pathname + location.search}</span>
}

const FACETS = {
  total: 4,
  sources: [
    { value: 'upload', count: 3 },
    { value: 'agent:weekly-digest', count: 1 },
  ],
  contentTypes: [
    { value: 'text/plain', count: 2 },
    { value: 'application/vnd.ms-excel', count: 1 },
    { value: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', count: 1 },
  ],
  oldest: now,
  newest: now,
  staleEmbeddings: 0,
}

function mount(routes: RouteTable = {}, route = '/search', session = makeSession()) {
  const fetchMock = stubFetch({
    '/api/ai/documents': DOCS,
    '/api/ai/documents/facets': FACETS,
    ...routes,
  })
  renderWithProviders(
    <>
      <SearchPage />
      <LocationProbe />
    </>,
    { session, route }
  )
  return fetchMock
}

/** Every search body sent, in order. */
const searchBodies = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        String(input).includes('/api/ai/documents/search') && init?.method?.toUpperCase() === 'POST'
    )
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)

const searchCalls = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(
    ([input, init]) =>
      String(input).includes('/api/ai/documents/search') && init?.method?.toUpperCase() === 'POST'
  ).length

describe('Search page', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('searches and renders ranked hits with dense/lexical badges', async () => {
    const fetchMock = mount({
      'POST /api/ai/documents/search': (init: RequestInit | undefined) => {
        const { query } = JSON.parse(String(init?.body)) as { query: string }
        return {
          query,
          lexical: 'used',
          hits: [
            hit(1, { lexicalRank: 2 }),
            hit(2, { denseRank: null, lexicalRank: 1, documentId: DOC_B, title: 'Release notes' }),
          ],
        }
      },
    })
    fireEvent.change(await screen.findByLabelText('Search query'), {
      target: { value: 'how do I onboard' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    await waitFor(() =>
      expect(requestBody(fetchMock, 'POST /api/ai/documents/search')).toEqual({
        query: 'how do I onboard',
        limit: 10,
      })
    )
    const results = await screen.findByRole('region', { name: 'Search results' })
    const rows = within(results).getAllByRole('listitem')
    expect(rows.map(r => r.getAttribute('data-rank'))).toEqual(['1', '2'])
    expect(rows[0]).toHaveTextContent('#1')
    expect(rows[0]).toHaveTextContent('passage 1 of 4')
    expect(rows[0]).toHaveTextContent('dense #1')
    expect(rows[0]).toHaveTextContent('lexical #2')
    expect(rows[0]).toHaveTextContent('Snippet 1')
    expect(rows[1]).toHaveTextContent('lexical #1')
    expect(rows[1]).not.toHaveTextContent('dense #')
    // Hits group under a card per document, built from the list the page already fetched.
    expect(within(results).getByRole('link', { name: 'Release notes' })).toBeInTheDocument()
    // The hit's own link is the passage deep link, carrying the offset, the chunk and the query.
    expect(within(rows[0] as HTMLElement).getByRole('link')).toHaveAttribute(
      'href',
      expect.stringContaining(`/documents/${DOC_A}?offset=`)
    )
    // The submitted query is written to the URL (replace) so the result page can be shared
    expect(screen.getByTestId('location')).toHaveTextContent('/search?q=how+do+I+onboard')
  })

  it('?q= prefills the box and runs the search on mount, once', async () => {
    const fetchMock = mount(
      { 'POST /api/ai/documents/search': { query: 'pallets', hits: [hit(1)], lexical: 'used' } },
      '/search?q=pallets'
    )
    expect(screen.getByLabelText('Search query')).toHaveValue('pallets')
    await waitFor(() =>
      expect(requestBody(fetchMock, 'POST /api/ai/documents/search')).toEqual({
        query: 'pallets',
        limit: 10,
      })
    )
    await screen.findByRole('region', { name: 'Search results' })
    expect(searchCalls(fetchMock)).toBe(1)
    expect(screen.getByTestId('location')).toHaveTextContent('/search?q=pallets')

    // A new search replaces `q` and keeps the rest of the URL
    fireEvent.change(screen.getByLabelText('Search query'), { target: { value: 'racking' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(searchCalls(fetchMock)).toBe(2))
    expect(screen.getByTestId('location')).toHaveTextContent('/search?q=racking')
    await waitFor(() => expect(searchCalls(fetchMock)).toBe(2))
  })

  it('?q= with ?documentId= searches inside that document', async () => {
    const fetchMock = mount(
      { 'POST /api/ai/documents/search': { query: 'x', hits: [], lexical: 'used' } },
      `/search?documentId=${DOC_B}&q=x`
    )
    await waitFor(() =>
      expect(requestBody(fetchMock, 'POST /api/ai/documents/search')).toEqual({
        query: 'x',
        limit: 10,
        documentId: DOC_B,
      })
    )
  })

  it('preselects the document filter from ?documentId and sends it', async () => {
    const fetchMock = mount(
      { 'POST /api/ai/documents/search': { query: 'x', hits: [], lexical: 'used' } },
      `/search?documentId=${DOC_B}`
    )
    await screen.findByRole('option', { name: 'Release notes' })
    expect(screen.getByLabelText('Restrict to document')).toHaveValue(DOC_B)
    fireEvent.change(screen.getByLabelText('Search query'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, 'POST /api/ai/documents/search')).toEqual({
        query: 'x',
        limit: 10,
        documentId: DOC_B,
      })
    )
    expect(await screen.findByText(/No matches for/)).toBeInTheDocument()
  })

  it('with no documents shows an empty state linking to /documents', async () => {
    mount({ '/api/ai/documents': paged([]) })
    expect(await screen.findByText('Nothing to search yet')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Knowledge' })).toHaveAttribute('href', '/documents')
  })
  it('offers the facets as filters, keeps them in the URL and re-runs the search with them', async () => {
    const fetchMock = mount(
      { 'POST /api/ai/documents/search': { query: 'pallets', hits: [hit(1)], lexical: 'used' } },
      '/search?q=pallets'
    )
    const filters = await screen.findByRole('complementary', { name: 'Search filters' })
    await within(filters).findByLabelText(/Uploaded or pasted/)
    expect(within(filters).getByLabelText(/Agent · weekly-digest/)).not.toBeChecked()
    // The two Excel media types are ONE option, counted together.
    const excel = within(filters).getByLabelText(/Excel/)
    expect(excel.closest('label')).toHaveTextContent('Excel2')

    fireEvent.click(within(filters).getByLabelText(/Uploaded or pasted/))
    await waitFor(() =>
      expect(searchBodies(fetchMock).at(-1)).toEqual({
        query: 'pallets',
        limit: 10,
        filters: { sources: ['upload'] },
      })
    )
    fireEvent.click(excel)
    fireEvent.change(within(filters).getByLabelText('Added from'), {
      target: { value: '2025-01-01' },
    })
    fireEvent.change(within(filters).getByLabelText('Added to'), {
      target: { value: '2025-03-31' },
    })
    await waitFor(() =>
      expect(searchBodies(fetchMock).at(-1)).toEqual({
        query: 'pallets',
        limit: 10,
        filters: {
          sources: ['upload'],
          contentTypes: [
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          ],
          createdFrom: '2025-01-01',
          createdTo: '2025-03-31',
        },
      })
    )
    const search = new URLSearchParams(screen.getByTestId('location').textContent?.split('?')[1])
    expect(search.getAll('source')).toEqual(['upload'])
    expect(search.getAll('type')).toHaveLength(2)
    expect(search.get('from')).toBe('2025-01-01')
    expect(search.get('to')).toBe('2025-03-31')

    // Clear all drops every filter and keeps the query.
    fireEvent.click(within(filters).getByRole('button', { name: 'Clear all' }))
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/search\?q=pallets$/)
    )
    await waitFor(() =>
      expect(searchBodies(fetchMock).at(-1)).toEqual({ query: 'pallets', limit: 10 })
    )
  })

  it('a URL filter value the facets do not list is still shown, checked, so it can be cleared', async () => {
    mount(
      { 'POST /api/ai/documents/search': { query: 'x', hits: [], lexical: 'used' } },
      '/search?q=x&source=m365%3Amail'
    )
    const filters = await screen.findByRole('complementary', { name: 'Search filters' })
    expect(await within(filters).findByLabelText(/m365:mail/)).toBeChecked()
    // Nothing matched under a filter: the empty state offers to clear them.
    expect(await screen.findByText('No matches for “x”')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument()
  })

  it('an inverted date range is not sent and says why', async () => {
    const fetchMock = mount(
      { 'POST /api/ai/documents/search': { query: 'x', hits: [], lexical: 'used' } },
      '/search?q=x&from=2025-05-01&to=2025-01-01'
    )
    expect(
      await screen.findByText('The start date must be on or before the end date')
    ).toBeInTheDocument()
    expect(searchCalls(fetchMock)).toBe(0)
  })

  it('shows source and date under each document, and the passage highlighted', async () => {
    mount(
      {
        'POST /api/ai/documents/search': {
          query: 'pallets',
          lexical: 'used',
          hits: [hit(1, { text: 'Stack the pallets two high.' })],
        },
      },
      '/search?q=pallets'
    )
    const results = await screen.findByRole('region', { name: 'Search results' })
    expect(results).toHaveTextContent('1 passage from 1 document for “pallets”')
    expect(results).toHaveTextContent('Uploaded or pasted')
    expect(results).toHaveTextContent(/Added /)
    expect(within(results).getByText('pallets', { selector: 'mark' })).toBeInTheDocument()
  })

  it('the facts block appears only with knowledge facts on', async () => {
    const ENTITY = '77777777-7777-4777-8777-777777777777'
    const FACT = '88888888-8888-4888-8888-888888888888'
    const mentioned = {
      entities: [
        {
          entity: { kind: 'staging', type: 'customer', id: ENTITY, name: 'Acme' },
          facts: [
            {
              factId: FACT,
              entity: { kind: 'staging', type: 'customer', id: ENTITY, name: 'Acme' },
              key: 'plan',
              value: 'gold',
              valueText: 'gold',
              state: 'accepted',
              preferred: true,
              conflictsWith: [],
              sourceKind: 'upload',
              documentId: DOC_A,
              documentTitle: 'Onboarding guide',
              quote: 'Acme is on gold',
              validFrom: null,
              validTo: null,
              observedAt: now,
            },
          ],
        },
      ],
    }
    const routes = {
      'POST /api/ai/documents/search': { query: 'acme', hits: [hit(1)], lexical: 'used' },
      '/api/knowledge/mentioned': mentioned,
    }
    const fetchMock = mount(
      routes,
      '/search?q=acme',
      makeSession({ features: ['knowledge-facts'] })
    )
    const facts = await screen.findByRole('region', { name: 'Known facts' })
    expect(within(facts).getByRole('link', { name: 'Acme' })).toBeInTheDocument()
    expect(facts).toHaveTextContent('gold')
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('/api/knowledge/mentioned?q=acme')
      )
    ).toBe(true)
  })

  it('without the flag, no facts request is made', async () => {
    const fetchMock = mount(
      { 'POST /api/ai/documents/search': { query: 'acme', hits: [hit(1)], lexical: 'used' } },
      '/search?q=acme'
    )
    await screen.findByRole('region', { name: 'Search results' })
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/knowledge'))).toBe(
      false
    )
  })

  it('a search of only stopwords that found nothing says the word is too common', async () => {
    mount(
      { 'POST /api/ai/documents/search': { query: 'and', hits: [], lexical: 'no_terms' } },
      '/search?q=and'
    )
    expect(
      await screen.findByText(
        '“and” is too common a word to search for on its own — try a more specific word.'
      )
    ).toBeInTheDocument()
  })

  it('stale embeddings: a member is told, with no button', async () => {
    mount(
      { '/api/ai/documents/facets': { ...FACETS, staleEmbeddings: 3 } },
      '/search',
      makeSession({ tenant: makeTenant({ role: 'member' }) })
    )
    expect(
      await screen.findByText(/3 documents were indexed with a different model/)
    ).toHaveTextContent('An admin can re-index them.')
    expect(screen.queryByRole('button', { name: /Re-index/ })).not.toBeInTheDocument()
  })

  it('stale embeddings: an admin re-indexes, and the notice goes once nothing is stale', async () => {
    let stale = 2
    const fetchMock = mount(
      {
        '/api/ai/documents/facets': () => ({ ...FACETS, staleEmbeddings: stale }),
        'POST /api/ai/documents/reembed': () => {
          stale = 0
          return new Response(
            JSON.stringify({
              embeddingModel: '@cf/baai/bge-m3',
              staleEmbeddings: 2,
              staleChunks: 9,
              enqueued: true,
            }),
            { status: 202, headers: { 'Content-Type': 'application/json' } }
          )
        },
      },
      '/search',
      makeSession({ tenant: makeTenant({ role: 'admin' }) })
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Re-index now' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).includes('/api/ai/documents/reembed') && init?.method === 'POST'
        )
      ).toBe(true)
    )
    // The documents family is invalidated, the facets re-read, and the count reaching 0 ends it.
    await waitFor(() =>
      expect(screen.queryByText(/indexed with a different model/)).not.toBeInTheDocument()
    )
  })
})
