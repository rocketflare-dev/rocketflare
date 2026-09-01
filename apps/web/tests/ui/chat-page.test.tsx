/**
 * `/chat/:conversationId` (D17): send → SSE frames → the assistant bubble accumulates deltas and
 * shows the usage footnote; Shift+Enter does not send; Stop aborts the stream; a 503
 * `ai_not_configured` renders the configure call to action (admins) or the "ask an admin" copy.
 */
import type { ChatStreamEvent, Message } from '@rocketflare/shared/ai/chat'
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
import { hangingSseResponse, sseResponse } from './helpers/sse'

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

const start: ChatStreamEvent = {
  type: 'message.start',
  conversationId: CONV,
  messageId: ASSISTANT_ID,
  userMessageId: USER_MSG_ID,
  model: 'claude-sonnet-4-5',
  provider: 'anthropic',
}
const delta = (text: string): ChatStreamEvent => ({ type: 'text.delta', delta: text })
const usage: ChatStreamEvent = { type: 'usage', usage: { inputTokens: 12, outputTokens: 5 } }
const end: ChatStreamEvent = { type: 'message.end', messageId: ASSISTANT_ID }

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
        return sseResponse([start, delta('Hel'), delta('lo'), usage, end])
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
    const hanging = hangingSseResponse([start, delta('Partial')])
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
