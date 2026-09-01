/**
 * Settings → AI (D17): readiness `none` shows the set-up CTA; adding a config validates with the
 * shared schema and posts the exact upsert body; preset chips fill base URL + model; a member sees
 * readiness and the list but no write controls; delete confirms then calls DELETE.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AiSettings from '@/ui/pages/settings/AI'
import {
  IDS,
  makeSession,
  makeTenant,
  type RouteTable,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'

const now = '2025-06-01T00:00:00Z'
const CONFIG_ID = '77777777-7777-4777-8777-777777777777'

/** The catalog exactly as `GET /api/ai/config/providers` serves it (server data, no shared schema). */
const PROVIDERS = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    scopes: ['chat'],
    needsApiKey: true,
    needsBaseUrl: false,
    supportsThinking: true,
    supportsServiceTier: true,
    defaultModel: 'claude-sonnet-4-5',
    presets: [],
    suggestedModels: ['claude-sonnet-4-5', 'claude-opus-4-1'],
  },
  {
    id: 'anthropic_compatible',
    name: 'Anthropic-compatible (Fireworks, Moonshot, …)',
    scopes: ['chat'],
    needsApiKey: true,
    needsBaseUrl: true,
    supportsThinking: true,
    supportsServiceTier: true,
    defaultModel: 'accounts/fireworks/models/kimi-k2-instruct',
    presets: [],
    suggestedModels: [],
  },
  {
    id: 'workers_ai',
    name: 'Cloudflare Workers AI',
    scopes: ['embeddings'],
    needsApiKey: false,
    needsBaseUrl: false,
    supportsThinking: false,
    supportsServiceTier: false,
    defaultModel: '@cf/baai/bge-m3',
    presets: [],
    suggestedModels: ['@cf/baai/bge-m3'],
  },
]

const NONE = { ready: false, source: 'none' }
const READY_CHAT = {
  ready: true,
  source: 'tenant',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
}

const prodConfig = {
  id: CONFIG_ID,
  tenantId: IDS.tenant,
  scope: 'chat',
  provider: 'anthropic',
  label: 'Prod',
  baseUrl: null,
  model: 'claude-sonnet-4-5',
  isDefault: true,
  hasCredential: true,
  thinking: { enabled: false },
  serviceTier: null,
  createdAt: now,
  updatedAt: now,
}

function mount(routes: RouteTable = {}, session = makeSession()) {
  const fetchMock = stubFetch({
    '/api/ai/config/providers': { items: PROVIDERS, defaultMaxOutputTokens: 16_384 },
    '/api/ai/config/readiness': { chat: NONE, embeddings: NONE },
    '/api/ai/config': { items: [] },
    ...routes,
  })
  renderWithProviders(<AiSettings />, { session })
  return fetchMock
}

const openDialog = () => document.querySelector('dialog[open]') as HTMLElement

describe('Settings → AI', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows a set-up CTA when readiness is none and opens the add modal', async () => {
    mount()
    expect(await screen.findAllByText('Not configured')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Set up chat' }))
    expect(await screen.findByRole('heading', { name: 'Add chat provider' })).toBeInTheDocument()
    // Anthropic is the first chat provider; its default model is prefilled
    expect(screen.getByLabelText('Provider')).toHaveValue('anthropic')
    expect(screen.getByLabelText('Model')).toHaveValue('claude-sonnet-4-5')
  })

  it('validates with the shared schema and posts the exact upsert body', async () => {
    const fetchMock = mount({
      'POST /api/ai/config': (init: RequestInit | undefined) => {
        const body = JSON.parse(String(init?.body)) as { apiKey?: string; serviceTier?: string }
        // The server sanitises: no key comes back, '' clears the tier to null
        const { apiKey: _apiKey, serviceTier, ...rest } = body
        return { ...prodConfig, ...rest, serviceTier: serviceTier || null, hasCredential: true }
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Add chat provider' }))
    const form = document.getElementById('ai-config-form') as HTMLFormElement

    // Empty label + no key → field errors, no request
    fireEvent.submit(form)
    expect(await screen.findAllByRole('alert')).not.toHaveLength(0)
    expect(requestBody(fetchMock, 'POST /api/ai/config')).toBeUndefined()

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: ' Prod ' } })
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'sk-test' } })
    fireEvent.submit(form)

    await waitFor(() =>
      expect(requestBody(fetchMock, 'POST /api/ai/config')).toEqual({
        scope: 'chat',
        label: 'Prod',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        apiKey: 'sk-test',
        // First entry in the scope: default is implied and checked
        isDefault: true,
        thinking: { enabled: false },
        serviceTier: '',
      })
    )
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Add chat provider' })).not.toBeInTheDocument()
    )
  })

  it('preset chips fill the base URL and model', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Add chat provider' }))
    fireEvent.change(screen.getByLabelText('Provider'), {
      target: { value: 'anthropic_compatible' },
    })
    const presets = screen.getByRole('group', { name: 'Presets' })
    expect(within(presets).getByRole('button', { name: 'Moonshot (Kimi)' })).toBeInTheDocument()
    fireEvent.click(within(presets).getByRole('button', { name: 'Fireworks AI' }))

    expect(screen.getByLabelText('Base URL')).toHaveValue('https://api.fireworks.ai/inference')
    expect(screen.getByLabelText('Model')).toHaveValue('accounts/fireworks/models/kimi-k2-instruct')
    // An empty label takes the preset's name
    expect(screen.getByLabelText('Label')).toHaveValue('Fireworks AI')
    expect(screen.getByText(/fully qualified/)).toBeInTheDocument()
  })

  it('lists configs with default/credential badges and lets an admin test one', async () => {
    const fetchMock = mount({
      '/api/ai/config/readiness': { chat: READY_CHAT, embeddings: NONE },
      '/api/ai/config': { items: [prodConfig] },
      'POST /api/ai/config/test': {
        ok: true,
        latencyMs: 412,
        model: 'claude-sonnet-4-5',
        provider: 'anthropic',
      },
    })
    expect(await screen.findByText('Prod')).toBeInTheDocument()
    expect(screen.getByText('default')).toBeInTheDocument()
    expect(screen.getByText('key stored')).toBeInTheDocument()
    expect(screen.getByText('Ready')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Test Prod' }))
    expect(await screen.findByText(/Connected/)).toBeInTheDocument()
    expect(screen.getByText(/412 ms/)).toBeInTheDocument()
    expect(requestBody(fetchMock, 'POST /api/ai/config/test')).toEqual({ configId: CONFIG_ID })
  })

  it('deletes after confirmation', async () => {
    const fetchMock = mount({
      '/api/ai/config': { items: [prodConfig] },
      [`DELETE /api/ai/config/${CONFIG_ID}`]: new Response(null, { status: 204 }),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Prod' }))
    const dialog = await waitFor(() => {
      const el = openDialog()
      expect(el).toBeTruthy()
      return el
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            init?.method === 'DELETE' && String(input).endsWith(`/api/ai/config/${CONFIG_ID}`)
        )
      ).toBe(true)
    )
  })

  it('shows a member the readiness and list without write controls', async () => {
    mount(
      {
        '/api/ai/config/readiness': { chat: READY_CHAT, embeddings: NONE },
        '/api/ai/config': { items: [prodConfig] },
      },
      makeSession({ tenant: makeTenant({ role: 'member' }) })
    )
    expect(await screen.findByText('Prod')).toBeInTheDocument()
    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.getByText('Ask an administrator to add a provider.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Add/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Set up/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Edit|Delete|Test/ })).not.toBeInTheDocument()
  })
})
