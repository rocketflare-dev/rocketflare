/**
 * Settings → Prompts (D17): the registry list with Default/Overridden badges; the editor inserts
 * `{{variables}}`, counts characters, previews with sample values, saves through `PUT` and resets
 * through `DELETE` after confirmation; a member gets a read-only view.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PromptsSettings from '@/ui/pages/settings/Prompts'
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
const DEFAULT_TEXT =
  'You are the assistant for {{appName}}, helping {{userName}} at {{tenantName}}.'

const definition = {
  key: 'chat',
  title: 'Chat assistant',
  description: 'The system prompt behind the chat surface.',
  variables: ['appName', 'tenantName', 'userName'],
  defaultText: DEFAULT_TEXT,
}

const defaultPrompt = {
  definition,
  override: null,
  isOverridden: false,
  effectiveText: DEFAULT_TEXT,
}

const overriddenPrompt = {
  definition,
  override: {
    tenantId: IDS.tenant,
    key: 'chat',
    text: 'Be terse.',
    updatedByUserId: IDS.user,
    updatedAt: now,
  },
  isOverridden: true,
  effectiveText: 'Be terse.',
}

function mount(routes: RouteTable = {}, session = makeSession()) {
  const fetchMock = stubFetch({ '/api/ai/prompts': { items: [defaultPrompt] }, ...routes })
  renderWithProviders(<PromptsSettings />, { session })
  return fetchMock
}

const openDialog = () => document.querySelector('dialog[open]') as HTMLElement

describe('Settings → Prompts', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lists the registry and edits an override with variables, count and preview', async () => {
    const fetchMock = mount({
      'PUT /api/ai/prompts/chat': (init: RequestInit | undefined) => {
        const { text } = JSON.parse(String(init?.body)) as { text: string }
        return {
          ...overriddenPrompt,
          override: { ...overriddenPrompt.override, text },
          effectiveText: text,
        }
      },
    })
    expect(await screen.findByText('Chat assistant')).toBeInTheDocument()
    expect(screen.getByText('Default')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit Chat assistant' }))
    const textarea = (await screen.findByLabelText('Prompt text')) as HTMLTextAreaElement
    expect(textarea).toHaveValue(DEFAULT_TEXT)
    expect(screen.getByText(`${DEFAULT_TEXT.length} / 20,000`)).toBeInTheDocument()

    // Insert a variable at the caret (end of text)
    textarea.setSelectionRange(DEFAULT_TEXT.length, DEFAULT_TEXT.length)
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Variables' })).getByRole('button', {
        name: '{{userName}}',
      })
    )
    expect(textarea).toHaveValue(`${DEFAULT_TEXT}{{userName}}`)

    // Preview interpolates sample values (the session tenant is "Acme")
    fireEvent.click(screen.getByRole('button', { name: 'Preview with sample values' }))
    expect(screen.getByText(/at Acme\./)).toBeInTheDocument()

    fireEvent.change(textarea, { target: { value: 'Be terse.' } })
    expect(screen.getByText('9 / 20,000')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, 'PUT /api/ai/prompts/chat')).toEqual({ text: 'Be terse.' })
    )
    await waitFor(() => expect(screen.queryByLabelText('Prompt text')).not.toBeInTheDocument())
  })

  it('resets an override to the default after confirmation', async () => {
    const fetchMock = mount({
      '/api/ai/prompts': { items: [overriddenPrompt] },
      'DELETE /api/ai/prompts/chat': defaultPrompt,
    })
    expect(await screen.findByText('Overridden')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit Chat assistant' }))
    expect(await screen.findByLabelText('Prompt text')).toHaveValue('Be terse.')

    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }))
    const dialog = await waitFor(() => {
      // The confirm dialog is the LAST open dialog (the editor is the first)
      const dialogs = document.querySelectorAll('dialog[open]')
      expect(dialogs.length).toBeGreaterThan(1)
      return dialogs[dialogs.length - 1] as HTMLElement
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            init?.method === 'DELETE' && String(input).endsWith('/api/ai/prompts/chat')
        )
      ).toBe(true)
    )
    expect(openDialog()).toBeNull()
  })

  it('gives a member a read-only view', async () => {
    mount({}, makeSession({ tenant: makeTenant({ role: 'member' }) }))
    fireEvent.click(await screen.findByRole('button', { name: 'View Chat assistant' }))
    const textarea = await screen.findByLabelText('Prompt text')
    expect(textarea).toHaveAttribute('readonly')
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reset to default' })).not.toBeInTheDocument()
  })
})
