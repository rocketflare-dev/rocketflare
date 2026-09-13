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
