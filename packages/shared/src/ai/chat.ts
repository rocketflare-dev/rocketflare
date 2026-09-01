/**
 * Chat contracts (D17): persisted `conversations` / `messages` rows, the request bodies, and the
 * SSE frame protocol `POST /api/chat/conversations/:id/messages` streams. Every frame's `data` is
 * one JSON `ChatStreamEvent` (discriminated on `type`); the SSE `event:` field repeats `type` for
 * `EventSource` consumers. The UI parses `data` with `chatStreamEventSchema.safeParse`.
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

// ---- SSE protocol -------------------------------------------------------------------------

export const chatStreamEventSchema = z.discriminatedUnion('type', [
  /** First frame: the persisted user message id and the assistant message id being written. */
  z.object({
    type: z.literal('message.start'),
    conversationId: z.string().uuid(),
    messageId: z.string().uuid(),
    userMessageId: z.string().uuid(),
    model: z.string(),
    provider: aiProviderSchema,
  }),
  z.object({ type: z.literal('text.delta'), delta: z.string() }),
  z.object({
    type: z.literal('tool.start'),
    toolUseId: z.string(),
    name: z.string(),
    input: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('tool.end'),
    toolUseId: z.string(),
    name: z.string(),
    isError: z.boolean(),
    result: z.string().optional(),
  }),
  z.object({ type: z.literal('usage'), usage: tokenUsageSchema }),
  /** Last frame on success — the assistant message is persisted when this arrives. */
  z.object({ type: z.literal('message.end'), messageId: z.string().uuid() }),
  /** Last frame on failure; nothing after it. `code` is an `AiErrorCode` or `internal`. */
  z.object({ type: z.literal('error'), message: z.string(), code: z.string() }),
])
export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>
export type ChatStreamEventType = ChatStreamEvent['type']
