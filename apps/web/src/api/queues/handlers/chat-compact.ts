/**
 * `chat.compact` (D17) — fold the messages that no longer fit a conversation's context budget into
 * its rolling summary, so a long thread forgets gracefully instead of either overflowing the model
 * or silently losing its beginning.
 *
 * It is a JOB, not part of the turn, for one reason: a chat reply is the latency a person feels,
 * and compaction is a whole extra model call. The cost of that choice is honest and bounded — the
 * turn that FIRST crosses the budget answers without a summary, and says so with
 * `CUSTOM kit.notice { history_truncated }`. Every turn after it has one.
 *
 * The message carries ids only, so the handler recomputes the window from the database with the
 * same pure `selectHistoryWindow` the route used. That matters: by the time this runs, the turn
 * that enqueued it has usually persisted its answer, and summarising the window as it is NOW is
 * more correct than summarising the window as it was.
 *
 * Concurrency is a compare-and-set, not a lock: the write only lands while
 * `summarised_through_id` is still what this run read. Two overlapping jobs therefore produce one
 * summary and one no-op rather than a lost update, and the loser costs tokens, not correctness.
 */
import { CHAT_COMPACTION_MIN_CHARS, CHAT_SUMMARY_MAX_CHARS } from '@rocketflare/shared/ai/chat'
import type { JobOf } from '@rocketflare/shared/jobs'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { conversations, messages } from '../../../db/schema'
import { pendingCompaction, selectHistoryWindow } from '../../services/ai/chat-history'
import { AiNotConfiguredError } from '../../services/ai/errors'
import { callStructuredTool } from '../../services/ai/kit'
import { resolveChat } from '../../services/ai/resolve'
import { recordUsage } from '../../services/ai/usage'
import { resolvePrompt } from '../../services/prompts'
import type { JobContext } from '../jobs'

const SUBMIT_SUMMARY_TOOL = 'submit_summary'

const submitSummarySchema = z.object({
  summary: z
    .string()
    .trim()
    .min(1)
    .max(CHAT_SUMMARY_MAX_CHARS)
    .describe('The single replacement summary of everything so far'),
})

/** `role: text` — a transcript the model reads, not a conversation it continues. */
function transcript(rows: { role: string; content: string }[]): string {
  return rows.map(row => `${row.role}: ${row.content}`).join('\n\n')
}

export async function handleChatCompact(
  job: JobOf<'chat.compact'>,
  { db, env, config, logger }: JobContext
): Promise<void> {
  const { tenantId, conversationId } = job.payload
  const conversation = await db.query.conversations.findFirst({
    where: and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)),
  })
  // Deleted between enqueue and delivery: nothing to summarise, nothing wrong.
  if (!conversation) return

  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.tenantId, tenantId)))
    .orderBy(asc(messages.createdAt), asc(messages.id))

  const { dropped } = selectHistoryWindow(rows, { maxChars: config.CHAT_HISTORY_MAX_CHARS })
  const pending = pendingCompaction(dropped, conversation.summarisedThroughId)
  const pendingChars = pending.reduce((total, row) => total + row.content.length, 0)
  // The window slides by a message or two per turn, so this runs often. Spending a model call on
  // a sentence is how compaction becomes more expensive than the problem.
  if (pending.length === 0 || pendingChars < CHAT_COMPACTION_MIN_CHARS) return
  const through = pending[pending.length - 1]
  if (!through) return

  let resolved: Awaited<ReturnType<typeof resolveChat>>
  try {
    resolved = await resolveChat(db, config, env, tenantId, { promptKey: 'chat-compaction' })
  } catch (err) {
    // No provider: the thread still works, it just forgets. Never retry — nothing will change.
    if (err instanceof AiNotConfiguredError) {
      logger.warn({ conversationId }, 'chat.compact: no chat provider, skipping')
      return
    }
    throw err
  }

  const system = await resolvePrompt(db, tenantId, 'chat-compaction', {
    appName: config.APP_NAME,
    tenantName: '',
    maxChars: String(CHAT_SUMMARY_MAX_CHARS),
  })
  const previous = conversation.summary?.trim()
  const result = await callStructuredTool(resolved.client, {
    model: resolved.model,
    maxTokens: resolved.maxOutputTokens,
    system,
    messages: [
      {
        role: 'user',
        content: [
          previous ? `Summary so far:\n\n${previous}` : 'There is no summary yet.',
          `Messages to fold in:\n\n${transcript(pending)}`,
        ].join('\n\n---\n\n'),
      },
    ],
    tool: {
      name: SUBMIT_SUMMARY_TOOL,
      description: 'Submit the single replacement summary. Call exactly once.',
      schema: submitSummarySchema,
    },
    onUsage: usage =>
      void recordUsage(db, {
        tenantId,
        userId: conversation.userId,
        feature: 'chat:compaction',
        provider: resolved.provider,
        model: resolved.model,
        usage,
      }).catch(err => logger.warn({ err }, 'chat.compact: usage write failed')),
  })

  // Compare-and-set on what this run read: a concurrent job that already moved the watermark wins,
  // and this one is a no-op rather than a lost update.
  const updated = await db
    .update(conversations)
    .set({ summary: result.summary, summarisedThroughId: through.id })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.tenantId, tenantId),
        conversation.summarisedThroughId === null
          ? isNull(conversations.summarisedThroughId)
          : eq(conversations.summarisedThroughId, conversation.summarisedThroughId)
      )
    )
    .returning({ id: conversations.id })
  if (updated.length === 0) {
    logger.info({ conversationId }, 'chat.compact: another run compacted first, discarding')
    return
  }
  logger.info(
    { conversationId, folded: pending.length, chars: result.summary.length },
    'chat.compact: summary updated'
  )
}
