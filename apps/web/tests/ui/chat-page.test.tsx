/**
 * `/chat/:conversationId` (D17): send → AG-UI frames → the assistant bubble accumulates deltas and
 * shows the usage footnote; Shift+Enter does not send; Stop aborts the stream (a cancelled run
 * emits NO terminal event, and that must not read as an error); a 503 `ai_not_configured` renders
 * the configure call to action (admins) or the "ask an admin" copy.
 */
import { AguiEventType, KIT_CUSTOM_EVENTS } from '@rocketflare/shared/ai/agui'
import type { Message } from '@rocketflare/shared/ai/chat'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ChatPage from '@/ui/pages/chat/ChatPage'
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
import { aguiRun, hangingSseResponse, sseResponse } from './helpers/sse'

const CONV = '12121212-1212-4121-8121-121212121212'
const ASSISTANT_ID = '34343434-3434-4343-8343-343434343434'
const USER_MSG_ID = '56565656-5656-4565-8565-565656565656'
const now = '2025-06-01T00:00:00Z'

const conversation = {
  id: CONV,
  tenantId: IDS.tenant,
  userId: IDS.user,
  title: 'New conversation',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  createdAt: now,
  updatedAt: now,
  lastMessageAt: null,
}

const run = (over: Partial<Parameters<typeof aguiRun>[0]> = {}) =>
  aguiRun({
    conversationId: CONV,
    userMessageId: USER_MSG_ID,
    assistantMessageId: ASSISTANT_ID,
    ...over,
  })

const READY = {
  chat: { ready: true, source: 'tenant', provider: 'anthropic', model: 'claude-sonnet-4-5' },
  embeddings: { ready: false, source: 'none' },
}

function mount(routes: RouteTable, session = makeSession()) {
  const fetchMock = stubFetch({
    '/api/ai/config/readiness': READY,
    '/api/chat/conversations': paged([conversation]),
    ...routes,
  })
  renderWithProviders(
    <Routes>
      <Route path="/chat/:conversationId?" element={<ChatPage />} />
    </Routes>,
    { route: `/chat/${CONV}`, session }
  )
  return fetchMock
}

async function typeAndSend(text: string) {
  const composer = await screen.findByLabelText('Message')
  await waitFor(() => expect(composer).not.toBeDisabled())
  fireEvent.change(composer, { target: { value: text } })
  fireEvent.keyDown(composer, { key: 'Enter' })
}

describe('Chat page', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('streams the reply into an assistant bubble and shows usage', async () => {
    // The stub is stateful: after the POST the thread "has" both messages, as the server would.
    let messages: Array<Omit<Message, 'createdAt'> & { createdAt: string }> = []
    const fetchMock = mount({
      [`/api/chat/conversations/${CONV}`]: () => ({ ...conversation, messages }),
      [`POST /api/chat/conversations/${CONV}/messages`]: () => {
        messages = [
          {
            id: USER_MSG_ID,
            conversationId: CONV,
            role: 'user',
            content: 'Hi there',
            createdAt: now,
          },
          {
            id: ASSISTANT_ID,
            conversationId: CONV,
            role: 'assistant',
            content: 'Hello',
            usage: { inputTokens: 12, outputTokens: 5 },
            createdAt: now,
          },
        ]
        return sseResponse(run({ text: ['Hel', 'lo'] }))
      },
    })

    await typeAndSend('Hi there')

    // Optimistic user bubble, then the accumulated reply and its footnote. `waitFor` + `getBy`
    // rather than `findBy`: the bubbles remount as optimistic ids become persisted ones.
    await waitFor(() => expect(screen.getByText('Hi there')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText(/12 in · 5 out tokens/)).toBeInTheDocument())
    expect(requestBody(fetchMock, `POST /api/chat/conversations/${CONV}/messages`)).toEqual({
      content: 'Hi there',
    })
    // Composer cleared and ready again
    expect(screen.getByLabelText('Message')).toHaveValue('')
    await waitFor(() => expect(screen.getByRole('button', { name: /Send/ })).toBeDisabled())
  })

  it('shows one row per tool call, completed in place rather than appended to', async () => {
    // Mid-stream: the steps belong to the turn in flight and clear when it finishes.
    const hanging = hangingSseResponse(
      run({
        unterminated: true,
        tools: [
          { id: 'c1', name: 'search_knowledge', result: '{}' },
          { id: 'c2', name: 'get_document', result: '{}' },
        ],
      })
    )
    mount({
      [`/api/chat/conversations/${CONV}`]: { ...conversation, messages: [] },
      [`POST /api/chat/conversations/${CONV}/messages`]: () => hanging.response,
    })
    await typeAndSend('What is the maintenance schedule?')
    await waitFor(() => expect(screen.getByText('Reading a document')).toBeInTheDocument())
    expect(screen.getByText('Searching the knowledge base')).toBeInTheDocument()
    // A call and its result are ONE row: no separate "Done" line per call.
    expect(screen.queryByText('Done')).not.toBeInTheDocument()
  })

  it('renders a kit notice as a quiet line, not an error', async () => {
    mount({
      [`/api/chat/conversations/${CONV}`]: { ...conversation, messages: [] },
      [`POST /api/chat/conversations/${CONV}/messages`]: () =>
        sseResponse([
          ...run({ text: ['Answer.'], unterminated: true }),
          {
            type: AguiEventType.CUSTOM,
            name: KIT_CUSTOM_EVENTS.notice,
            value: { code: 'workers_ai_no_token_streaming' },
          },
        ]),
    })
    await typeAndSend('Anything indexed?')
    await waitFor(() =>
      expect(screen.getByText(/cannot stream token by token/)).toBeInTheDocument()
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not send on Shift+Enter', async () => {
    const fetchMock = mount({
      [`/api/chat/conversations/${CONV}`]: { ...conversation, messages: [] },
    })
    const composer = await screen.findByLabelText('Message')
    await waitFor(() => expect(composer).not.toBeDisabled())
    fireEvent.change(composer, { target: { value: 'line one' } })
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true })
    expect(requestBody(fetchMock, `POST /api/chat/conversations/${CONV}/messages`)).toBeUndefined()
    expect(composer).toHaveValue('line one')
  })

  it('Stop aborts the stream and returns the composer to idle', async () => {
    const hanging = hangingSseResponse(run({ text: ['Partial'], unterminated: true }))
    mount({
      [`/api/chat/conversations/${CONV}`]: { ...conversation, messages: [] },
      [`POST /api/chat/conversations/${CONV}/messages`]: () => hanging.response,
    })
    await typeAndSend('Go on')
    await waitFor(() => expect(screen.getByText('Partial')).toBeInTheDocument())
    fireEvent.click(await screen.findByRole('button', { name: /Stop/ }))
    expect(await screen.findByRole('button', { name: /Send/ })).toBeInTheDocument()
    // No error surfaced for a deliberate stop
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the configure CTA to an admin when the send answers 503 ai_not_configured', async () => {
    mount({
      [`/api/chat/conversations/${CONV}`]: { ...conversation, messages: [] },
      [`POST /api/chat/conversations/${CONV}/messages`]: () =>
        errorResponse(503, 'No chat provider is configured', 'ai_not_configured'),
    })
    await typeAndSend('Anyone there?')
    const cta = await screen.findByRole('link', { name: 'Configure AI' })
    expect(cta).toHaveAttribute('href', '/settings?tab=ai')
    // The optimistic bubble was taken back: nothing was persisted
    expect(screen.queryByText('Anyone there?')).not.toBeInTheDocument()
  })

  it('tells a member to ask an admin when chat readiness is none', async () => {
    mount(
      {
        '/api/ai/config/readiness': {
          chat: { ready: false, source: 'none' },
          embeddings: { ready: false, source: 'none' },
        },
        [`/api/chat/conversations/${CONV}`]: { ...conversation, messages: [] },
      },
      makeSession({ tenant: makeTenant({ role: 'member' }) })
    )
    expect(await screen.findByText('AI is not configured')).toBeInTheDocument()
    expect(screen.getByText(/Ask an administrator/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Configure AI' })).not.toBeInTheDocument()
  })
})
