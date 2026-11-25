/**
 * The `summarize-text` example's typed output view (`outputs/summarize-text.tsx`) through the
 * outputs registry, as the run page's Output tab renders it: the summary, its key points and the
 * link to the indexed document, with a Raw JSON toggle. Part of the example's surface — deleting
 * the example deletes this file; the run page itself is `run-page.test.tsx`.
 */
import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunOutputTab } from '@/ui/pages/agents/run/output/RunOutputTab'
import { makeSession, renderWithProviders, stubFetch } from './helpers/renderWithProviders'

const RUN_ID = '99999999-9999-4999-8999-999999999999'

describe('the summarize-text output view', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows the typed output through the outputs registry', async () => {
    stubFetch({ '/api/feedback': { items: [] } })
    renderWithProviders(
      <RunOutputTab
        agentKey="summarize-text"
        runId={RUN_ID}
        pending={false}
        output={{
          summary: 'Short summary',
          keyPoints: ['One', 'Two'],
          documentId: '55555555-5555-4555-8555-555555555555',
        }}
      />,
      { session: makeSession() }
    )
    expect(await screen.findByText('Short summary')).toBeInTheDocument()
    expect(screen.getByText('One')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open the indexed document/ })).toHaveAttribute(
      'href',
      '/documents/55555555-5555-4555-8555-555555555555'
    )
    expect(screen.getByRole('button', { name: 'Raw JSON' })).toBeInTheDocument()
  })
})
