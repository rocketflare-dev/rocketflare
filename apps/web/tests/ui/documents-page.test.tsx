/**
 * `/documents` (D18): the ingest form counts characters against `INGEST_TEXT_MAX_CHARS`, validates
 * with the shared schema and POSTs the exact body (then toasts and clears); the upload tab refuses
 * a wrong type or an oversized file before any request and POSTs the chosen file as multipart to
 * `/api/ai/documents/upload` with the optional title; the table shows status badges with the
 * failure reason, a download link only for uploaded originals, and only offers delete on own rows
 * (any row for admin+). Search lives on `/search` (`search-page.test.tsx`).
 */
import { DOCUMENT_UPLOAD_ACCEPT, INGEST_TEXT_MAX_CHARS } from '@rocketflare/shared/ai/embeddings'
import { MAX_UPLOAD_BYTES } from '@rocketflare/shared/files'
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
  fileId: null,
  chunkCount: 3,
  status: 'indexed',
  error: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
})

const FILE_ID = '77777777-7777-4777-8777-777777777777'
const DOC_C = '88888888-8888-4888-8888-888888888888'

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
  doc({
    id: DOC_C,
    title: 'Quarterly report',
    source: 'report.pdf',
    contentType: 'application/pdf',
    fileId: FILE_ID,
    status: 'pending',
    chunkCount: 0,
  }),
])

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

  it('uploads the chosen file as multipart with the optional title, then toasts and clears', async () => {
    const fetchMock = mount({
      'POST /api/ai/documents/upload': (init: RequestInit | undefined) => {
        const form = init?.body as FormData
        const file = form.get('file') as File
        return jsonResponse(
          doc({
            id: DOC_C,
            title: String(form.get('title') ?? file.name),
            source: file.name,
            contentType: 'application/pdf',
            fileId: FILE_ID,
            status: 'pending',
            chunkCount: 0,
          }),
          201
        )
      },
    })
    fireEvent.click(await screen.findByRole('tab', { name: 'Upload file' }))
    const input = screen.getByLabelText('Upload document') as HTMLInputElement
    expect(input.accept).toBe(DOCUMENT_UPLOAD_ACCEPT)
    expect(screen.getByRole('button', { name: 'Upload document' })).toBeDisabled()

    const pdf = new File([new Uint8Array([1, 2, 3])], 'report.pdf', { type: 'application/pdf' })
    fireEvent.change(input, { target: { files: [pdf] } })
    expect(screen.getByText('report.pdf')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Q3 report' } })
    fireEvent.click(screen.getByRole('button', { name: 'Upload document' }))

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => String(url) === '/api/ai/documents/upload' && init?.method === 'POST'
        )
      ).toBe(true)
    )
    const call = fetchMock.mock.calls.find(([url]) => String(url) === '/api/ai/documents/upload')
    const body = call?.[1]?.body as FormData
    expect(body).toBeInstanceOf(FormData)
    expect((body.get('file') as File).name).toBe('report.pdf')
    expect(body.get('title')).toBe('Q3 report')
    expect(body.get('source')).toBeNull()
    // Multipart: the browser sets the boundary — no JSON content type.
    expect(new Headers(call?.[1]?.headers).get('Content-Type')).toBeNull()
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map(t => t.message)).toContain(
        '"Q3 report" queued for conversion and indexing'
      )
    )
    expect(screen.getByText('No file chosen')).toBeInTheDocument()
  })

  it('refuses a wrong type or an oversized file before any request', async () => {
    const fetchMock = mount({ 'POST /api/ai/documents/upload': doc() })
    fireEvent.click(await screen.findByRole('tab', { name: 'Upload file' }))
    const input = screen.getByLabelText('Upload document') as HTMLInputElement

    fireEvent.change(input, {
      target: { files: [new File(['x'], 'photo.png', { type: 'image/png' })] },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(/Choose a PDF/)

    const big = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'big.txt', {
      type: 'text/plain',
    })
    fireEvent.change(input, { target: { files: [big] } })
    expect(await screen.findByRole('alert')).toHaveTextContent(/MB or smaller/)
    expect(screen.getByRole('button', { name: 'Upload document' })).toBeDisabled()
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/ai/documents/upload')).toBe(
      false
    )
  })

  it('shows status badges with the failure reason, a download link for originals, delete only on own rows', async () => {
    mount()
    const table = await screen.findByRole('table', { name: 'Documents' })
    expect(within(table).getByText('Indexed')).toBeInTheDocument()
    expect(within(table).getByText('Indexing')).toBeInTheDocument()
    expect(within(table).getByText('PDF')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Download Quarterly report' })).toHaveAttribute(
      'href',
      `/api/files/${FILE_ID}`
    )
    expect(
      screen.queryByRole('link', { name: 'Download Onboarding guide' })
    ).not.toBeInTheDocument()
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
})
