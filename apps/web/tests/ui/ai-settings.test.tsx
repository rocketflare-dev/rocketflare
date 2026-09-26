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
    suggestedModels: { chat: ['claude-sonnet-4-5', 'claude-opus-4-1'], embeddings: [] },
  },
  {
    id: 'anthropic_compatible',
    name: 'Anthropic-compatible (Fireworks, Moonshot, …)',
    scopes: ['chat'],
    needsApiKey: true,
    needsBaseUrl: true,
    supportsThinking: true,
    supportsServiceTier: true,
    defaultModel: 'accounts/fireworks/models/gpt-oss-120b',
    presets: [],
    suggestedModels: { chat: [], embeddings: [] },
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
    suggestedModels: { chat: [], embeddings: ['@cf/baai/bge-m3'] },
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
    expect(screen.getByLabelText('Model')).toHaveValue('accounts/fireworks/models/gpt-oss-120b')
    // An empty label takes the preset's name
    expect(screen.getByLabelText('Label')).toHaveValue('Fireworks AI')
    expect(screen.getByText(/fully qualified/)).toBeInTheDocument()
  })

  it("offers a provider's models as a dropdown, closed for Workers AI and open elsewhere", async () => {
    // A `<datalist>` is filtered by whatever is already in the input, so a field prefilled with the
    // provider's default model showed one option. The picker is a real select.
    const workersAi = {
      ...PROVIDERS[2],
      scopes: ['chat', 'embeddings'],
      defaultModel: '@cf/zai-org/glm-4.7-flash',
      modelsFixed: true,
      suggestedModels: {
        chat: ['@cf/zai-org/glm-4.7-flash', '@cf/nvidia/nemotron-3-120b-a12b'],
        embeddings: ['@cf/baai/bge-m3'],
      },
    }
    mount({ '/api/ai/config/providers': { items: [PROVIDERS[0], workersAi] } })
    fireEvent.click(await screen.findByRole('button', { name: 'Add chat provider' }))

    // Anthropic: every suggestion offered, plus an escape, because a model id is whatever the
    // endpoint calls it.
    const model = screen.getByLabelText('Model')
    expect(model.tagName).toBe('SELECT')
    expect(
      within(model)
        .getAllByRole('option')
        .map(o => (o as HTMLOptionElement).value)
    ).toEqual(['claude-sonnet-4-5', 'claude-opus-4-1', expect.stringContaining('other')])

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'workers_ai' } })
    const cf = screen.getByLabelText('Model')
    // Workers AI ids are a closed catalog: the list and nothing else.
    expect(
      within(cf)
        .getAllByRole('option')
        .map(o => (o as HTMLOptionElement).value)
    ).toEqual(workersAi.suggestedModels.chat)
    expect(cf).toHaveValue('@cf/zai-org/glm-4.7-flash')
    fireEvent.change(cf, { target: { value: '@cf/nvidia/nemotron-3-120b-a12b' } })
    expect(screen.getByLabelText('Model')).toHaveValue('@cf/nvidia/nemotron-3-120b-a12b')

    // Back to an open provider, and "Other" reveals a free-text field starting empty.
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'anthropic' } })
    const back = screen.getByLabelText('Model')
    const other = within(back)
      .getAllByRole('option')
      .map(o => (o as HTMLOptionElement).value)
      .find(v => v.includes('other')) as string
    fireEvent.change(back, { target: { value: other } })
    const free = screen.getByLabelText('Model id')
    expect(free).toHaveValue('')
    // Off, or the browser offers ids typed against other providers.
    expect(free).toHaveAttribute('autocomplete', 'off')
    fireEvent.change(free, { target: { value: 'claude-future-1' } })
    expect(screen.getByLabelText('Model id')).toHaveValue('claude-future-1')
  })

  it('keeps a stored model that is no longer suggested selectable', async () => {
    // The picker is an affordance, never a validation rule: an edit must not quietly move a config
    // to a model its owner did not pick.
    const retired = 'claude-retired-1'
    mount({ '/api/ai/config': { items: [{ ...prodConfig, model: retired }] } })
    fireEvent.click(await screen.findByRole('button', { name: `Edit ${prodConfig.label}` }))
    const model = await screen.findByLabelText('Model')
    expect(model).toHaveValue(retired)
    // Appended to the catalog, so the order people read is still the catalog's.
    expect(
      within(model)
        .getAllByRole('option')
        .map(o => (o as HTMLOptionElement).value)
    ).toEqual(['claude-sonnet-4-5', 'claude-opus-4-1', retired, expect.stringContaining('other')])
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
