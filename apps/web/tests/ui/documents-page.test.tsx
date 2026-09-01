/**
 * `/documents` (D18): the ingest form counts characters against `INGEST_TEXT_MAX_CHARS`, validates
 * with the shared schema and POSTs the exact body (then toasts and clears); the table shows status
 * badges with the failure reason and only offers delete on own rows (any row for admin+); search
 * POSTs `{ query, limit, documentId? }` and renders hits ranked with dense/lexical badges.
 */
import { INGEST_TEXT_MAX_CHARS } from '@gmgo/shared/ai/embeddings'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '@/ui/components/shared/Toast'
import DocumentsPage from '@/ui/pages/documents/DocumentsPage'
import {
  IDS,
  jsonResponse,
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
  chunkCount: 3,
  status: 'indexed',
  error: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
})

const DOCS = paged([
  doc(),
  doc({
    id: DOC_B,
    ownerUserId: IDS.otherUser,
    title: 'Release notes',
    source: 'agent:summarize-text',
    status: 'failed',
    error: 'Embeddings provider timed out',
    chunkCount: 0,
  }),
])

const hit = (rank: number, overrides: Record<string, unknown> = {}) => ({
  chunkId: `${String(rank).padStart(8, '0')}-0000-4000-8000-000000000000`,
  documentId: DOC_A,
  title: 'Onboarding guide',
  text: `Snippet ${rank}`,
  score: 0.5 / rank,
  rank,
  denseRank: rank,
  lexicalRank: null,
  ...overrides,
})

function mount(routes: RouteTable = {}, session = makeSession(), route = '/documents') {
  const fetchMock = stubFetch({ '/api/ai/documents': DOCS, ...routes })
  renderWithProviders(<DocumentsPage />, { session, route })
  return fetchMock
}

describe('Documents page', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    useToastStore.setState({ toasts: [] })
  })

  it('counts characters, validates with the shared schema and posts the ingest body', async () => {
    const fetchMock = mount({
      'POST /api/ai/documents/ingest': (init: RequestInit | undefined) => {
        const body = JSON.parse(String(init?.body)) as { title: string; text: string }
        return jsonResponse(doc({ title: body.title, sizeBytes: body.text.length }), 201)
      },
    })
    const form = document.getElementById('ingest-form') as HTMLFormElement
    expect(screen.getByText(`0 / ${INGEST_TEXT_MAX_CHARS.toLocaleString()}`)).toBeInTheDocument()

    // Empty → field errors, no request
    fireEvent.submit(form)
    expect(await screen.findAllByRole('alert')).not.toHaveLength(0)
    expect(requestBody(fetchMock, 'POST /api/ai/documents/ingest')).toBeUndefined()

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '  Handbook ' } })
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Twelve chars' } })
    expect(screen.getByText(`12 / ${INGEST_TEXT_MAX_CHARS.toLocaleString()}`)).toBeInTheDocument()
    fireEvent.submit(form)

    await waitFor(() =>
      expect(requestBody(fetchMock, 'POST /api/ai/documents/ingest')).toEqual({
        title: 'Handbook',
        text: 'Twelve chars',
      })
    )
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map(t => t.message)).toContain(
        '"Handbook" indexed (3 chunks)'
      )
    )
    expect(screen.getByLabelText('Text')).toHaveValue('')
  })

  it('shows status badges with the failure reason and delete only on own rows', async () => {
    mount()
    const table = await screen.findByRole('table', { name: 'Documents' })
    expect(within(table).getByText('Indexed')).toBeInTheDocument()
    expect(within(table).getByText('Failed')).toHaveAttribute(
      'title',
      'Embeddings provider timed out'
    )
    expect(screen.getByRole('button', { name: 'Delete Onboarding guide' })).toBeInTheDocument()
    // Owner holds `delete Document`: every row is deletable
    expect(screen.getByRole('button', { name: 'Delete Release notes' })).toBeInTheDocument()
  })

  it('a member may only delete their own documents, after confirming', async () => {
    const fetchMock = mount(
      { [`DELETE /api/ai/documents/${DOC_A}`]: undefined },
      makeSession({
        tenant: makeTenant({ role: 'member' }),
      })
    )
    await screen.findByRole('table', { name: 'Documents' })
    expect(screen.queryByRole('button', { name: 'Delete Release notes' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Onboarding guide' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith(`/api/ai/documents/${DOC_A}`) && init?.method === 'DELETE'
        )
      ).toBe(true)
    )
  })

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
    expect(rows[0]).toHaveTextContent('dense #1')
    expect(rows[0]).toHaveTextContent('lexical #2')
    expect(rows[0]).toHaveTextContent('Snippet 1')
    expect(rows[1]).toHaveTextContent('lexical #1')
    expect(rows[1]).not.toHaveTextContent('dense #')
    expect(rows[1]).toHaveTextContent('Release notes')
  })

  it('preselects the document filter from ?documentId and sends it', async () => {
    const fetchMock = mount(
      { 'POST /api/ai/documents/search': { query: 'x', hits: [] } },
      makeSession(),
      `/documents?documentId=${DOC_B}`
    )
    await screen.findByRole('table', { name: 'Documents' })
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
})
