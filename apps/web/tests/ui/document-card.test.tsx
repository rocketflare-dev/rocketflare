/**
 * `DocumentCard` (D18) — the compact form a document takes wherever it is cited. Two things are
 * worth a test: what it renders (excerpt only when there is one, status only when it is not
 * `indexed`). The constraint that lets it live in the EAGER `components/shared` barrel while
 * `Markdown` may not — no markdown import — is asserted in `tests/config/ui-bundle.test.ts`.
 */
import type { DocumentCard as DocumentCardData } from '@rocketflare/shared/ai/embeddings'
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DocumentCard } from '@/ui/components/shared'
import { renderWithProviders } from './helpers/renderWithProviders'

const DOC = '55555555-5555-4555-8555-555555555555'

const card = (overrides: Partial<DocumentCardData> = {}): DocumentCardData => ({
  id: DOC,
  title: 'Onboarding guide',
  typeLabel: 'PDF',
  contentType: 'application/pdf',
  status: 'indexed',
  excerpt: 'Everyone joining the warehouse team reads this first.',
  passages: 4,
  sizeBytes: 1024 * 1024,
  fileId: null,
  href: `/documents/${DOC}`,
  ...overrides,
})

describe('DocumentCard', () => {
  it('links the title to the viewer and shows the type, size and excerpt', () => {
    renderWithProviders(<DocumentCard card={card()} />)
    expect(screen.getByRole('link', { name: 'Onboarding guide' })).toHaveAttribute(
      'href',
      `/documents/${DOC}`
    )
    expect(screen.getByText('PDF')).toBeInTheDocument()
    expect(screen.getByText(/4 passages · 1.0 MB/)).toBeInTheDocument()
    expect(screen.getByText(/Everyone joining the warehouse team/)).toBeInTheDocument()
  })

  it('shows the status only when a document is not indexed, and honours `to` and `dense`', () => {
    renderWithProviders(
      <DocumentCard
        card={card({ status: 'pending', passages: 1 })}
        to="/documents/x?offset=40"
        dense
      />
    )
    expect(screen.getByText('Indexing')).toBeInTheDocument()
    expect(screen.getByText('1 passage · 1.0 MB')).toBeInTheDocument()
    // `dense` drops the excerpt: a list header should not repeat what the hits below already say.
    expect(screen.queryByText(/Everyone joining/)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Onboarding guide' })).toHaveAttribute(
      'href',
      '/documents/x?offset=40'
    )
  })
})
