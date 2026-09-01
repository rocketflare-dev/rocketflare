/**
 * `/api/chat` (D17): persisted conversations + one SSE route. Ownership is the `userId` filter on
 * EVERY query (with the tenant predicate): another member's thread is a 404, admins included.
 *
 * `POST /conversations/:id/messages` resolves the client BEFORE the stream opens (a config error
 * is a JSON 503 `ai_not_configured`, not a broken stream), persists the user message, builds the
 * system prompt from the `chat` registry entry, streams `chatStreamEventSchema` frames, then —
 * still inside the stream, all awaited — persists the assistant message + usage, bumps
 * `lastMessageAt`, titles the thread from the first user message, and flushes the tracer.
 * Zero default tools: `runStreamingChat` receives none.
 */
import {
  type ChatStreamEvent,
  CONVERSATION_TITLE_LENGTH,
  type Conversation,
  type ConversationWithMessages,
  conversationListQuerySchema,
  createConversationRequestSchema,
  type Message,
  sendMessageRequestSchema,
} from '@gmgo/shared/ai/chat'
import { and, asc, count, desc, eq, sql } from 'drizzle-orm'
import { streamSSE } from 'hono/streaming'
import type { Database } from '../../db/client'
import { type ConversationRow, conversations, type MessageRow, messages } from '../../db/schema'
import { guardPermission } from '../middleware/permissions'
import { traceChatClient, withAgentTrace } from '../observability/tracing'
import { recordActivity } from '../services/activity'
import { AiError, describeAiError, normalizeAiError } from '../services/ai/errors'
import { runStreamingChat } from '../services/ai/kit'
import { resolveChat } from '../services/ai/resolve'
import type { ChatMessage } from '../services/ai/types'
import { recordUsage } from '../services/ai/usage'
import { resolvePrompt } from '../services/prompts'
import { NotFoundError } from '../utils/core/errors'
import { pageWindow, paginated } from '../utils/routes/pagination'
import { streamDatabase, uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const chatRouter = createRouter()

/** Longest history sent to the model (turns); older turns are dropped, the DB keeps everything. */
const HISTORY_LIMIT = 40

export function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    title: row.title,
    provider: row.provider,
    model: row.model,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastMessageAt: row.lastMessageAt,
  }
}

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    toolCalls: row.toolCalls,
    usage: row.usage,
    createdAt: row.createdAt,
  }
}

/** The ownership read: tenant AND user, or 404. */
async function ownConversation(
  db: Database,
  tenantId: string,
  userId: string,
  id: string
): Promise<ConversationRow> {
  const row = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.id, id),
      eq(conversations.tenantId, tenantId),
      eq(conversations.userId, userId)
    ),
  })
  if (!row) throw new NotFoundError('Conversation not found')
  return row
}

// ---- GET /api/chat/conversations -------------------------------------------------------------------

chatRouter.get('/conversations', validate('query', conversationListQuerySchema), async c => {
  const { db, tenantId, user } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Conversation')
  const query = c.req.valid('query')
  const { limit, offset } = pageWindow(query)
  const where = and(eq(conversations.tenantId, tenantId), eq(conversations.userId, user.id))
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(conversations)
      .where(where)
      .orderBy(sql`${conversations.lastMessageAt} DESC NULLS LAST`, desc(conversations.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(conversations).where(where),
  ])
  return c.json(paginated(rows.map(toConversation), total?.n ?? 0, query))
})

// ---- POST /api/chat/conversations ------------------------------------------------------------------

chatRouter.post('/conversations', validate('json', createConversationRequestSchema), async c => {
  const { db, tenantId, user, cfg, defer } = withAuthAndDb(c)
  guardPermission(c, 'create', 'Conversation')
  // Resolve first: a tenant with no provider gets the 503 here, not after a row exists.
  const resolved = await resolveChat(db, cfg, c.env, tenantId, { promptKey: 'chat' })
  const [row] = await db
    .insert(conversations)
    .values({
      tenantId,
      userId: user.id,
      title: c.req.valid('json').title ?? 'New conversation',
      provider: resolved.provider,
      model: resolved.model,
    })
    .returning()
  if (!row) throw new Error('conversations: insert returned no row')
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'conversation.created',
      subjectType: 'Conversation',
      subjectId: row.id,
      metadata: { provider: row.provider, model: row.model },
    })
  )
  return c.json(toConversation(row), 201)
})

// ---- GET /api/chat/conversations/:id ---------------------------------------------------------------

chatRouter.get('/conversations/:id', async c => {
  const { db, tenantId, user } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Conversation')
  const row = await ownConversation(db, tenantId, user.id, uuidParam(c, 'id'))
  const turns = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, row.id), eq(messages.tenantId, tenantId)))
    .orderBy(asc(messages.createdAt), asc(messages.id))
  const body: ConversationWithMessages = { ...toConversation(row), messages: turns.map(toMessage) }
  return c.json(body)
})

// ---- DELETE /api/chat/conversations/:id ------------------------------------------------------------

chatRouter.delete('/conversations/:id', async c => {
  const { db, tenantId, user } = withAuthAndDb(c)
  guardPermission(c, 'delete', 'Conversation')
  const row = await ownConversation(db, tenantId, user.id, uuidParam(c, 'id'))
  await db
    .delete(conversations)
    .where(and(eq(conversations.id, row.id), eq(conversations.tenantId, tenantId)))
  return c.body(null, 204)
})

// ---- POST /api/chat/conversations/:id/messages (SSE) -----------------------------------------------

chatRouter.post(
  '/conversations/:id/messages',
  validate('json', sendMessageRequestSchema),
  async c => {
    const { db, tenantId, user, cfg, auth, tracer, logger } = withAuthAndDb(c)
    guardPermission(c, 'update', 'Conversation')
    const conversation = await ownConversation(db, tenantId, user.id, uuidParam(c, 'id'))
    const { content } = c.req.valid('json')

    // Everything that can fail with a JSON error happens BEFORE the stream opens.
    const resolved = await resolveChat(db, cfg, c.env, tenantId, { promptKey: 'chat' })
    const system = await resolvePrompt(db, tenantId, 'chat', {
      appName: cfg.APP_NAME,
      tenantName: auth.tenant?.name ?? '',
      userName: user.name,
    })
    const history = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversation.id), eq(messages.tenantId, tenantId)))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(HISTORY_LIMIT)
    const isFirstUserTurn = !history.some(m => m.role === 'user')

    const [userMessage] = await db
      .insert(messages)
      .values({ conversationId: conversation.id, tenantId, role: 'user', content })
      .returning()
    if (!userMessage) throw new Error('messages: insert returned no row')

    const chatMessages: ChatMessage[] = [
      ...history
        .reverse()
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user', content },
    ]
    const assistantMessageId = crypto.randomUUID()

    return streamSSE(c, async stream => {
      const send = (event: ChatStreamEvent) =>
        stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
      // The request's `db` is closed in `waitUntil` once this Response is returned — before this
      // body runs — so the writes below use a stream-scoped client (see `streamDatabase`).
      const handle = streamDatabase(c)
      const sdb = handle.db
      const abort = new AbortController()
      stream.onAbort(() => abort.abort())
      await send({
        type: 'message.start',
        conversationId: conversation.id,
        messageId: assistantMessageId,
        userMessageId: userMessage.id,
        model: resolved.model,
        provider: resolved.provider,
      })
      try {
        const result = await withAgentTrace(
          'chat',
          {
            tracer,
            tenantId,
            userId: user.id,
            sessionId: conversation.id,
            tags: ['chat'],
            input: content,
          },
          trace => {
            const client = traceChatClient(
              resolved.client,
              trace,
              { provider: resolved.provider },
              tracer
            )
            return runStreamingChat(client, {
              model: resolved.model,
              maxTokens: resolved.maxOutputTokens,
              system,
              messages: chatMessages,
              maxTurns: cfg.AGENT_MAX_TURNS,
              signal: abort.signal,
              onDelta: text => send({ type: 'text.delta', delta: text }),
              onToolStart: call =>
                send({
                  type: 'tool.start',
                  toolUseId: call.toolUseId,
                  name: call.name,
                  input: call.input,
                }),
              onToolEnd: call =>
                send({
                  type: 'tool.end',
                  toolUseId: call.toolUseId,
                  name: call.name,
                  isError: call.isError,
                  result: call.result,
                }),
            })
          }
        )

        // Persist BEFORE the closing frame — the client treats `message.end` as "it is saved".
        await sdb.insert(messages).values({
          id: assistantMessageId,
          conversationId: conversation.id,
          tenantId,
          role: 'assistant',
          content: result.text,
          toolCalls: result.toolCalls.length ? result.toolCalls : null,
          usage: result.usage,
        })
        const now = new Date()
        await sdb
          .update(conversations)
          .set({
            lastMessageAt: now,
            ...(isFirstUserTurn && conversation.title === 'New conversation'
              ? { title: content.slice(0, CONVERSATION_TITLE_LENGTH).trim() || conversation.title }
              : {}),
          })
          .where(and(eq(conversations.id, conversation.id), eq(conversations.tenantId, tenantId)))
        await recordUsage(sdb, {
          tenantId,
          userId: user.id,
          feature: 'chat',
          provider: resolved.provider,
          model: resolved.model,
          usage: result.usage,
        })
        await send({ type: 'usage', usage: result.usage })
        await send({ type: 'message.end', messageId: assistantMessageId })
      } catch (err) {
        const aiError = err instanceof AiError ? err : normalizeAiError(err, resolved.provider)
        logger.warn({ err: aiError, conversationId: conversation.id }, 'chat: stream failed')
        await send({ type: 'error', message: describeAiError(aiError), code: aiError.code }).catch(
          () => {}
        )
      } finally {
        await handle.close()
        await tracer.flush()
      }
    })
  }
)
