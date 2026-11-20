/**
 * Settings → MCP: the tab appears only where the deployment ships `mcp` AND the reader may manage
 * it; the page shows the organisation's own URL and setup snippets named from the deployment (never
 * the kit's name); the switch and the modes save at once, "Enable all" only after a confirmation;
 * the tools are grouped Knowledge first, unavailable ones greyed with their reason, and under
 * "Selected" the ticks save as one list.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import McpSettingsPage, { cliServerName } from '@/ui/pages/settings/Mcp'
import SettingsLayout from '@/ui/pages/settings/SettingsLayout'
import {
  makeSession,
  makeTenant,
  renderWithProviders,
  requestBody,
  rulesFor,
  stubFetch,
} from './helpers/renderWithProviders'

const settings = (over: Record<string, unknown> = {}) => ({
  enabled: false,
  exposure: 'read_only',
  exposedTools: [],
  connectPolicy: 'everyone',
  connectGroupIds: [],
  updatedAt: null,
  updatedByUserId: null,
  ...over,
})

const settingsResponse = (over: Record<string, unknown> = {}) => ({
  settings: settings(over),
  serverUrl: 'https://tools.example.test/mcp',
  organisationServerUrl: 'https://tools.example.test/mcp/t/acme',
  serverName: 'Acme Tools',
})

const annotations = (readOnly: boolean) => ({
  readOnlyHint: readOnly,
  destructiveHint: !readOnly,
  idempotentHint: readOnly,
  openWorldHint: false,
})

const tool = (over: Record<string, unknown>) => ({
  provider: 'core',
  title: null,
  description: 'A tool.',
  scope: 'mcp:read',
  readOnly: true,
  annotations: annotations(true),
  unavailableReason: null,
  exposed: true,
  calls30d: 0,
  ...over,
})

const tools = {
  tools: [
    tool({ name: 'example_tool', provider: 'example-feature', calls30d: 1 }),
    tool({ name: 'search_knowledge', title: 'Search knowledge', calls30d: 12 }),
    tool({
      name: 'archive_note',
      provider: 'example-feature',
      scope: 'mcp:write',
      readOnly: false,
      annotations: annotations(false),
      exposed: false,
    }),
    tool({ name: 'approve_thing', unavailableReason: 'approval', exposed: false }),
  ],
}

function stubMcp(over: Record<string, unknown> = {}) {
  let current = settingsResponse(over)
  return stubFetch({
    '/api/mcp/settings': () => current,
    'PUT /api/mcp/settings': (init: RequestInit | undefined) => {
      const patch = JSON.parse(String(init?.body))
      current = { ...current, settings: { ...current.settings, ...patch } }
      return current.settings
    },
    '/api/mcp/tools': tools,
    '/api/groups': { items: [] },
  })
}

describe('Settings → MCP', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows the tab only where the deployment ships mcp and the reader manages it', async () => {
    stubMcp()
    const off = renderWithProviders(<SettingsLayout />, { session: makeSession() })
    await screen.findByRole('tab', { name: /general/i })
    expect(screen.queryByRole('tab', { name: 'MCP' })).toBeNull()
    off.unmount()

    renderWithProviders(<SettingsLayout />, {
      session: makeSession({ features: ['mcp'], permissions: rulesFor('owner', false, ['mcp']) }),
    })
    expect(await screen.findByRole('tab', { name: 'MCP' })).toBeInTheDocument()
  })

  it('hides the tab from a member even when the flag is on', async () => {
    stubMcp()
    const tenant = makeTenant({ role: 'member' })
    renderWithProviders(<SettingsLayout />, {
      session: makeSession({ tenant, features: ['mcp'], permissions: rulesFor('member') }),
    })
    await screen.findByRole('tab', { name: /general/i })
    expect(screen.queryByRole('tab', { name: 'MCP' })).toBeNull()
  })

  it('gives the organisation URL and snippets named from the deployment, never the kit', async () => {
    stubMcp()
    const { container } = renderWithProviders(<McpSettingsPage />, { session: makeSession() })
    expect(await screen.findByLabelText('Server URL')).toHaveValue(
      'https://tools.example.test/mcp/t/acme'
    )
    expect(
      screen.getByText(
        'claude mcp add --transport http acme-tools https://tools.example.test/mcp/t/acme'
      )
    ).toBeInTheDocument()
    await screen.findByText('search_knowledge')
    expect(container.textContent).not.toMatch(/rocketflare/i)
    expect(cliServerName('  Ünïcode & Co. ')).toBe('n-code-co')
  })

  it('under single tenancy gives the one URL', async () => {
    stubMcp()
    renderWithProviders(<McpSettingsPage />, { session: makeSession({ tenancyMode: 'single' }) })
    expect(await screen.findByLabelText('Server URL')).toHaveValue('https://tools.example.test/mcp')
  })

  it('saves the switch at once', async () => {
    const fetchMock = stubMcp()
    renderWithProviders(<McpSettingsPage />, { session: makeSession() })
    fireEvent.click(await screen.findByLabelText('Allow MCP clients'))
    await waitFor(() =>
      expect(requestBody(fetchMock, 'PUT /api/mcp/settings')).toEqual({ enabled: true })
    )
  })

  it('asks before enabling every tool', async () => {
    const fetchMock = stubMcp()
    renderWithProviders(<McpSettingsPage />, { session: makeSession() })
    fireEvent.click(await screen.findByRole('radio', { name: /enable all/i }))
    expect(requestBody(fetchMock, 'PUT /api/mcp/settings')).toBeUndefined()
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/make changes as the people who connected them/i)).toBeVisible()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enable all' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, 'PUT /api/mcp/settings')).toEqual({ exposure: 'all' })
    )
  })

  it('groups tools Knowledge first and greys out the ones no client can reach', async () => {
    stubMcp()
    renderWithProviders(<McpSettingsPage />, { session: makeSession() })
    await screen.findByText('Search knowledge')
    const sections = screen.getAllByRole('region').map(s => s.getAttribute('aria-label'))
    expect(sections.indexOf('Knowledge')).toBeLessThan(sections.indexOf('Example feature'))
    const knowledge = screen.getByRole('region', { name: 'Knowledge' })
    expect(within(knowledge).getByText('12 calls')).toBeInTheDocument()
    expect(within(knowledge).getByText(/needs an approval/i)).toBeInTheDocument()
    const plugin = screen.getByRole('region', { name: 'Example feature' })
    expect(within(plugin).getByText('writes')).toBeInTheDocument()
  })

  it('under Selected saves the ticked tools as one list', async () => {
    const fetchMock = stubMcp({ exposure: 'selected', exposedTools: ['search_knowledge'] })
    renderWithProviders(<McpSettingsPage />, { session: makeSession() })
    const approve = await screen.findByRole('checkbox', { name: 'Expose approve_thing' })
    expect(approve).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Expose Search knowledge' })).toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Expose example_tool' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save selection' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, 'PUT /api/mcp/settings')).toEqual({
        exposedTools: ['search_knowledge', 'example_tool'],
      })
    )
  })
})
