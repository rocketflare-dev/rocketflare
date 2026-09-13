/**
 * `/api/chat` (D17): persisted conversations + one streaming route. Ownership is the `userId`
 * filter on EVERY query (with the tenant predicate): another member's thread is a 404, admins
 * included.
 *
 * `POST /conversations/:id/messages` is a thin wrapper: `prepareChatTurn` does everything that can
 * fail as a JSON envelope (resolve the client — a 503 `ai_not_configured` arrives before any row
 * exists — build the prompt, read the history, persist the user turn), then `streamChatTurn`
 * streams the answer in **AG-UI** (`services/ai/chat-turn.ts`, the one implementation the protocol
 * endpoint `POST /api/agui/run` also calls). Frames are spec AG-UI: `data: <json>` with no
 * `event:` line, or protobuf when the client negotiates it.
 */
import {
  type Conversation,
  type ConversationWithMessages,
  conversationListQuerySchema,
  createConversationRequestSchema,
  type Message,
  sendMessageRequestSchema,
} from '@rocketflare/shared/ai/chat'
import { and, asc, count, desc, eq, sql } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { type ConversationRow, conversations, type MessageRow, messages } from '../../db/schema'
import { guardPermission } from '../middleware/permissions'
import { recordActivity } from '../services/activity'
import { prepareChatTurn, streamChatTurn } from '../services/ai/chat-turn'
import { resolveChat } from '../services/ai/resolve'
import { NotFoundError } from '../utils/core/errors'
import { pageWindow, paginated } from '../utils/routes/pagination'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const chatRouter = createRouter()

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

// ---- POST /api/chat/conversations/:id/messages (AG-UI stream) -------------------------------------

chatRouter.post(
  '/conversations/:id/messages',
  validate('json', sendMessageRequestSchema),
  async c => {
    const { db, tenantId, user } = withAuthAndDb(c)
    guardPermission(c, 'update', 'Conversation')
    const conversation = await ownConversation(db, tenantId, user.id, uuidParam(c, 'id'))
    const { content } = c.req.valid('json')
    const params = await prepareChatTurn(c, conversation, content)
    return streamChatTurn(c, params)
  }
)
