import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ApiKeys from '@/ui/pages/settings/ApiKeys'
import {
  IDS,
  makeSession,
  paged,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'

const now = '2025-06-01T00:00:00Z'
const key = (id: string, name: string, revokedAt: string | null) => ({
  id,
  name,
  keyPrefix: `gm_${name.toLowerCase()}`,
  scopes: ['read', 'write'],
  createdByUserId: IDS.user,
  lastUsedAt: null,
  expiresAt: null,
  revokedAt,
  createdAt: now,
})

describe('Settings → API keys', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lists keys by prefix with active/revoked status', async () => {
    stubFetch({
      '/api/keys': paged([
        key('77777777-7777-4777-8777-777777777777', 'Deploy', null),
        key('88888888-8888-4888-8888-888888888888', 'Old', now),
      ]),
    })
    renderWithProviders(<ApiKeys />, { session: makeSession() })
    expect(await screen.findByText('gm_deploy…')).toBeInTheDocument()
    expect(screen.getByText('active')).toBeInTheDocument()
    expect(screen.getByText('revoked')).toBeInTheDocument()
    // Only the active key can be revoked
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1)
  })

  it('creates a key with the shared schema and shows the plaintext exactly once', async () => {
    const fetchMock = stubFetch({
      '/api/keys': paged([]),
      'POST /api/keys': {
        ...key('99999999-9999-4999-8999-999999999999', 'CI', null),
        key: 'gm_live_SECRET_ONCE',
      },
    })
    renderWithProviders(<ApiKeys />, { session: makeSession() })
    fireEvent.click(await screen.findByRole('button', { name: /Create key/ }))
    const form = document.getElementById('create-key-form') as HTMLFormElement

    fireEvent.submit(form)
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(requestBody(fetchMock, 'POST /api/keys')).toBeUndefined()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'CI' } })
    fireEvent.click(screen.getByLabelText('write'))
    fireEvent.submit(form)

    const shown = await screen.findByLabelText('API key')
    expect(shown).toHaveValue('gm_live_SECRET_ONCE')
    expect(requestBody(fetchMock, 'POST /api/keys')).toEqual({
      name: 'CI',
      scopes: ['read'],
      expiresAt: null,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByLabelText('API key')).not.toBeInTheDocument())
    // Reopening starts a fresh form — the secret is gone for good
    fireEvent.click(screen.getByRole('button', { name: /Create key/ }))
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('')
  })

  it('hides create/revoke from a member', async () => {
    stubFetch({ '/api/keys': paged([key('77777777-7777-4777-8777-777777777777', 'Deploy', null)]) })
    renderWithProviders(<ApiKeys />, {
      session: makeSession({
        tenant: { id: IDS.tenant, name: 'Acme', slug: 'acme', role: 'member' },
      }),
    })
    expect(await screen.findByText('gm_deploy…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Create key/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument()
  })
})
