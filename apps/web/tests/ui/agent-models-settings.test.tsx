/**
 * Settings → Agent models (D17): the table shows each prompt key with its effective provider/model
 * and source badge; Override validates with the shared schema (at least one of config/model) and
 * PUTs exactly what is set; "Use default" DELETEs; a member sees the table read-only.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentModelsSettings from '@/ui/pages/settings/AgentModels'
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
const PROD = '77777777-7777-4777-8777-777777777777'
const CHEAP = '88888888-8888-4888-8888-888888888888'

const config = (id: string, label: string, model: string, isDefault: boolean) => ({
  id,
  tenantId: IDS.tenant,
  scope: 'chat',
  provider: 'anthropic',
  label,
  baseUrl: null,
  model,
  isDefault,
  hasCredential: true,
  thinking: { enabled: false },
  serviceTier: null,
  createdAt: now,
  updatedAt: now,
})

const CONFIGS = {
  items: [
    config(PROD, 'Prod', 'claude-sonnet-4-5', true),
    config(CHEAP, 'Cheap', 'claude-haiku-4-5', false),
  ],
}

const ENTRIES = {
  items: [
    {
      promptKey: 'chat',
      title: 'Chat assistant',
      assignment: null,
      effective: {
        source: 'tenant',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        configId: PROD,
      },
    },
    {
      promptKey: 'summarize-text',
      title: 'Summarize text',
      assignment: { promptKey: 'summarize-text', aiConfigId: CHEAP, model: null, updatedAt: now },
      effective: {
        source: 'assignment',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        configId: CHEAP,
      },
    },
  ],
}

function mount(routes: RouteTable = {}, session = makeSession()) {
  const fetchMock = stubFetch({
    '/api/ai/agent-models': ENTRIES,
    '/api/ai/config': CONFIGS,
    ...routes,
  })
  renderWithProviders(<AgentModelsSettings />, { session })
  return fetchMock
}

describe('Settings → Agent models', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lists every prompt key with its effective model and source', async () => {
    mount()
    expect(await screen.findByText('Chat assistant')).toBeInTheDocument()
    const chatRow = screen.getByText('Chat assistant').closest('tr') as HTMLElement
    expect(chatRow).toHaveTextContent('claude-sonnet-4-5')
    expect(chatRow).toHaveTextContent('tenant')
    expect(chatRow).toHaveTextContent('Prod')
    const agentRow = screen.getByText('Summarize text').closest('tr') as HTMLElement
    expect(agentRow).toHaveTextContent('claude-haiku-4-5')
    expect(agentRow).toHaveTextContent('agent')
    expect(
      screen.getByRole('button', { name: 'Use default for Summarize text' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Use default for Chat assistant' })
    ).not.toBeInTheDocument()
  })

  it('overrides with a config and model and PUTs exactly what is set', async () => {
    const fetchMock = mount({
      'PUT /api/ai/agent-models/chat': (init: RequestInit | undefined) => {
        const body = JSON.parse(String(init?.body)) as { aiConfigId?: string; model?: string }
        return {
          promptKey: 'chat',
          aiConfigId: body.aiConfigId ?? null,
          model: body.model ?? null,
          updatedAt: now,
        }
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Override Chat assistant' }))
    const form = document.getElementById('agent-model-form') as HTMLFormElement

    // Nothing set → the refine fires, no request
    fireEvent.submit(form)
    expect(await screen.findByText(/Set aiConfigId, model, or both/)).toBeInTheDocument()
    expect(requestBody(fetchMock, 'PUT /api/ai/agent-models/chat')).toBeUndefined()

    fireEvent.change(screen.getByLabelText('Chat provider'), { target: { value: CHEAP } })
    fireEvent.change(screen.getByLabelText(/^Model/), { target: { value: '  claude-opus-4-1 ' } })
    fireEvent.submit(form)

    await waitFor(() =>
      expect(requestBody(fetchMock, 'PUT /api/ai/agent-models/chat')).toEqual({
        aiConfigId: CHEAP,
        model: 'claude-opus-4-1',
      })
    )
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: /Override model/ })).not.toBeInTheDocument()
    )
  })

  it('sends only the model when the default config is kept', async () => {
    const fetchMock = mount({
      'PUT /api/ai/agent-models/chat': {
        promptKey: 'chat',
        aiConfigId: null,
        model: 'claude-opus-4-1',
        updatedAt: now,
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Override Chat assistant' }))
    fireEvent.change(screen.getByLabelText(/^Model/), { target: { value: 'claude-opus-4-1' } })
    fireEvent.submit(document.getElementById('agent-model-form') as HTMLFormElement)
    await waitFor(() =>
      expect(requestBody(fetchMock, 'PUT /api/ai/agent-models/chat')).toEqual({
        model: 'claude-opus-4-1',
      })
    )
  })

  it('"Use default" DELETEs the assignment', async () => {
    const fetchMock = mount({ 'DELETE /api/ai/agent-models/summarize-text': undefined })
    fireEvent.click(await screen.findByRole('button', { name: 'Use default for Summarize text' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith('/api/ai/agent-models/summarize-text') &&
            init?.method === 'DELETE'
        )
      ).toBe(true)
    )
  })

  it('is read-only for a member and links to the AI tab when nothing is configured', async () => {
    mount(
      {
        '/api/ai/config': { items: [] },
        '/api/ai/agent-models': {
          items: [
            {
              promptKey: 'chat',
              title: 'Chat assistant',
              assignment: null,
              effective: { source: 'none' },
            },
          ],
        },
      },
      makeSession({ tenant: makeTenant({ role: 'member' }) })
    )
    expect(await screen.findByText('Chat assistant')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Override/ })).not.toBeInTheDocument()
    expect(screen.getByText('not configured')).toBeInTheDocument()
    expect(screen.getByText('Nothing answers agents yet')).toBeInTheDocument()
    // A member cannot configure: no CTA link
    expect(screen.queryByRole('link', { name: 'Open the AI tab' })).not.toBeInTheDocument()
  })
})
