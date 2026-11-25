/**
 * The run timeline's tool-result links (`ToolResultCards`): the documents a knowledge tool used,
 * and — for `lookup_facts` and `search_knowledge`'s facts block — the entities, each linking to its
 * page, read by the same shared mapper chat uses.
 */
import { entityPath } from '@rocketflare/shared/ai/knowledge-facts'
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ToolResultCards } from '@/ui/pages/agents/run/timeline/toolResults'
import { renderWithProviders } from './helpers/renderWithProviders'

const entity = { kind: 'staging', type: 'customer', id: 'e-1', name: 'Harbour View Dental' }
const fact = (n: number) => ({
  factId: `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  entity,
  key: 'monthly_fee_gbp',
  value: n,
  valueText: String(n),
  state: 'accepted',
  preferred: true,
  conflictsWith: [],
  sourceKind: 'upload',
  documentId: '55555555-5555-4555-8555-555555555555',
  documentTitle: 'Contract',
  quote: '£',
  validFrom: null,
  validTo: null,
  observedAt: '2026-01-01T00:00:00Z',
})

describe('ToolResultCards', () => {
  it('links each entity a lookup_facts answer used, with its fact count', () => {
    renderWithProviders(
      <ToolResultCards
        name="lookup_facts"
        result={{ entities: [{ entity, facts: [fact(1), fact(2)] }] }}
      />
    )
    const list = screen.getByRole('list', { name: 'Facts this answer used' })
    expect(list).toHaveTextContent('2 facts')
    expect(screen.getByRole('link', { name: 'Harbour View Dental' })).toHaveAttribute(
      'href',
      entityPath('customer', 'e-1')
    )
  })

  it('renders nothing for a tool answer with neither documents nor facts', () => {
    const { container } = renderWithProviders(
      <ToolResultCards name="lookup_facts" result={{ entities: [] }} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
