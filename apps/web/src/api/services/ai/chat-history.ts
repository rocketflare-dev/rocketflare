/**
 * How much of a thread a turn replays, and what happens to the rest (D17).
 *
 * A chat turn cannot resend the whole conversation forever, and a message COUNT is the wrong
 * control: what overflows is the model's context window, which is characters. At the per-message
 * cap (`MAX_MESSAGE_LENGTH`, 32 000) forty stored messages is 1.28M characters — more than any
 * model the kit supports — so a count-only limit produces a thread that fails on every turn with
 * no way out but starting again. The budget here is `CHAT_HISTORY_MAX_CHARS` (a `[vars]` knob,
 * because the right value tracks the model the tenant chose), with the count kept as a backstop.
 *
 * What falls outside the window is **not** silently forgotten: it is folded into
 * `conversations.summary` by the `chat.compact` job and prepended to later turns as the system
 * prompt's `volatile` half — which is also exactly where prompt caching wants it, since the
 * cacheable prefix is `stable` and the summary changes underneath it.
 *
 * Everything here is pure, so the route and the compaction job agree on the window by construction
 * rather than by two implementations that drift.
 */
import { CHAT_HISTORY_MAX_MESSAGES } from '@rocketflare/shared/ai/chat'
import type { MessageRow } from '../../../db/schema'
import type { SystemPrompt } from './types'

/** Rows the model sees for a role. Tool rows are not replayed (see `chat-turn.ts`). */
const REPLAYABLE = new Set(['user', 'assistant'])

export interface HistoryWindow {
  /** Oldest → newest: what this turn replays. */
  window: MessageRow[]
  /** Oldest → newest: what did not fit and belongs to the summary. */
  dropped: MessageRow[]
}

export interface HistoryBudget {
  maxChars: number
  maxMessages?: number
}

/**
 * Split a thread into the tail that fits the budget and the prefix that does not, newest-first —
 * the most recent turns are the ones worth the context.
 *
 * `rows` must be oldest → newest. A single message larger than the whole budget still comes back in
 * the window when it is the only candidate: sending one oversized turn and letting the provider
 * complain is more useful than sending the model no conversation at all.
 */
export function selectHistoryWindow(
  rows: readonly MessageRow[],
  { maxChars, maxMessages = CHAT_HISTORY_MAX_MESSAGES }: HistoryBudget
): HistoryWindow {
  const replayable = rows.filter(row => REPLAYABLE.has(row.role))
  const window: MessageRow[] = []
  let chars = 0
  for (let i = replayable.length - 1; i >= 0; i--) {
    const row = replayable[i] as MessageRow
    const next = chars + row.content.length
    const fits = next <= maxChars && window.length < maxMessages
    if (!fits && window.length > 0) break
    window.unshift(row)
    chars = next
    if (!fits) break
  }
  const oldestKept = window[0]
  const cut = oldestKept ? replayable.indexOf(oldestKept) : replayable.length
  return { window, dropped: replayable.slice(0, cut) }
}

/**
 * The messages a compaction run still owes a summary for: everything dropped that the existing
 * summary does not already cover. `summarisedThroughId` is a message id, so an id that is no longer
 * in the thread (deleted, or from a rebuilt summary) reads as "covers nothing" and the whole prefix
 * is summarised again — wasteful once, never wrong.
 */
export function pendingCompaction(
  dropped: readonly MessageRow[],
  summarisedThroughId: string | null
): MessageRow[] {
  if (!summarisedThroughId) return [...dropped]
  const covered = dropped.findIndex(row => row.id === summarisedThroughId)
  return covered === -1 ? [...dropped] : dropped.slice(covered + 1)
}

/**
 * Put the summary in the system prompt's `volatile` half. `cachedSystem` closes the cacheable
 * prefix after `stable`, so a summary that changes every few turns never invalidates the prompt
 * everything else shares.
 */
export function withSummary(system: SystemPrompt, summary: string | null): SystemPrompt {
  if (!summary?.trim()) return system
  const preamble = `Earlier in this conversation (summarised, because the full text no longer fits):\n\n${summary.trim()}`
  if (typeof system === 'string') return { stable: system, volatile: preamble }
  return {
    stable: system.stable,
    volatile: system.volatile?.trim() ? `${system.volatile}\n\n${preamble}` : preamble,
  }
}
