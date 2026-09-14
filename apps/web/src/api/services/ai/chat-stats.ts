/**
 * What is actually going on behind a chat thread (D17) — the data the chat inspector renders.
 *
 * Everything here is DERIVED: from the stored rows, the live config and the shared price table.
 * Nothing is cached and nothing is written, so there is no second source of truth to drift from the
 * transcript, and a thread that predates a column simply reports less rather than reporting wrong.
 *
 * Two things it deliberately does NOT do. It never calls a model — "what will answer next" comes
 * from `readiness()`, which mirrors the resolver's order without building a client, so opening the
 * panel costs a couple of queries and no tokens. And it never guesses a price: a model the table
 * does not know contributes `null` and is counted in `unpricedTurns`, exactly as the Usage page
 * does, because a total that quietly omits half a thread is worse than one that says so.
 */
import {
  CHAT_COMPACTION_MIN_CHARS,
  CHAT_MAX_TOOL_TURNS,
  CHAT_SUMMARY_MAX_CHARS,
  type ConversationModelUsage,
  type ConversationStats,
  type TokenUsage,
} from '@rocketflare/shared/ai/chat'
import type { AiProvider } from '@rocketflare/shared/ai/config'
import { estimateCostMicrocents } from '@rocketflare/shared/ai/pricing'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import type { ConversationRow, MessageRow } from '../../../db/schema'
import { fullAccessScope } from '../access'
import { buildAgentTools } from '../agents/tools'
import { resolvePrompt } from '../prompts'
import { pendingCompaction, selectHistoryWindow, withSummary } from './chat-history'
import { CHARS_PER_TOKEN } from './chunking'
import { toToolDefinition } from './kit'
import { readiness } from './resolve'
import type { AiEnv, SystemPrompt } from './types'

const ZERO: TokenUsage = { inputTokens: 0, outputTokens: 0 }

function addUsage(a: TokenUsage, b: TokenUsage | null | undefined): TokenUsage {
  if (!b) return a
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  }
}

function systemPromptChars(system: SystemPrompt): number {
  if (typeof system === 'string') return system.length
  return system.stable.length + (system.volatile?.length ?? 0)
}

/**
 * Group the assistant turns by the model that produced them. `provider`/`model` are null for a turn
 * written before those columns existed; those group together and are reported as unknown rather
 * than folded into the current model, which would price them at a rate they never paid.
 */
export function summariseByModel(rows: readonly MessageRow[]): ConversationModelUsage[] {
  const groups = new Map<string, ConversationModelUsage>()
  for (const row of rows) {
    if (row.role !== 'assistant') continue
    const provider = (row.provider ?? null) as AiProvider | null
    const model = row.model ?? null
    const key = `${provider ?? '?'}::${model ?? '?'}`
    const current = groups.get(key) ?? {
      provider,
      model,
      turns: 0,
      usage: ZERO,
      costMicrocents: null,
    }
    current.turns += 1
    current.usage = addUsage(current.usage, row.usage)
    groups.set(key, current)
  }
  for (const group of groups.values()) {
    group.costMicrocents =
      group.provider && group.model
        ? estimateCostMicrocents(group.provider, group.model, group.usage)
        : null
  }
  return [...groups.values()].sort((a, b) => b.turns - a.turns)
}

export interface ConversationStatsInput {
  conversation: ConversationRow
  /** Every row of the thread, oldest → newest. */
  rows: readonly MessageRow[]
  tenantName: string
  userName: string
}

export async function buildConversationStats(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  tenantId: string,
  input: ConversationStatsInput
): Promise<ConversationStats> {
  const { conversation, rows } = input
  const ready = await readiness(db, cfg, env, tenantId)
  const chat = ready.chat

  // The same pure window the route and the compaction job use, so the panel cannot claim a
  // different history from the one the next turn will actually send.
  const { window, dropped } = selectHistoryWindow(rows, { maxChars: cfg.CHAT_HISTORY_MAX_CHARS })
  const prompt = await resolvePrompt(db, tenantId, 'chat', {
    appName: cfg.APP_NAME,
    tenantName: input.tenantName,
    userName: input.userName,
  })

  // The same predicate the compaction job applies, so "pending" here means exactly what makes that
  // job do work: the dropped prefix the existing summary does not already cover.
  const pending = pendingCompaction(dropped, conversation.summarisedThroughId)

  const byModel = summariseByModel(rows)
  const usage = byModel.reduce((acc, group) => addUsage(acc, group.usage), ZERO)
  const priced = byModel.filter(g => g.costMicrocents !== null)
  const costMicrocents = priced.length
    ? priced.reduce((sum, g) => sum + (g.costMicrocents ?? 0), 0)
    : null
  const unpricedTurns = byModel
    .filter(g => g.costMicrocents === null)
    .reduce((sum, g) => sum + g.turns, 0)

  // Built exactly as the next turn would build them, so their schemas can be measured rather than
  // estimated — they are re-sent on every turn and are routinely larger than the question.
  // Only their SCHEMAS are measured here, so a full-access scope is right: the panel reports what
  // the next turn will send, and the tool definitions do not vary by reader.
  const tools = cfg.CHAT_KNOWLEDGE_TOOLS
    ? buildAgentTools({ db, cfg, env, scope: fullAccessScope(tenantId) })
    : []
  const knowledgeTools = tools.map(t => t.name)
  const toolSchemaChars = tools.reduce(
    (n, tool) => n + JSON.stringify(toToolDefinition(tool)).length,
    0
  )

  // `withSummary` wraps the summary in a preamble, and that preamble is sent too, so the delta is
  // the honest cost of having a summary rather than the raw summary length.
  const promptChars = systemPromptChars(prompt)
  const withSummaryChars = systemPromptChars(withSummary(prompt, conversation.summary))
  const composition = {
    systemPrompt: promptChars,
    summary: withSummaryChars - promptChars,
    toolSchemas: toolSchemaChars,
    userMessages: window.filter(m => m.role === 'user').reduce((n, m) => n + m.content.length, 0),
    assistantMessages: window
      .filter(m => m.role === 'assistant')
      .reduce((n, m) => n + m.content.length, 0),
  }

  return {
    conversationId: conversation.id,
    next: {
      ready: chat.ready,
      provider: chat.ready ? (chat.provider ?? null) : null,
      model: chat.ready ? (chat.model ?? null) : null,
      source: chat.source,
      maxOutputTokens: cfg.AGENT_MAX_OUTPUT_TOKENS,
      knowledgeTools,
      // The same cap the turn applies: the interactive ceiling, not the Workflow one.
      maxToolTurns:
        knowledgeTools.length > 0 ? Math.min(cfg.AGENT_MAX_TURNS, CHAT_MAX_TOOL_TURNS) : 0,
    },
    context: {
      budgetChars: cfg.CHAT_HISTORY_MAX_CHARS,
      windowChars: window.reduce((n, m) => n + m.content.length, 0),
      windowMessages: window.length,
      droppedMessages: dropped.length,
      droppedChars: dropped.reduce((n, m) => n + m.content.length, 0),
      headroomChars: Math.max(
        cfg.CHAT_HISTORY_MAX_CHARS - window.reduce((n, m) => n + m.content.length, 0),
        0
      ),
      composition,
      totalChars: Object.values(composition).reduce((a, b) => a + b, 0),
      charsPerToken: CHARS_PER_TOKEN,
    },
    compaction: {
      summary: conversation.summary,
      summarisedThroughId: conversation.summarisedThroughId,
      pendingMessages: pending.length,
      pendingChars: pending.reduce((n, m) => n + m.content.length, 0),
      minChars: CHAT_COMPACTION_MIN_CHARS,
      maxSummaryChars: CHAT_SUMMARY_MAX_CHARS,
      summarisedMessages: dropped.length - pending.length,
    },
    turns: {
      user: rows.filter(r => r.role === 'user').length,
      assistant: rows.filter(r => r.role === 'assistant').length,
      toolCalls: rows.reduce((n, r) => n + (r.toolCalls?.length ?? 0), 0),
    },
    usage,
    costMicrocents,
    unpricedTurns,
    byModel,
  }
}
