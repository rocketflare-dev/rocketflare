/**
 * The history window and the compaction watermark (D17) — pure, so the `config` project, no
 * database. These two functions are the reason a long thread degrades predictably instead of
 * either overflowing the model or losing its beginning without saying so, and the route and the
 * `chat.compact` job both call them, which is what keeps their idea of "the window" identical.
 */
import { CHAT_HISTORY_MAX_MESSAGES } from '@rocketflare/shared/ai/chat'
import { describe, expect, it } from 'vitest'
import { pendingCompaction, selectHistoryWindow, withSummary } from '@/api/services/ai/chat-history'
import type { MessageRow } from '@/db/schema'

const row = (id: string, content: string, role: MessageRow['role'] = 'user'): MessageRow =>
  ({ id, role, content }) as MessageRow

/** `n` messages of `chars` characters each, oldest first. */
const thread = (n: number, chars = 10): MessageRow[] =>
  Array.from({ length: n }, (_, i) =>
    row(`m${i}`, 'x'.repeat(chars), i % 2 === 0 ? 'user' : 'assistant')
  )

describe('selectHistoryWindow', () => {
  it('keeps the newest messages that fit the character budget', () => {
    const rows = thread(10, 100)
    const { window, dropped } = selectHistoryWindow(rows, { maxChars: 350 })
    // 3 × 100 fits, a 4th would be 400.
    expect(window.map(r => r.id)).toEqual(['m7', 'm8', 'm9'])
    expect(dropped.map(r => r.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'])
  })

  it('keeps everything when the thread fits, and drops nothing', () => {
    const rows = thread(5, 10)
    const { window, dropped } = selectHistoryWindow(rows, { maxChars: 10_000 })
    expect(window).toHaveLength(5)
    expect(dropped).toEqual([])
  })

  it('applies the message count as a backstop', () => {
    const rows = thread(CHAT_HISTORY_MAX_MESSAGES + 5, 1)
    const { window, dropped } = selectHistoryWindow(rows, { maxChars: 10_000 })
    expect(window).toHaveLength(CHAT_HISTORY_MAX_MESSAGES)
    expect(dropped).toHaveLength(5)
  })

  it('still sends one oversized message rather than no conversation at all', () => {
    // A single turn bigger than the whole budget: the provider complaining is more use to a
    // person than the model being handed an empty history and answering from nothing.
    const rows = [row('a', 'x'.repeat(5_000))]
    const { window, dropped } = selectHistoryWindow(rows, { maxChars: 100 })
    expect(window.map(r => r.id)).toEqual(['a'])
    expect(dropped).toEqual([])
  })

  it('ignores roles that are never replayed', () => {
    const rows = [row('t', 'tool output', 'tool'), row('u', 'hello')]
    const { window, dropped } = selectHistoryWindow(rows, { maxChars: 10_000 })
    expect(window.map(r => r.id)).toEqual(['u'])
    expect(dropped).toEqual([])
  })

  it('is empty-safe', () => {
    expect(selectHistoryWindow([], { maxChars: 100 })).toEqual({ window: [], dropped: [] })
  })
})

describe('pendingCompaction', () => {
  const dropped = [row('a', 'a'), row('b', 'b'), row('c', 'c')]

  it('is everything dropped when nothing has been summarised', () => {
    expect(pendingCompaction(dropped, null).map(r => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('is what came after the watermark', () => {
    expect(pendingCompaction(dropped, 'a').map(r => r.id)).toEqual(['b', 'c'])
    expect(pendingCompaction(dropped, 'c')).toEqual([])
  })

  it('re-summarises everything when the watermark is no longer in the thread', () => {
    // A deleted message, or a summary rebuilt from scratch: wasteful once, never wrong.
    expect(pendingCompaction(dropped, 'gone').map(r => r.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('withSummary', () => {
  it('puts the summary in the volatile half, leaving the cacheable prefix alone', () => {
    const system = withSummary('You are an assistant.', 'User wants zero downtime.')
    expect(system).toEqual({
      stable: 'You are an assistant.',
      volatile: expect.stringContaining('User wants zero downtime.'),
    })
  })

  it('appends to an existing volatile half and is a no-op without a summary', () => {
    expect(withSummary({ stable: 's', volatile: 'v' }, 'note')).toEqual({
      stable: 's',
      volatile: expect.stringMatching(/^v\n\n/),
    })
    expect(withSummary('s', null)).toBe('s')
    expect(withSummary('s', '   ')).toBe('s')
  })
})
