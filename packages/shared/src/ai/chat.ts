/**
 * Chat contracts (D17): the persisted `conversations` / `messages` rows and the request bodies.
 * The wire protocol the streaming route speaks is AG-UI and lives in `agui.ts`; this file is the
 * DB-shaped half — `tokenUsageSchema` and `toolCallRecordSchema` are jsonb column types as well as
 * response fields.
 */
import { z } from 'zod'
import { paginationQuerySchema } from '../pagination'
import { aiProviderSchema } from './config'

export const chatRoleSchema = z.enum(['user', 'assistant', 'system', 'tool'])
export type ChatRole = z.infer<typeof chatRoleSchema>

/** Provider-normalised token usage for one generation (cache fields only where the provider reports them). */
export const tokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
})
export type TokenUsage = z.infer<typeof tokenUsageSchema>

/** A tool call the assistant made in a turn, with the result the loop fed back (if any). */
export const toolCallRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
  result: z.string().optional(),
  isError: z.boolean().optional(),
})
export type ToolCallRecord = z.infer<typeof toolCallRecordSchema>

export const conversationSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  title: z.string(),
  provider: aiProviderSchema,
  model: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  lastMessageAt: z.coerce.date().nullable(),
})
export type Conversation = z.infer<typeof conversationSchema>

export const messageSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  role: chatRoleSchema,
  content: z.string(),
  toolCalls: z.array(toolCallRecordSchema).nullable().optional(),
  usage: tokenUsageSchema.nullable().optional(),
  /** What answered this turn. Null on a user row, and on assistant rows written before 0.2. */
  provider: aiProviderSchema.nullable().optional(),
  model: z.string().nullable().optional(),
  createdAt: z.coerce.date(),
})
export type Message = z.infer<typeof messageSchema>

export const conversationWithMessagesSchema = conversationSchema.extend({
  messages: z.array(messageSchema),
})
export type ConversationWithMessages = z.infer<typeof conversationWithMessagesSchema>

/** `POST /api/chat/conversations` — title is optional; the first user message titles it otherwise. */
export const createConversationRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
})
export type CreateConversationRequest = z.infer<typeof createConversationRequestSchema>

/** Longest user turn accepted (characters). */
export const MAX_MESSAGE_LENGTH = 32_000

export const sendMessageRequestSchema = z.object({
  content: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
})
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>

export const conversationListQuerySchema = paginationQuerySchema
export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>

/** Auto-title = first user message, trimmed to this many characters. */
export const CONVERSATION_TITLE_LENGTH = 60

/**
 * Model turns a chat reply may spend calling tools. Deliberately far below `AGENT_MAX_TURNS` (30):
 * that is a budget for a Workflow step with a ten-minute timeout, while a chat turn is interactive
 * and shares the Worker's CPU and subrequest budget with the request that opened it.
 */
export const CHAT_MAX_TOOL_TURNS = 6

/**
 * Hard backstop on how many stored messages a turn may replay. The REAL budget is a character one
 * (`CHAT_HISTORY_MAX_CHARS`, a `[vars]` knob, because the right value tracks the model's context
 * window and the tenant chooses the model): 40 messages of pasted documents is 1.28M characters at
 * the per-message cap, which no model accepts. This count only stops an absurd number of tiny
 * messages; it is not what keeps a thread inside its window.
 */
export const CHAT_HISTORY_MAX_MESSAGES = 40

/**
 * The rolling summary of everything trimmed out of the window (`conversations.summary`). Bounded
 * because it is prepended to EVERY subsequent turn: an unbounded summary is just a slower version
 * of the problem it solves.
 */
export const CHAT_SUMMARY_MAX_CHARS = 2_000

/**
 * Don't spend a model call summarising less than this much dropped text. Compaction folds the
 * previous summary in, so it runs repeatedly over a long thread; this is what stops it running on
 * every single turn once the window is full.
 */
export const CHAT_COMPACTION_MIN_CHARS = 2_000

// ---- Conversation stats (the chat inspector) -------------------------------------------------
//
// `GET /api/chat/conversations/:id/stats`, admin+ (`manage AiConfig`) on top of the same ownership
// filter as the thread itself. It answers "what is actually going on behind this chat": which model
// will answer next and which have answered, how much of the history budget the next turn will
// spend, what fell out of it, and what the thread has cost. Everything here is DERIVED — from the
// stored rows, the config and the price table — so it is safe to recompute per request and there is
// no state to keep in step.

/** One model's share of a thread. A thread is not pinned to a model, so there may be several. */
export const conversationModelUsageSchema = z.object({
  provider: aiProviderSchema.nullable(),
  model: z.string().nullable(),
  turns: z.number().int().nonnegative(),
  usage: tokenUsageSchema,
  /** Null when the price table does not know the model — never a guess. */
  costMicrocents: z.number().nullable(),
})
export type ConversationModelUsage = z.infer<typeof conversationModelUsageSchema>

/**
 * What the NEXT turn will send: the window that fits the character budget, and the older prefix
 * that does not. `summarisedChars` is the part of that prefix already folded into the summary.
 */
export const conversationContextStatsSchema = z.object({
  budgetChars: z.number().int().nonnegative(),
  windowChars: z.number().int().nonnegative(),
  windowMessages: z.number().int().nonnegative(),
  droppedMessages: z.number().int().nonnegative(),
  droppedChars: z.number().int().nonnegative(),
  /**
   * Characters that still fit before the OLDEST turns start falling out of the window. Zero means
   * the thread is already trimming — this is the honest answer to "how close am I?", and it moves
   * with what you type, not with a message count.
   */
  headroomChars: z.number().int().nonnegative(),
  /**
   * Where the next turn's prompt actually goes, in characters. These five are disjoint and sum to
   * `totalChars` — the point of the panel is that "my context is full" usually has a cause, and it
   * is often not the conversation: three tool schemas and a system prompt are sent on EVERY turn
   * whether or not they are used.
   */
  composition: z.object({
    /** The `chat` prompt — the cacheable, stable half. */
    systemPrompt: z.number().int().nonnegative(),
    /** The rolling summary, replayed as the system prompt's volatile half. 0 when there is none. */
    summary: z.number().int().nonnegative(),
    /** The JSON Schemas of the knowledge tools, re-sent every turn. 0 when tools are off. */
    toolSchemas: z.number().int().nonnegative(),
    userMessages: z.number().int().nonnegative(),
    assistantMessages: z.number().int().nonnegative(),
  }),
  /** Everything the next turn sends, summary and tool schemas included — not just the transcript. */
  totalChars: z.number().int().nonnegative(),
  /** Characters per token the kit assumes everywhere — the estimate's denominator, stated. */
  charsPerToken: z.number().int().positive(),
})
export type ConversationContextStats = z.infer<typeof conversationContextStatsSchema>

/** The rolling summary and how far it reaches — the visible half of "has this compacted?". */
export const conversationCompactionStatsSchema = z.object({
  summary: z.string().nullable(),
  summarisedThroughId: z.string().uuid().nullable(),
  /** Messages outside the window that the summary does NOT yet cover (a job is owed, or running). */
  pendingMessages: z.number().int().nonnegative(),
  /**
   * Characters of that uncovered material. The summariser is a model call, so it deliberately
   * waits until there is at least `minChars` of it — `minChars - pendingChars` is how far the
   * thread is from its NEXT summary, once it has started trimming at all.
   */
  pendingChars: z.number().int().nonnegative(),
  minChars: z.number().int().nonnegative(),
  maxSummaryChars: z.number().int().nonnegative(),
  /** Messages the existing summary covers, or 0 when there is none. */
  summarisedMessages: z.number().int().nonnegative(),
})
export type ConversationCompactionStats = z.infer<typeof conversationCompactionStatsSchema>

export const conversationStatsSchema = z.object({
  conversationId: z.string().uuid(),
  /** What will answer the NEXT turn, re-resolved now — not what the row was created with. */
  next: z.object({
    ready: z.boolean(),
    provider: aiProviderSchema.nullable(),
    model: z.string().nullable(),
    source: z.enum(['agent', 'tenant', 'platform', 'none']),
    maxOutputTokens: z.number().int().positive().nullable(),
    knowledgeTools: z.array(z.string()),
    maxToolTurns: z.number().int().nonnegative(),
  }),
  context: conversationContextStatsSchema,
  compaction: conversationCompactionStatsSchema,
  turns: z.object({
    user: z.number().int().nonnegative(),
    assistant: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
  }),
  usage: tokenUsageSchema,
  /** Summed from what IS priced; `unpricedTurns` says how much of the thread it leaves out. */
  costMicrocents: z.number().nullable(),
  unpricedTurns: z.number().int().nonnegative(),
  byModel: z.array(conversationModelUsageSchema),
})
export type ConversationStats = z.infer<typeof conversationStatsSchema>

/** `POST /api/chat/conversations/:id/compact` — what was queued, so the panel can say so. */
export const compactConversationResponseSchema = z.object({
  conversationId: z.string().uuid(),
  pendingMessages: z.number().int().positive(),
  pendingChars: z.number().int().nonnegative(),
})
export type CompactConversationResponse = z.infer<typeof compactConversationResponseSchema>
