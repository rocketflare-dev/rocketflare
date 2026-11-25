/**
 * `Provenance` — the one way an answer, an agent's output, a timeline step and a knowledge fact
 * name where they came from. What is worth pinning: every source is a working link to the right
 * place (the viewer, or the passage), a quote carries its "Show in document" deep link, the work
 * line says how the answer was made, and NOTHING renders when there is nothing to show. Then a
 * caller: a chat answer lists its sources numbered under the answer, never as a card inside it.
 * An agent's output is `agent-output-research-topic.test.tsx` (it belongs to that example).
 */
import type { DocumentCard as DocumentCardData } from '@rocketflare/shared/ai/embeddings'
import { screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatBubble } from '@/ui/components/ai/ChatBubble'
import { Provenance, sourceFromCard, sourceFromFact } from '@/ui/components/shared'
import { renderWithProviders } from './helpers/renderWithProviders'

const DOC = '55555555-5555-4555-8555-555555555555'
const DOC2 = '66666666-6666-4666-8666-666666666666'
const CHUNK = '77777777-7777-4777-8777-777777777777'

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

describe('Provenance', () => {
  it('numbers each source and links it to the viewer, with its type and passage count', () => {
    renderWithProviders(
      <Provenance
        sources={[
          sourceFromCard(card()),
          sourceFromCard(
            card({
              id: DOC2,
              href: `/documents/${DOC2}`,
              title: 'Returns policy',
              typeLabel: null,
              passages: 1,
            })
          ),
        ]}
      />
    )
    const region = screen.getByRole('region', { name: 'Sources' })
    expect(within(region).getByRole('heading', { name: '2 sources' })).toBeInTheDocument()
    const items = within(region).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(within(items[0]).getByText('1')).toBeInTheDocument()
    expect(within(items[0]).getByRole('link', { name: 'Onboarding guide' })).toHaveAttribute(
      'href',
      `/documents/${DOC}`
    )
    expect(within(items[0]).getByText('PDF · 4 passages')).toBeInTheDocument()
    // An unknown type is left out, never guessed.
    expect(within(items[1]).getByText('1 passage')).toBeInTheDocument()
    expect(within(items[1]).getByRole('link', { name: 'Returns policy' })).toHaveAttribute(
      'href',
      `/documents/${DOC2}`
    )
  })

  it('shows a status only for a document that is not indexed', () => {
    renderWithProviders(<Provenance sources={[sourceFromCard(card({ status: 'pending' }))]} />)
    expect(screen.getByRole('heading', { name: 'Source' })).toBeInTheDocument()
    expect(screen.getByText('Indexing')).toBeInTheDocument()
  })

  it('renders nothing when there are no sources and no work line', () => {
    const { container } = renderWithProviders(<Provenance sources={[]} />)
    expect(container.querySelector('[data-provenance]')).toBeNull()
    expect(container).toBeEmptyDOMElement()
  })

  it('says how the answer was made, with a link to the run when given one', () => {
    renderWithProviders(
      <Provenance
        sources={[]}
        work={{ summary: 'Searched in 3 model turns', to: '/agents/runs/abc' }}
      />
    )
    expect(screen.getByText('Searched in 3 model turns')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open the run' })).toHaveAttribute(
      'href',
      '/agents/runs/abc'
    )
    // No sources: no "0 sources" heading.
    expect(screen.queryByRole('heading')).toBeNull()
  })

  it("shows a fact's quote verbatim, deep-linked to the exact span", () => {
    const source = sourceFromFact(
      {
        documentId: DOC,
        documentTitle: 'Rate card',
        chunkId: CHUNK,
        charStart: 120,
        charEnd: 168,
        quote: 'The monthly fee is £40.',
      },
      '1 Sept 2026'
    )
    renderWithProviders(<Provenance layout="inline" lead="From" sources={[source]} />)
    expect(screen.getByText('From')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Rate card' })).toHaveAttribute(
      'href',
      `/documents/${DOC}?offset=120&chunk=${CHUNK}`
    )
    expect(screen.getByText('1 Sept 2026')).toBeInTheDocument()
    expect(screen.getByText('The monthly fee is £40.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Show in document' })).toHaveAttribute(
      'href',
      `/documents/${DOC}?tab=document&offset=120&end=168`
    )
  })

  it('offers no "Show in document" for a quote that cannot be located', () => {
    const source = sourceFromFact({
      documentId: DOC,
      documentTitle: 'Rate card',
      chunkId: null,
      charStart: null,
      charEnd: null,
      quote: 'Somewhere in here.',
    })
    renderWithProviders(<Provenance layout="inline" sources={[source]} />)
    expect(screen.getByText('Somewhere in here.')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Show in document' })).toBeNull()
  })
})

describe('Provenance in a chat answer', () => {
  it('lists the documents the turn used under the answer, as links rather than cards', () => {
    renderWithProviders(
      <ChatBubble speaker="assistant" content="The fee is £40." documents={[card()]} />
    )
    const region = screen.getByRole('region', { name: 'Sources' })
    expect(within(region).getByRole('link', { name: 'Onboarding guide' })).toHaveAttribute(
      'href',
      `/documents/${DOC}`
    )
    expect(document.querySelector('article')).toBeNull()
  })

  it('shows no sources block for an answer that used none', () => {
    renderWithProviders(<ChatBubble speaker="assistant" content="Hello." documents={[]} />)
    expect(screen.queryByRole('region', { name: 'Sources' })).toBeNull()
  })
})
