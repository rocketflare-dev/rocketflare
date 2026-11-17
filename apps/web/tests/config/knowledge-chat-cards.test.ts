/**
 * The chat's entity cards (D43) are derived from a knowledge tool's JSON by ONE pure mapper
 * (`entityCardsFromToolResult`) — the server emits `CUSTOM kit.entity` from it while streaming,
 * and the UI calls it over a persisted message's `toolCalls` (`entityCardsFromToolCalls`). Both
 * `lookup_facts` and `search_knowledge`'s `facts` block; nothing for any other tool or shape;
 * at most `CHAT_ENTITY_CARD_MAX_FACTS` facts a card; one card per entity across calls.
 */
import { KIT_CUSTOM_EVENTS, type KitAguiEvent } from '@rocketflare/shared/ai/agui'
import {
  CHAT_ENTITY_CARD_MAX_FACTS,
  entityCardsFromToolCalls,
  entityCardsFromToolResult,
  entityPath,
} from '@rocketflare/shared/ai/knowledge-facts'
import { describe, expect, it } from 'vitest'
import { aguiToolEvents } from '@/api/services/ai/agui'

const ENTITY = { kind: 'staging', type: 'customer', id: 'e-1', name: 'Harbour View Dental' }
const DOC = '55555555-5555-4555-8555-555555555555'
const hit = (n: number) => ({
  factId: `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  entity: ENTITY,
  key: 'monthly_fee_gbp',
  value: n,
  valueText: String(n),
  state: 'accepted',
  preferred: true,
  conflictsWith: [],
  sourceKind: 'upload',
  documentId: DOC,
  documentTitle: 'Contract',
  quote: '£',
  validFrom: null,
  validTo: null,
  observedAt: '2026-01-01T00:00:00Z',
})

describe('entityCardsFromToolResult', () => {
  it('reads lookup_facts: one card per entity, linking to its page', () => {
    const [card] = entityCardsFromToolResult(
      'lookup_facts',
      JSON.stringify({ entities: [{ entity: ENTITY, facts: [hit(1)] }], note: 'x' })
    )
    expect(card).toEqual({
      entity: ENTITY,
      href: entityPath('customer', 'e-1'),
      facts: [
        {
          factId: hit(1).factId,
          key: 'monthly_fee_gbp',
          valueText: '1',
          state: 'accepted',
          documentId: DOC,
          documentTitle: 'Contract',
        },
      ],
      moreFacts: 0,
    })
  })

  it("reads search_knowledge's facts block, and caps a card's facts", () => {
    const facts = Array.from({ length: CHAT_ENTITY_CARD_MAX_FACTS + 2 }, (_, i) => hit(i))
    const [card] = entityCardsFromToolResult(
      'search_knowledge',
      JSON.stringify({ documents: [], facts: [{ entity: ENTITY, facts }] })
    )
    expect(card?.facts).toHaveLength(CHAT_ENTITY_CARD_MAX_FACTS)
    expect(card?.moreFacts).toBe(2)
  })

  it('answers nothing for another tool, bad JSON, an empty group or an unexpected shape', () => {
    const body = JSON.stringify({ entities: [{ entity: ENTITY, facts: [hit(1)] }] })
    expect(entityCardsFromToolResult('get_document', body)).toEqual([])
    expect(entityCardsFromToolResult('lookup_facts', '{not json')).toEqual([])
    expect(
      entityCardsFromToolResult(
        'lookup_facts',
        JSON.stringify({ entities: [{ entity: ENTITY, facts: [] }] })
      )
    ).toEqual([])
    expect(entityCardsFromToolResult('lookup_facts', JSON.stringify({ hint: 'nothing' }))).toEqual(
      []
    )
    expect(
      entityCardsFromToolResult('search_knowledge', JSON.stringify({ documents: [] }))
    ).toEqual([])
  })

  it('encodes the entity page path', () => {
    expect(entityPath('example-feature.note', 'a b/c')).toBe(
      '/knowledge/entities/example-feature.note/a%20b%2Fc'
    )
  })
})

describe('entityCardsFromToolCalls', () => {
  it('one card per entity across calls — the first call supplies it', () => {
    const first = JSON.stringify({ entities: [{ entity: ENTITY, facts: [hit(1)] }] })
    const second = JSON.stringify({ documents: [], facts: [{ entity: ENTITY, facts: [hit(2)] }] })
    const cards = entityCardsFromToolCalls([
      { name: 'lookup_facts', result: first },
      { name: 'search_knowledge', result: second },
      { name: 'list_documents', result: '{}' },
    ])
    expect(cards).toHaveLength(1)
    expect(cards[0]?.facts.map(f => f.valueText)).toEqual(['1'])
    expect(entityCardsFromToolCalls(null)).toEqual([])
  })
})

describe('the stream emits them', () => {
  it('a kit.entity per entity follows the TOOL_CALL_RESULT it was derived from', async () => {
    const events: KitAguiEvent[] = []
    const tools = aguiToolEvents(
      async e => {
        events.push(e)
      },
      { close: async () => {}, parentMessageId: () => 'm-1' } as never
    )
    const result = JSON.stringify({ entities: [{ entity: ENTITY, facts: [hit(1)] }] })
    await tools.onToolEnd({ toolUseId: 't-1', name: 'lookup_facts', result })
    const types = events.map(e => (e.type === 'CUSTOM' ? e.name : e.type))
    expect(types).toEqual([
      'TOOL_CALL_RESULT',
      KIT_CUSTOM_EVENTS.document,
      KIT_CUSTOM_EVENTS.entity,
    ])
    const entity = events.at(-1)
    expect(entity?.type === 'CUSTOM' && entity.value).toEqual({
      card: entityCardsFromToolResult('lookup_facts', result)[0],
    })
  })
})
