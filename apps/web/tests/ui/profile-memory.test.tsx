/**
 * Profile → Memory (D36): the panel exists only where the organisation has the `memory` flag, lists
 * what was learned with both clocks, and its controls call the person's own routes — the switch,
 * forgetting one fact, forgetting everything (behind a confirm).
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Profile from '@/ui/pages/Profile'
import { occurredLabel } from '@/ui/pages/ProfileMemory'
import {
  makeSession,
  makeUser,
  paged,
  renderWithProviders,
  stubFetch,
} from './helpers/renderWithProviders'

const FACT = {
  id: '11111111-1111-4111-8111-111111111111',
  text: 'Leads the Payments team',
  kind: 'fact',
  visibility: 'private',
  occurredStart: '2026-03-01T00:00:00.000Z',
  occurredEnd: null,
  mentionedAt: '2026-10-01T09:00:00.000Z',
  entities: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Payments' }],
  sourceConversationId: null,
  invalidatedAt: null,
  supersededById: null,
  createdAt: '2026-10-01T09:00:00.000Z',
}

const base = {
  '/api/me': { ...makeUser(), preferences: {} },
  '/auth/methods': { magicLink: true, providers: [], devLogin: false, oidcOnly: false },
  '/auth/providers': { providers: [] },
}

describe('Profile → Memory', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is absent without the flag', async () => {
    const fetch = stubFetch(base)
    renderWithProviders(<Profile />, { session: makeSession() })
    expect(await screen.findByText('Sign-in methods')).toBeInTheDocument()
    expect(screen.queryByText('Memory')).not.toBeInTheDocument()
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/api/memory'))).toBe(false)
  })

  it('lists facts, switches off, forgets one and forgets everything', async () => {
    const fetch = stubFetch({
      ...base,
      '/api/memory': paged([FACT], 20),
      '/api/memory/settings': { available: true, enabled: true },
      'PUT /api/memory/settings': { available: true, enabled: false },
      [`DELETE /api/memory/${FACT.id}`]: undefined,
      'DELETE /api/memory': { deleted: 1 },
    })
    renderWithProviders(<Profile />, { session: makeSession({ features: ['memory'] }) })

    expect(await screen.findByText('Leads the Payments team')).toBeInTheDocument()
    expect(screen.getByText('Payments')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Remember things I tell the assistant'))
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, init]) => String(url).endsWith('/api/memory/settings') && init?.method === 'PUT'
        )
      ).toBe(true)
    )
    expect(await screen.findByText(/Memory is off/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Forget "Leads the Payments team"' }))
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith(`/api/memory/${FACT.id}`) && init?.method === 'DELETE'
        )
      ).toBe(true)
    )

    fireEvent.click(screen.getByRole('button', { name: 'Forget everything' }))
    const confirm = await screen.findAllByRole('button', { name: 'Forget everything' })
    fireEvent.click(confirm[confirm.length - 1] as HTMLElement)
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, init]) => String(url).endsWith('/api/memory') && init?.method === 'DELETE'
        )
      ).toBe(true)
    )
  })

  it('occurredLabel says when, or nothing', () => {
    expect(occurredLabel({ occurredStart: null, occurredEnd: null })).toBeNull()
    expect(occurredLabel({ occurredStart: new Date('2026-03-01'), occurredEnd: null })).toMatch(
      /^since /
    )
  })
})
