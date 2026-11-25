/**
 * Profile → Connected apps: the reader's own MCP connections across organisations, with Revoke —
 * shown only where the deployment ships MCP, and only when there is one.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Profile from '@/ui/pages/Profile'
import { mcpConnection as connection } from './helpers/mcp'
import {
  makeSession,
  makeUser,
  renderWithProviders,
  stubFetch,
} from './helpers/renderWithProviders'

const base = {
  '/api/me': { ...makeUser(), preferences: {} },
  '/auth/methods': { magicLink: true, providers: [], devLogin: false, oidc: null, oidcOnly: false },
  '/auth/providers': { providers: [] },
}

describe('Profile → Connected apps', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lists the reader’s connections by organisation and revokes one after a confirmation', async () => {
    const fetchMock = stubFetch({
      ...base,
      '/api/mcp-connections': { items: [connection()] },
      'DELETE /api/mcp-connections/00000000-0000-4000-8000-000000000001': () => null,
    })
    renderWithProviders(<Profile />, { session: makeSession({ features: ['mcp'] }) })
    const row = (await screen.findByText('Acme')).closest('tr') as HTMLElement
    expect(within(row).getByText('claude.ai')).toBeInTheDocument()
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/Disconnect Claude from Acme/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, i]) => i?.method === 'DELETE' && String(input).includes('/api/mcp-connections/')
        )
      ).toBe(true)
    )
  })

  it('is absent where the deployment does not ship MCP — and never asks', async () => {
    const fetchMock = stubFetch({ ...base, '/api/mcp-connections': { items: [connection()] } })
    renderWithProviders(<Profile />, { session: makeSession() })
    await screen.findByText('Your account')
    expect(screen.queryByText('Connected apps')).toBeNull()
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('mcp-connections'))).toBe(
      false
    )
  })
})
