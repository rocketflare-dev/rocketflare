/**
 * `/search` (D18): search POSTs `{ query, limit, documentId? }` and renders hits ranked with
 * dense/lexical badges; `?documentId=` preselects the per-document filter and is sent; an empty
 * knowledge base shows an empty state pointing at `/documents`.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SearchPage from '@/ui/pages/documents/SearchPage'
import {
  IDS,
  makeSession,
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
  charOffset: (rank - 1) * 1000,
  denseRank: rank,
  lexicalRank: null,
  ...overrides,
})

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="location">{location.pathname + location.search}</span>
}

function mount(routes: RouteTable = {}, route = '/search') {
  const fetchMock = stubFetch({ '/api/ai/documents': DOCS, ...routes })
  renderWithProviders(
    <>
      <SearchPage />
      <LocationProbe />
    </>,
    { session: makeSession(), route }
  )
  return fetchMock
}

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
    const results = await screen.findByRole('list', { name: 'Search results' })
    const rows = within(results).getAllByRole('listitem')
    expect(rows.map(r => r.getAttribute('data-rank'))).toEqual(['1', '2'])
    expect(rows[0]).toHaveTextContent('#1')
    expect(rows[0]).toHaveTextContent('passage 1 of 4')
    expect(rows[0]).toHaveTextContent('dense #1')
    expect(rows[0]).toHaveTextContent('lexical #2')
    expect(rows[0]).toHaveTextContent('Snippet 1')
    expect(rows[1]).toHaveTextContent('lexical #1')
    expect(rows[1]).not.toHaveTextContent('dense #')
    expect(rows[1]).toHaveTextContent('Release notes')
    // The submitted query is written to the URL (replace) so the result page can be shared
    expect(screen.getByTestId('location')).toHaveTextContent('/search?q=how+do+I+onboard')
  })

  it('?q= prefills the box and runs the search on mount, once', async () => {
    const fetchMock = mount(
      { 'POST /api/ai/documents/search': { query: 'pallets', hits: [hit(1)] } },
      '/search?q=pallets'
    )
    expect(screen.getByLabelText('Search query')).toHaveValue('pallets')
    await waitFor(() =>
      expect(requestBody(fetchMock, 'POST /api/ai/documents/search')).toEqual({
        query: 'pallets',
        limit: 10,
      })
    )
    await screen.findByRole('list', { name: 'Search results' })
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
      { 'POST /api/ai/documents/search': { query: 'x', hits: [] } },
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
      { 'POST /api/ai/documents/search': { query: 'x', hits: [] } },
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
})
