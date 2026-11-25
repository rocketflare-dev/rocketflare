/**
 * `research-topic`'s output names its sources through `Provenance`: each citation links to the
 * viewer, picks up its document's type and passage count from the cached card (keeping the title
 * the answer cited), stays a plain link when the document is gone, and the work line says how the
 * answer was made. Part of the research-topic example surface.
 */
import type { DocumentCard as DocumentCardData } from '@rocketflare/shared/ai/embeddings'
import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { researchTopicOutput } from '@/ui/pages/agents/outputs/research-topic'
import { jsonResponse, renderWithProviders, stubFetch } from './helpers/renderWithProviders'

const DOC = '55555555-5555-4555-8555-555555555555'
const DOC2 = '66666666-6666-4666-8666-666666666666'

const card = (overrides: Partial<DocumentCardData> = {}): DocumentCardData => ({
  id: DOC,
  title: 'Onboarding guide',
  typeLabel: 'PDF',
  contentType: 'application/pdf',
  status: 'indexed',
  excerpt: null,
  passages: 4,
  sizeBytes: null,
  fileId: null,
  href: `/documents/${DOC}`,
  ...overrides,
})

afterEach(() => vi.unstubAllGlobals())

describe("research-topic's output", () => {
  const View = researchTopicOutput.Component

  it("fills a citation in from its document's card, keeping the cited title", async () => {
    stubFetch({ [`/api/ai/documents/${DOC}/card`]: jsonResponse(card({ typeLabel: 'Markdown' })) })
    renderWithProviders(
      <View
        runId="r1"
        output={{
          answer: 'Leave is 25 days.',
          citations: [{ documentId: DOC, title: 'Staff handbook' }],
          turns: 3,
        }}
      />
    )
    const region = screen.getByRole('region', { name: 'Sources' })
    expect(within(region).getByRole('link', { name: 'Staff handbook' })).toHaveAttribute(
      'href',
      `/documents/${DOC}`
    )
    await waitFor(() =>
      expect(within(region).getByText('Markdown · 4 passages')).toBeInTheDocument()
    )
    expect(within(region).getByText(/Read 1 document in 3 model turns/)).toBeInTheDocument()
  })

  it('keeps a citation whose document is gone as a plain link, and says when nothing was found', () => {
    stubFetch({})
    const { unmount } = renderWithProviders(
      <View
        runId="r1"
        output={{
          answer: 'See the policy.',
          citations: [{ documentId: DOC2, title: 'Old policy' }],
          turns: 1,
        }}
      />
    )
    expect(screen.getByRole('link', { name: 'Old policy' })).toHaveAttribute(
      'href',
      `/documents/${DOC2}`
    )
    unmount()
    renderWithProviders(
      <View runId="r2" output={{ answer: 'No idea.', citations: [], turns: 2 }} />
    )
    expect(screen.getByText(/Nothing in the knowledge base answered this/)).toBeInTheDocument()
    expect(screen.getByText(/Searched in 2 model turns/)).toBeInTheDocument()
  })
})
