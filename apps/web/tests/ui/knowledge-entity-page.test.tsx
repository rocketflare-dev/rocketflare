/**
 * `/knowledge/entities/:type/:id` (D43): the entity's facts grouped by key — current first, with
 * value, state, validity, source link and quote; superseded and rejected as the key's history —
 * both sides of a conflict with their own "Use this one"; the inline doubt calling the right
 * endpoint for Confirm / Not right / Use this one and refetching with no success toast; a reader
 * who is neither the reviewer nor a manager sees a sentence instead of buttons; the possible
 * match's Merge / Keep separate; Promote only where the type is promotable; a 404 empty state.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '@/ui/components/shared/Toast'
import EntityPage, { groupFactsByKey } from '@/ui/pages/knowledge/EntityPage'
import {
  errorResponse,
  IDS,
  makeSession,
  makeTenant,
  paged,
  type RouteTable,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'

const ENTITY = '99999999-9999-4999-8999-999999999999'
const TWIN = '98989898-9898-4989-8989-989898989898'
const DOC_A = '55555555-5555-4555-8555-555555555555'
const DOC_B = '66666666-6666-4666-8666-666666666666'
const F_OLD = '70000000-0000-4000-8000-000000000001'
const F_A = '70000000-0000-4000-8000-000000000002'
const F_B = '70000000-0000-4000-8000-000000000003'
const F_DOUBT = '70000000-0000-4000-8000-000000000004'
const F_REJECTED = '70000000-0000-4000-8000-000000000005'

function fact(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    entityKind: 'staging',
    entityType: 'customer',
    entityId: ENTITY,
    key: 'monthly_fee_gbp',
    value: 285,
    valueText: '285',
    source: {
      kind: 'upload',
      documentId: DOC_A,
      documentTitle: 'Contract 2025',
      chunkId: null,
      charStart: 120,
      charEnd: 140,
      quote: 'Monthly Fee: £285',
    },
    confidence: 0.9,
    state: 'accepted',
    supersededById: null,
    conflictsWith: [],
    validFrom: null,
    validTo: null,
    observedAt: '2025-01-10T09:00:00Z',
    confirmedBy: null,
    confirmedAt: null,
    reviewerUserId: IDS.user,
    visibility: 'tenant',
    createdAt: '2025-01-10T09:00:00Z',
    updatedAt: '2025-01-10T09:00:00Z',
    ...over,
  }
}

const CARD = {
  entity: {
    kind: 'staging',
    type: 'customer',
    typeLabel: 'Customer',
    id: ENTITY,
    name: 'Harbour View Dental',
    aliases: ['HVD'],
    promotedTo: null,
    mergedInto: null,
    promotable: false,
    reviewerUserId: IDS.user,
  },
  facts: [
    fact(F_OLD, {
      valueText: '250',
      state: 'superseded',
      validTo: '2024-12-31T00:00:00Z',
      source: { ...fact(F_OLD).source, documentTitle: 'Contract 2024', quote: '£250' },
    }),
    fact(F_A, { state: 'conflicting', conflictsWith: [F_B] }),
    fact(F_B, {
      valueText: '310',
      state: 'conflicting',
      conflictsWith: [F_A],
      observedAt: '2026-02-01T09:00:00Z',
      source: {
        ...fact(F_B).source,
        documentId: DOC_B,
        documentTitle: 'Email 2026',
        quote: 'now pay £310 a month',
      },
    }),
    fact(F_DOUBT, {
      key: 'visit_day',
      valueText: 'Tuesday',
      state: 'unconfirmed',
      confidence: 0.4,
      validFrom: '2026-01-01T00:00:00Z',
    }),
    fact(F_REJECTED, { key: 'visit_day', valueText: 'Friday', state: 'rejected' }),
  ],
}

const NO_MATCH = paged([])

function mount(routes: RouteTable = {}, session = makeSession({ features: ['knowledge-facts'] })) {
  const fetchMock = stubFetch({
    [`/api/knowledge/entities/customer/${ENTITY}`]: CARD,
    '/api/knowledge/review': NO_MATCH,
    ...routes,
  })
  renderWithProviders(
    <Routes>
      <Route path="/knowledge/entities/:type/:id" element={<EntityPage />} />
    </Routes>,
    { route: `/knowledge/entities/customer/${ENTITY}`, session }
  )
  return fetchMock
}

const factEl = (id: string) => document.querySelector(`[data-fact="${id}"]`) as HTMLElement

afterEach(() => {
  vi.unstubAllGlobals()
  useToastStore.setState({ toasts: [] })
})

describe('groupFactsByKey', () => {
  it('splits each key into current (conflicts first) and history (newest first)', () => {
    const groups = groupFactsByKey(
      CARD.facts.map(f => ({
        ...f,
        observedAt: new Date(f.observedAt),
      })) as never
    )
    expect(groups.map(g => g.key)).toEqual(['monthly_fee_gbp', 'visit_day'])
    expect(groups[0]?.current.map(f => f.id)).toEqual([F_B, F_A])
    expect(groups[0]?.history.map(f => f.id)).toEqual([F_OLD])
    expect(groups[1]?.history.map(f => f.id)).toEqual([F_REJECTED])
  })
})

describe('Entity page', () => {
  it('shows the entity, facts grouped by key with source, quote, validity and history', async () => {
    mount()
    expect(await screen.findByRole('heading', { name: 'Harbour View Dental' })).toBeInTheDocument()
    expect(screen.getByText('Customer')).toBeInTheDocument()
    expect(screen.getByText('Also called HVD')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Monthly fee gbp' })).toBeInTheDocument()
    // Both sides of the conflict, each with its source document and quote.
    const a = factEl(F_A)
    expect(within(a).getByRole('link', { name: 'Contract 2025' })).toHaveAttribute(
      'href',
      `/documents/${DOC_A}?offset=120`
    )
    expect(within(a).getByText('Monthly Fee: £285')).toBeInTheDocument()
    expect(within(factEl(F_B)).getByText('now pay £310 a month')).toBeInTheDocument()
    expect(screen.getByText(/Sources disagree/)).toBeInTheDocument()
    // Validity and history.
    expect(within(factEl(F_DOUBT)).getByText(/^from /)).toBeInTheDocument()
    expect(screen.getAllByText('History (1)', { selector: 'summary' })).toHaveLength(2)
    expect(within(factEl(F_OLD)).getByText('Superseded')).toBeInTheDocument()
    expect(within(factEl(F_REJECTED)).getByText('Rejected')).toBeInTheDocument()
    // History and accepted facts carry no doubt.
    expect(within(factEl(F_OLD)).queryByText('Is this still right?')).not.toBeInTheDocument()
  })

  it('a conflicting fact offers Use this one (prefer); an unconfirmed one Confirm and Not right', async () => {
    const calls: { id: string; body: unknown }[] = []
    const answer = (id: string) => (init: RequestInit | undefined) => {
      calls.push({ id, body: JSON.parse(String(init?.body)) })
      return { fact: fact(id, { state: 'accepted' }), affected: [] }
    }
    const fetchMock = mount({
      [`POST /api/knowledge/facts/${F_B}/review`]: answer(F_B),
      [`POST /api/knowledge/facts/${F_DOUBT}/review`]: answer(F_DOUBT),
    })
    await screen.findByRole('heading', { name: 'Harbour View Dental' })
    expect(within(factEl(F_B)).queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
    fireEvent.click(within(factEl(F_B)).getByRole('button', { name: 'Use this one' }))
    await waitFor(() => expect(calls).toEqual([{ id: F_B, body: { action: 'prefer' } }]))

    fireEvent.click(within(factEl(F_DOUBT)).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(calls.at(-1)).toEqual({ id: F_DOUBT, body: { action: 'confirm' } }))
    fireEvent.click(within(factEl(F_DOUBT)).getByRole('button', { name: 'Not right' }))
    await waitFor(() => expect(calls.at(-1)).toEqual({ id: F_DOUBT, body: { action: 'reject' } }))

    // Settled in place: the card is fetched again, and nothing toasts a success.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/knowledge/entities/')).length
      ).toBeGreaterThan(1)
    )
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('a 409 is information, not an error toast', async () => {
    mount({
      [`POST /api/knowledge/facts/${F_DOUBT}/review`]: () =>
        errorResponse(
          409,
          'This fact is rejected — there is nothing left to review',
          'fact_not_reviewable'
        ),
    })
    await screen.findByRole('heading', { name: 'Harbour View Dental' })
    fireEvent.click(within(factEl(F_DOUBT)).getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/nothing left to review/)
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('a member who is not the reviewer sees a sentence, not the buttons', async () => {
    mount(
      {
        [`/api/knowledge/entities/customer/${ENTITY}`]: {
          ...CARD,
          facts: CARD.facts.map(f => ({ ...f, reviewerUserId: IDS.otherUser })),
        },
      },
      makeSession({ tenant: makeTenant({ role: 'member' }), features: ['knowledge-facts'] })
    )
    await screen.findByRole('heading', { name: 'Harbour View Dental' })
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Use this one' })).not.toBeInTheDocument()
    expect(within(factEl(F_DOUBT)).getByText(/Waiting for the person/)).toBeInTheDocument()
  })

  it('a possible match offers Merge and Keep separate; Promote only where promotable', async () => {
    const match = {
      kind: 'possibleMatch',
      entity: {
        id: ENTITY,
        type: 'customer',
        name: 'Harbour View Dental',
        aliases: [],
        promotedTo: null,
        mergedInto: null,
        createdAt: '2025-01-10T09:00:00Z',
        updatedAt: '2025-01-10T09:00:00Z',
      },
      candidates: [{ kind: 'staging', id: TWIN, label: 'Harbour View Dental Ltd', score: 0.82 }],
      reviewerUserId: IDS.user,
    }
    const action = {
      entity: match.entity,
      into: { kind: 'staging', type: 'customer', id: TWIN },
      movedFacts: 3,
      recomputedKeys: [],
    }
    const fetchMock = mount({
      [`/api/knowledge/entities/customer/${ENTITY}`]: {
        ...CARD,
        entity: { ...CARD.entity, promotable: true },
      },
      '/api/knowledge/review': paged([match]),
      [`POST /api/knowledge/entities/${ENTITY}/merge`]: action,
      [`POST /api/knowledge/entities/${ENTITY}/keep-separate`]: { ...action, into: null },
      [`POST /api/knowledge/entities/${ENTITY}/promote`]: action,
    })
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Merge Harbour View Dental into Harbour View Dental Ltd',
      })
    )
    await waitFor(() =>
      expect(requestBody(fetchMock, `POST /api/knowledge/entities/${ENTITY}/merge`)).toEqual({
        into: { kind: 'staging', id: TWIN },
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Keep separate' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u, init]) =>
            String(u) === `/api/knowledge/entities/${ENTITY}/keep-separate` &&
            init?.method === 'POST'
        )
      ).toBe(true)
    )
    // The review query asked for this entity's possible match only.
    const reviewUrl = fetchMock.mock.calls
      .map(([u]) => String(u))
      .find(u => u.startsWith('/api/knowledge/review'))
    expect(reviewUrl).toContain(`entityId=${ENTITY}`)
    expect(reviewUrl).toContain('kind=possibleMatch')

    fireEvent.change(screen.getByLabelText('Customer id'), { target: { value: 'cust-42' } })
    fireEvent.click(screen.getByRole('button', { name: 'Promote' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, `POST /api/knowledge/entities/${ENTITY}/promote`)).toEqual({
        id: 'cust-42',
      })
    )
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('offers no Promote for a type that cannot be promoted', async () => {
    mount()
    await screen.findByRole('heading', { name: 'Harbour View Dental' })
    expect(screen.queryByRole('button', { name: 'Promote' })).not.toBeInTheDocument()
  })

  it('says where a merged entity went', async () => {
    mount({
      [`/api/knowledge/entities/customer/${ENTITY}`]: {
        entity: { ...CARD.entity, mergedInto: TWIN },
        facts: [],
      },
    })
    expect(await screen.findByRole('link', { name: 'another entity' })).toHaveAttribute(
      'href',
      `/knowledge/entities/customer/${TWIN}`
    )
    expect(screen.getByText('No facts you can see')).toBeInTheDocument()
  })

  it('a hidden or absent entity is an empty state', async () => {
    mount({
      [`/api/knowledge/entities/customer/${ENTITY}`]: errorResponse(404, 'Entity not found'),
    })
    expect(await screen.findByText('Nothing found here')).toBeInTheDocument()
  })
})
