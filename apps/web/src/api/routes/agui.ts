/**
 * `POST /api/agui/run` — the AG-UI `RunAgentInput` endpoint, so a client that speaks the protocol
 * can drive this app without knowing anything about `/api/chat`. It is a thin wrapper: it
 * reconciles the input against the stored conversation, then calls the SAME `streamChatTurn` the
 * chat route calls. There is exactly one implementation of the event sequence.
 *
 * **Auth is the kit's, unchanged.** `authMiddleware` takes a session cookie or a tenant API key as
 * Bearer, and `csrf.ts` already exempts Bearer requests; a cross-origin browser client needs its
 * origin in the CORS allow-list, which is configuration, not code. **Conversation ownership is the
 * `userId` filter**, so every thread an API key touches belongs to the user who created that key —
 * a key is not a shared mailbox.
 *
 * ## The reconciliation rule: the server is the transcript, the client supplies only the tail
 *
 * 1. `threadId` is a conversation id. Unknown → it is **adopted**: a conversation is created with
 *    that id, after the client resolves, so a 503 lands before any row exists. That is what lets a
 *    stateless client invent a `threadId` and have it work. An id that exists but is not this
 *    user's collides on the primary key → 404 `agui_thread_not_found`.
 * 2. The LAST message is the new user turn; **every earlier message is ignored**. The history the
 *    model sees comes from the database, exactly as it does for `/api/chat`.
 * 3. A last message whose UUID `id` already exists in this conversation is not re-inserted: the run
 *    replays against the existing row, so a client retry is safe (no transaction spans a stream).
 * 4. `MESSAGES_SNAPSHOT` goes out right after `RUN_STARTED`, carrying the server's transcript. That
 *    is the honest answer to divergence — the client is told in-band what the server believes.
 *
 * Known limits, written down rather than half-fixed: a client that edits or branches history gets
 * the server's history (branching needs a real thread model and is out of scope); two concurrent
 * runs on one `threadId` interleave (the fix is an `agent_runs`-style claim row, never a `Map`);
 * the client's `runId` is echoed but neither stored nor deduplicated on; adopting a thread lets
 * someone create an empty conversation in their OWN tenant, which is harmless.
 *
 * **Inbound `tools[]` is refused** with 400 `agui_client_tools_unsupported` rather than ignored: a
 * client waiting for a call that can never come is worse than an error. Frontend tools need the
 * loop to suspend mid-turn and resume on a later `RunAgentInput`, and `runStreamingChat` has no
 * durable suspend point. The agent runtime already has that machinery (`agent_runs.checkpoint`), so
 * the shape of v2 is "reuse the checkpoint column on `conversations`". Inbound `state` is ignored;
 * outbound state is one read-only `STATE_SNAPSHOT`, never a `STATE_DELTA`.
 */
import {
  AguiEventType,
  type KitAguiEvent,
  kitRunAgentInputSchema,
  readRunAgentTail,
} from '@rocketflare/shared/ai/agui'
import { ERROR_CODES } from '@rocketflare/shared/errors'
import { and, desc, eq } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { type ConversationRow, conversations, type MessageRow, messages } from '../../db/schema'
import { guardPermission } from '../middleware/permissions'
import { HISTORY_LIMIT, prepareChatTurn, streamChatTurn } from '../services/ai/chat-turn'
import { resolveChat } from '../services/ai/resolve'
import { BadRequestError, isUniqueViolation, NotFoundError } from '../utils/core/errors'
import { withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const aguiRouter = createRouter()

/** One sentence per refusal — a client reads these, not the code. */
const TAIL_ERRORS: Record<string, string> = {
  agui_client_tools_unsupported:
    'This server does not run client-side tools; send `tools: []` and let the server call its own.',
  agui_last_message_not_user: 'The last message must be a user turn — the server owns the history.',
  agui_unsupported_content: 'The user turn must be a non-empty string within the length limit.',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The thread, adopting the id when it is free in this tenant. */
async function resolveThread(
  db: Database,
  tenantId: string,
  userId: string,
  threadId: string,
  provider: ConversationRow['provider'],
  model: string
): Promise<ConversationRow> {
  const existing = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.id, threadId),
      eq(conversations.tenantId, tenantId),
      eq(conversations.userId, userId)
    ),
  })
  if (existing) return existing
  try {
    const [row] = await db
      .insert(conversations)
      .values({ id: threadId, tenantId, userId, title: 'New conversation', provider, model })
      .returning()
    if (!row) throw new Error('conversations: insert returned no row')
    return row
  } catch (err) {
    if (isUniqueViolation(err)) {
      // The id exists in another tenant or for another user. Saying which would leak it.
      throw new NotFoundError('Thread not found', ERROR_CODES.aguiThreadNotFound)
    }
    throw err
  }
}

/** The server's transcript, as AG-UI messages — what `MESSAGES_SNAPSHOT` carries. */
function messagesSnapshot(rows: MessageRow[]): KitAguiEvent {
  return {
    type: AguiEventType.MESSAGES_SNAPSHOT,
    messages: rows
      .filter(row => row.role === 'user' || row.role === 'assistant')
      .map(row => ({ id: row.id, role: row.role as 'user' | 'assistant', content: row.content })),
  }
}

aguiRouter.post('/run', validate('json', kitRunAgentInputSchema), async c => {
  const { db, tenantId, user, cfg } = withAuthAndDb(c)
  guardPermission(c, 'update', 'Conversation')
  const input = c.req.valid('json')

  const tail = readRunAgentTail(input)
  if (!tail.ok) throw new BadRequestError(TAIL_ERRORS[tail.code], tail.code)

  // Resolve once, before any row: a tenant with no provider gets the 503 envelope, and the
  // adopted conversation freezes the same provider/model a `/api/chat` thread would.
  const resolved = await resolveChat(db, cfg, c.env, tenantId, { promptKey: 'chat' })
  const conversation = await resolveThread(
    db,
    tenantId,
    user.id,
    input.threadId,
    resolved.provider,
    resolved.model
  )

  // A replayed message id is the same turn, not a new one (there is no transaction around a
  // stream, so a client retry has to be safe).
  const replayed = UUID_RE.test(tail.id)
    ? await db.query.messages.findFirst({
        where: and(
          eq(messages.id, tail.id),
          eq(messages.conversationId, conversation.id),
          eq(messages.tenantId, tenantId)
        ),
      })
    : undefined

  const params = await prepareChatTurn(c, conversation, tail.content, {
    resolved,
    userMessage: replayed,
    ...(UUID_RE.test(tail.id) ? { userMessageId: tail.id } : {}),
    runId: input.runId,
  })

  const transcript = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversation.id), eq(messages.tenantId, tenantId)))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(HISTORY_LIMIT)
  return streamChatTurn(c, {
    ...params,
    lead: [messagesSnapshot(transcript.reverse())],
  })
})
