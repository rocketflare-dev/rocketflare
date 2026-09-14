/**
 * `/documents/:documentId` (D18). What is worth pinning here is the dispatch, not the chrome: a
 * PDF embeds its ORIGINAL while a link that names a passage opens the TEXT (a `charOffset` is an
 * offset into the converted markdown and has no relationship to a PDF page); a document with no
 * text yet says so from the 409 rather than showing an empty window; `?q=` marks its matches as
 * `<mark>` nodes; and paging is one query per snapped offset with no accumulating state.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DocumentViewPage from '@/ui/pages/documents/DocumentViewPage'
import {
  IDS,
  jsonResponse,
  makeSession,
  paged,
  type RouteTable,
  renderWithProviders,
  stubFetch,
} from './helpers/renderWithProviders'

const now = '2025-06-01T00:00:00Z'
const DOC = '55555555-5555-4555-8555-555555555555'
const FILE_ID = '77777777-7777-4777-8777-777777777777'
const CHUNK = '11111111-1111-4111-8111-111111111111'

const doc = (overrides: Record<string, unknown> = {}) => ({
  id: DOC,
  tenantId: IDS.tenant,
  ownerUserId: IDS.user,
  title: 'Onboarding guide',
  source: 'upload',
  contentType: 'text/plain',
  sizeBytes: 1200,
  fileId: null,
  chunkCount: 2,
  status: 'indexed',
  error: null,
  visibility: 'tenant',
  groups: [],
  createdAt: now,
  updatedAt: now,
  ...overrides,
})

const content = (overrides: Record<string, unknown> = {}) => ({
  documentId: DOC,
  title: 'Onboarding guide',
  source: 'upload',
  contentType: 'text/plain',
  status: 'indexed',
  totalChars: 42,
  passages: 2,
  offset: 0,
  returnedChars: 42,
  text: 'Everyone joining the warehouse reads this.',
  hasMore: false,
  nextOffset: null,
  ...overrides,
})

function mount(routes: RouteTable = {}, route = `/documents/${DOC}`) {
  const fetchMock = stubFetch({
    [`/api/ai/documents/${DOC}`]: doc(),
    [`/api/ai/documents/${DOC}/content`]: content(),
    [`/api/ai/documents/${DOC}/passages`]: paged([]),
    ...routes,
  })
  renderWithProviders(
    <Routes>
      <Route path="/documents/:documentId" element={<DocumentViewPage />} />
    </Routes>,
    { session: makeSession(), route }
  )
  return fetchMock
}

/** The query string of the nth call to a path, so a test can assert the window that was asked for. */
function queriesFor(fetchMock: ReturnType<typeof vi.fn>, path: string): string[] {
  return fetchMock.mock.calls
    .map(([input]) => new URL(String(input), 'http://localhost'))
    .filter(url => url.pathname === path)
    .map(url => url.search)
}

describe('Document viewer', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('renders the text of a pasted document with its metadata in the header', async () => {
    mount()
    expect(await screen.findByText(/Everyone joining the warehouse/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Onboarding guide' })).toBeInTheDocument()
    expect(screen.getByText(/Text · 2 passages/)).toBeInTheDocument()
    // One window, so paging says so rather than offering a Next that goes nowhere.
    expect(screen.getByText(/window 1 of 1/)).toBeInTheDocument()
  })

  it('embeds a PDF original, and offers the converted text and a download beside it', async () => {
    mount({
      [`/api/ai/documents/${DOC}`]: doc({
        contentType: 'application/pdf',
        fileId: FILE_ID,
        title: 'Quarterly report',
      }),
    })
    const embed = await screen.findByLabelText('Quarterly report (PDF)')
    expect(embed).toHaveAttribute('data', `/api/files/${FILE_ID}`)
    expect(embed).toHaveAttribute('type', 'application/pdf')
    // The escape hatches are ALWAYS present: `<object>` has no reliable success event, so a
    // browser with a poor in-page viewer must not be left with a blank box.
    expect(screen.getByRole('link', { name: /Download original/ })).toHaveAttribute(
      'href',
      `/api/files/${FILE_ID}`
    )
    expect(screen.getByRole('button', { name: 'Converted text' })).toBeInTheDocument()
  })

  it('opens the TEXT, not the embed, when a link names a passage', async () => {
    // `charOffset` is an offset into the converted markdown; a PDF page is not addressable from it.
    mount(
      {
        [`/api/ai/documents/${DOC}`]: doc({ contentType: 'application/pdf', fileId: FILE_ID }),
        [`/api/ai/documents/${DOC}/content`]: content({
          contentType: 'application/pdf',
          text: 'The warehouse policy is reviewed each quarter.',
        }),
      },
      `/documents/${DOC}?offset=9&chunk=${CHUNK}`
    )
    expect(await screen.findByText(/warehouse policy/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/\(PDF\)/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Original' })).toBeInTheDocument()
  })

  it('marks ?q= matches as <mark> nodes, never as raw HTML', async () => {
    mount({}, `/documents/${DOC}?q=warehouse`)
    const marks = await screen.findAllByText('warehouse')
    expect(marks.some(m => m.tagName === 'MARK')).toBe(true)
  })

  it('explains a document whose text is still converting, and one whose conversion failed', async () => {
    mount({
      [`/api/ai/documents/${DOC}`]: doc({ status: 'pending', contentType: 'text/html' }),
      [`/api/ai/documents/${DOC}/content`]: () =>
        jsonResponse(
          { error: 'Not converted', statusCode: 409, code: 'document_not_converted' },
          409
        ),
    })
    expect(await screen.findByText(/still being converted/)).toBeInTheDocument()

    vi.unstubAllGlobals()
    mount({
      [`/api/ai/documents/${DOC}`]: doc({
        status: 'failed',
        contentType: 'text/html',
        error: 'Conversion returned an error',
      }),
      [`/api/ai/documents/${DOC}/content`]: () =>
        jsonResponse({ error: 'Failed', statusCode: 409, code: 'document_conversion_failed' }, 409),
    })
    expect(await screen.findByText(/Conversion returned an error/)).toBeInTheDocument()
  })

  it('pages by snapped offset: one query per window, Next carries nextOffset', async () => {
    const fetchMock = mount({
      [`/api/ai/documents/${DOC}`]: doc({ chunkCount: 5 }),
      [`/api/ai/documents/${DOC}/content`]: content({
        totalChars: 45_000,
        returnedChars: 20_000,
        text: 'window one',
        hasMore: true,
        nextOffset: 20_000,
      }),
    })
    expect(await screen.findByText('window one')).toBeInTheDocument()
    expect(screen.getByText(/window 1 of 3/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Next/ })).toHaveAttribute(
      'href',
      `/documents/${DOC}?offset=20000`
    )
    // A deep link at an arbitrary character is SNAPPED down to a window boundary, so it shares a
    // cache entry with the reader's own paging instead of fetching a near-duplicate slice.
    expect(queriesFor(fetchMock, `/api/ai/documents/${DOC}/content`)).toEqual([
      '?offset=0&maxChars=20000',
    ])
  })

  it('lists passages on the Details tab, each linking into the document at its offset', async () => {
    mount(
      {
        [`/api/ai/documents/${DOC}/passages`]: paged([
          {
            id: CHUNK,
            documentId: DOC,
            seq: 0,
            tokenCount: 120,
            charOffset: 0,
            text: 'First passage.',
          },
          {
            id: '22222222-2222-4222-8222-222222222222',
            documentId: DOC,
            seq: 1,
            tokenCount: 90,
            charOffset: null,
            text: 'Second passage.',
          },
        ]),
      },
      `/documents/${DOC}?tab=details`
    )
    const list = await screen.findByRole('list', { name: 'Passages' })
    const items = within(list).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('passage 1 of 2')
    expect(within(items[0] as HTMLElement).getByRole('link')).toHaveAttribute(
      'href',
      `/documents/${DOC}?tab=document&offset=0&chunk=${CHUNK}`
    )
    // A passage that could not be located falls back to `?chunk=` alone — no offset to claim.
    expect(within(items[1] as HTMLElement).getByRole('link')).toHaveAttribute(
      'href',
      `/documents/${DOC}?tab=document&chunk=22222222-2222-4222-8222-222222222222`
    )
    // The metadata panel is on the same tab and reports what chunking produced.
    await waitFor(() => expect(screen.getByText('Embedding dimension')).toBeInTheDocument())
  })

  it('says so when the document is gone rather than rendering an empty shell', async () => {
    mount({
      [`/api/ai/documents/${DOC}`]: () =>
        jsonResponse({ error: 'Document not found', statusCode: 404 }, 404),
    })
    expect(await screen.findByText('Document not found')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to Knowledge' })).toHaveAttribute(
      'href',
      '/documents'
    )
  })
})
