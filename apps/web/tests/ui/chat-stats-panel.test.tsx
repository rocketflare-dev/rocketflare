/**
 * The chat inspector's UI contract: it says how far the thread is from forgetting something, it
 * shows the summary when there is one, and it only offers "Summarise now" when a summary is
 * actually owed. `compactionState` is the pure decision behind all three, so it is tested directly
 * rather than through six renders.
 */
import type {
  ConversationCompactionStats,
  ConversationContextStats,
} from '@rocketflare/shared/ai/chat'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatStatsPanel, compactionState } from '@/ui/pages/chat/ChatStatsPanel'
import { makeSession, renderWithProviders, stubFetch } from './helpers/renderWithProviders'

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111'

const context = (over: Partial<ConversationContextStats> = {}): ConversationContextStats => ({
  budgetChars: 24_000,
  windowChars: 1_000,
  windowMessages: 2,
  droppedMessages: 0,
  droppedChars: 0,
  headroomChars: 23_000,
  composition: {
    systemPrompt: 500,
    summary: 0,
    toolSchemas: 2_000,
    userMessages: 400,
    assistantMessages: 600,
  },
  totalChars: 3_500,
  charsPerToken: 4,
  ...over,
})

const compaction = (
  over: Partial<ConversationCompactionStats> = {}
): ConversationCompactionStats => ({
  summary: null,
  summarisedThroughId: null,
  pendingMessages: 0,
  pendingChars: 0,
  minChars: 2_000,
  maxSummaryChars: 2_000,
  summarisedMessages: 0,
  ...over,
})

const stats = (over: object = {}) => ({
  conversationId: CONVERSATION_ID,
  next: {
    ready: true,
    provider: 'workers_ai',
    model: '@cf/zai-org/glm-4.7-flash',
    source: 'platform',
    maxOutputTokens: 16_384,
    knowledgeTools: ['search_knowledge', 'get_document', 'list_documents'],
    maxToolTurns: 6,
  },
  context: context(),
  compaction: compaction(),
  turns: { user: 1, assistant: 1, toolCalls: 0 },
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
  costMicrocents: 1_000_000,
  unpricedTurns: 0,
  byModel: [],
  ...over,
})

describe('compactionState', () => {
  it('counts down to trimming first, then to the summary', () => {
    // Nothing dropped: the distance that matters is how much more history fits.
    const fresh = compactionState(context({ headroomChars: 23_000 }), compaction())
    expect(fresh.label).toBe('Nothing trimmed')
    expect(fresh.detail).toContain('23,000')

    // Dropping, but the summariser deliberately waits for 2 000 chars of material.
    const trimming = compactionState(
      context({ droppedMessages: 2, droppedChars: 500, headroomChars: 0 }),
      compaction({ pendingMessages: 2, pendingChars: 500 })
    )
    expect(trimming.tone).toBe('warn')
    expect(trimming.detail).toContain('1,500 to go')

    // Past the threshold: a job will run, so say that rather than a distance.
    const due = compactionState(
      context({ droppedMessages: 9, droppedChars: 9_000, headroomChars: 0 }),
      compaction({ pendingMessages: 9, pendingChars: 9_000 })
    )
    expect(due.tone).toBe('active')
    expect(due.label).toBe('Summary due')

    // Everything dropped is covered — the thread forgot on purpose and said so.
    const done = compactionState(
      context({ droppedMessages: 4, droppedChars: 8_000, headroomChars: 0 }),
      compaction({ summary: 'earlier…', pendingMessages: 0, summarisedMessages: 4 })
    )
    expect(done.label).toBe('Summarised')
  })
})

describe('ChatStatsPanel', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows the live model, the context budget and the cost', async () => {
    stubFetch({ [`/api/chat/conversations/${CONVERSATION_ID}/stats`]: stats() })
    renderWithProviders(<ChatStatsPanel conversationId={CONVERSATION_ID} onClose={() => {}} />, {
      session: makeSession(),
    })
    expect(await screen.findByText('@cf/zai-org/glm-4.7-flash')).toBeInTheDocument()
    expect(screen.getByText('1,000 / 24,000')).toBeInTheDocument()
    expect(screen.getByText('$0.01')).toBeInTheDocument()
    // Nothing is owed, so the trigger is not offered.
    expect(screen.queryByRole('button', { name: /Summarise now/ })).not.toBeInTheDocument()
  })

  it('renders the summary and triggers one when material is pending', async () => {
    const fetchMock = stubFetch({
      [`/api/chat/conversations/${CONVERSATION_ID}/stats`]: stats({
        context: context({ droppedMessages: 3, droppedChars: 9_000, headroomChars: 0 }),
        compaction: compaction({
          summary: 'They discussed onboarding.',
          pendingMessages: 3,
          pendingChars: 9_000,
          summarisedMessages: 1,
        }),
      }),
      [`POST /api/chat/conversations/${CONVERSATION_ID}/compact`]: {
        conversationId: CONVERSATION_ID,
        pendingMessages: 3,
        pendingChars: 9_000,
      },
    })
    renderWithProviders(<ChatStatsPanel conversationId={CONVERSATION_ID} onClose={() => {}} />, {
      session: makeSession(),
    })
    expect(await screen.findByText(/They discussed onboarding/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Summarise now/ }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          call =>
            String(call[0]).endsWith('/compact') && (call[1] as RequestInit)?.method === 'POST'
        )
      ).toBe(true)
    )
  })

  it('breaks the prompt down, so a full context has a visible cause', async () => {
    stubFetch({ [`/api/chat/conversations/${CONVERSATION_ID}/stats`]: stats() })
    renderWithProviders(<ChatStatsPanel conversationId={CONVERSATION_ID} onClose={() => {}} />, {
      session: makeSession(),
    })
    // Tool schemas are 2 000 of the 3 500 — sent every turn whatever was asked, which is the whole
    // reason the breakdown exists.
    expect(await screen.findByText('2,000 · 57%')).toBeInTheDocument()
    expect(screen.getByText('400 · 11%')).toBeInTheDocument()
    expect(screen.getByText('Tool schemas')).toBeInTheDocument()
  })

  it('says when part of the thread is not in the cost', async () => {
    stubFetch({
      [`/api/chat/conversations/${CONVERSATION_ID}/stats`]: stats({ unpricedTurns: 2 }),
    })
    renderWithProviders(<ChatStatsPanel conversationId={CONVERSATION_ID} onClose={() => {}} />, {
      session: makeSession(),
    })
    // A total that quietly omitted them would read as the whole thread's cost.
    expect(await screen.findByText(/not in that figure/)).toBeInTheDocument()
  })
})
