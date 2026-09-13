/**
 * ONE implementation of a streamed chat turn, in AG-UI. Both entry points call it —
 * `POST /api/chat/conversations/:id/messages` (the kit's own UI) and `POST /api/agui/run` (the
 * protocol endpoint) — so there is exactly one place the sequence below can drift.
 *
 * ```
 * RUN_STARTED
 *   → CUSTOM kit.chat.ids { conversationId, userMessageId, assistantMessageId, provider, model }
 *   → STATE_SNAPSHOT { conversationId, provider, model, tools[] }   [ → lead events ]
 *   → per model turn: TEXT_MESSAGE_START → CONTENT… → END
 *                     TOOL_CALL_START → TOOL_CALL_ARGS → TOOL_CALL_END → TOOL_CALL_RESULT
 *   -- persist the row, bump lastMessageAt, auto-title, recordUsage (all awaited, stream client) --
 *   → CUSTOM kit.usage → RUN_FINISHED { result: chatRunResult }
 * ```
 *
 * Two terminal conventions, both deliberate:
 *
 * - **Failure** closes any open text/tool message and emits `RUN_ERROR`. There is no `RUN_FINISHED`
 *   after it and nothing is persisted.
 * - **Cancellation emits nothing at all.** AG-UI 0.0.59 has no cancellation event, so the contract
 *   is: *a run whose body closes with neither `RUN_FINISHED` nor `RUN_ERROR` was cancelled by the
 *   client.* The abort is checked explicitly rather than swallowed, so a real write failure still
 *   surfaces as `RUN_ERROR`.
 *
 * The streaming discipline (`.claude/rules/api.md`): everything that can fail as JSON happens
 * BEFORE this is called — the caller resolves the client, the prompt, the history and the user row,
 * so a 503 `ai_not_configured` is an envelope rather than a broken stream. Inside, every write uses
 * `streamDatabase(c)`'s own client (the request's `db` is closed in `waitUntil` the moment the
 * Response is returned, which is before this body runs), every write and `tracer.flush()` is
 * awaited, and the handle is closed in `finally`. There is no `defer` after the Response.
 */
import {
  AguiEventType,
  type ChatRunResult,
  KIT_CUSTOM_EVENTS,
  type KitAguiEvent,
  type KitNoticeCode,
} from '@rocketflare/shared/ai/agui'
import {
  CHAT_HISTORY_MAX_MESSAGES,
  CHAT_MAX_TOOL_TURNS,
  CONVERSATION_TITLE_LENGTH,
} from '@rocketflare/shared/ai/chat'
import { and, desc, eq } from 'drizzle-orm'
import { stream } from 'hono/streaming'
import type { Database } from '../../../db/client'
import type { ConversationRow, MessageRow } from '../../../db/schema'
import { conversations, messages } from '../../../db/schema'
import { traceChatClient, withAgentTrace } from '../../observability/tracing'
import type { AppContext } from '../../types'
import { ConflictError, isUniqueViolation } from '../../utils/core/errors'
import { streamDatabase, withAuthAndDb } from '../../utils/routes/route-helpers'
import { buildAgentTools } from '../agents/tools'
import { enqueueJob } from '../jobs'
import { resolvePrompt } from '../prompts'
import { aguiTextSegmenter, createAguiEncoder, kitCustom } from './agui'
import { pendingCompaction, selectHistoryWindow, withSummary } from './chat-history'
import { AiError, describeAiError, normalizeAiError } from './errors'
import { runStreamingChat, type Tool } from './kit'
import { type ResolvedChat, resolveChat } from './resolve'
import type { ChatMessage, SystemPrompt } from './types'
import { recordUsage } from './usage'

export interface ChatTurnParams {
  conversation: ConversationRow
  /** The persisted user turn this run answers. */
  userMessage: MessageRow
  /** Everything the model sees, history first, ending in the user turn. */
  chatMessages: ChatMessage[]
  system: SystemPrompt
  resolved: ResolvedChat
  /**
   * Built INSIDE the stream, from the stream's own client. Building them from the request's `db`
   * is the one bug this design invites: that client is closed in `waitUntil` the moment the
   * Response is returned, so every tool call would fail after the first frame — as an error frame,
   * intermittently, only where `waitUntil` really runs.
   */
  buildTools: (db: Database) => Tool[]
  /** Hard cap on model turns for THIS run (interactive, so lower than a Workflow's). */
  maxTurns: number
  /** Set the thread's title from the user turn when it is the first one. */
  isFirstUserTurn: boolean
  /** Events emitted straight after `RUN_STARTED`, before the ids (`MESSAGES_SNAPSHOT`). */
  lead?: KitAguiEvent[]
  /** Things the reader should know about this turn that are not failures (`CUSTOM kit.notice`). */
  notices?: KitNoticeCode[]
  /** The client's run id where it supplied one; echoed, never stored. */
  runId?: string
}

export function streamChatTurn(c: AppContext, params: ChatTurnParams): Response {
  const { tenantId, user, tracer, logger } = withAuthAndDb(c)
  const { conversation, userMessage, resolved } = params
  const assistantMessageId = crypto.randomUUID()
  const runId = params.runId ?? crypto.randomUUID()
  const content = userMessage.content

  const encoder = createAguiEncoder(c.req.header('Accept'))
  c.header('Content-Type', encoder.contentType)
  if (!encoder.binary) {
    // `streamSSE` set these for us; `stream` does not, and a buffering proxy swallows a reply.
    c.header('Cache-Control', 'no-cache')
    c.header('Connection', 'keep-alive')
    c.header('X-Accel-Buffering', 'no')
  }

  return stream(c, async s => {
    const handle = streamDatabase(c)
    const sdb = handle.db
    const abort = new AbortController()
    s.onAbort(() => abort.abort())

    const emit = async (event: KitAguiEvent) => {
      const bytes = encoder.encode(event)
      if (bytes) await s.write(bytes)
    }
    const tools = params.buildTools(sdb)
    const text = aguiTextSegmenter(emit, assistantMessageId)
    const openToolCalls = new Set<string>()

    try {
      await emit({ type: AguiEventType.RUN_STARTED, threadId: conversation.id, runId })
      for (const event of params.lead ?? []) await emit(event)
      await emit(
        kitCustom(KIT_CUSTOM_EVENTS.chatIds, {
          conversationId: conversation.id,
          userMessageId: userMessage.id,
          assistantMessageId,
          provider: resolved.provider,
          model: resolved.model,
        })
      )
      await emit({
        type: AguiEventType.STATE_SNAPSHOT,
        snapshot: {
          conversationId: conversation.id,
          provider: resolved.provider,
          model: resolved.model,
          tools: tools.map(t => t.name),
        },
      })
      // Workers AI has no documented tool-call event stream, so the adapter runs a non-streamed
      // call and replays it: with tools on, the reply arrives in bursts per turn, not token by
      // token. Say so once rather than letting it read as a stall.
      if (resolved.provider === 'workers_ai' && tools.length > 0) {
        await emit(kitCustom(KIT_CUSTOM_EVENTS.notice, { code: 'workers_ai_no_token_streaming' }))
      }
      for (const code of params.notices ?? []) {
        await emit(kitCustom(KIT_CUSTOM_EVENTS.notice, { code }))
      }

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
            system: params.system,
            messages: params.chatMessages,
            tools,
            maxTurns: params.maxTurns,
            signal: abort.signal,
            onDelta: delta => text.delta(delta),
            onToolStart: async call => {
              // A turn's text ends where its tool calls begin: one text message per model turn.
              await text.close()
              openToolCalls.add(call.toolUseId)
              await emit({
                type: AguiEventType.TOOL_CALL_START,
                toolCallId: call.toolUseId,
                toolCallName: call.name,
                parentMessageId: text.parentMessageId(),
              })
              // The kit's adapters surface a tool input whole, so the args are one chunk.
              await emit({
                type: AguiEventType.TOOL_CALL_ARGS,
                toolCallId: call.toolUseId,
                delta: JSON.stringify(call.input ?? {}),
              })
              await emit({ type: AguiEventType.TOOL_CALL_END, toolCallId: call.toolUseId })
              openToolCalls.delete(call.toolUseId)
            },
            onToolEnd: async call => {
              // The tool's own JSON, unmodified: the AG-UI-native representation a third-party
              // client renders. `ToolCallResultEvent` has no error flag in 0.0.59.
              await emit({
                type: AguiEventType.TOOL_CALL_RESULT,
                messageId: crypto.randomUUID(),
                toolCallId: call.toolUseId,
                content: call.result,
                role: 'tool',
              })
            },
          })
        }
      )
      await text.close()

      // Persist BEFORE the terminal event — a client treats `RUN_FINISHED` as "it is saved".
      await sdb.insert(messages).values({
        id: assistantMessageId,
        conversationId: conversation.id,
        tenantId,
        role: 'assistant',
        content: result.text,
        toolCalls: result.toolCalls.length ? result.toolCalls : null,
        usage: result.usage,
      })
      await sdb
        .update(conversations)
        .set({
          lastMessageAt: new Date(),
          ...(params.isFirstUserTurn && conversation.title === 'New conversation'
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

      const chatResult: ChatRunResult = {
        conversationId: conversation.id,
        messageId: assistantMessageId,
        usage: result.usage,
        stopReason: result.stopReason,
      }
      await emit(kitCustom(KIT_CUSTOM_EVENTS.usage, { usage: result.usage }))
      await emit({
        type: AguiEventType.RUN_FINISHED,
        threadId: conversation.id,
        runId,
        result: chatResult,
        usage: [
          {
            provider: resolved.provider,
            model: resolved.model,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
          },
        ],
      })
    } catch (err) {
      // A cancelled run closes silently: the socket is gone, and a terminal frame would be a lie.
      if (abort.signal.aborted) return
      const aiError = err instanceof AiError ? err : normalizeAiError(err, resolved.provider)
      logger.warn({ err: aiError, conversationId: conversation.id }, 'chat: stream failed')
      try {
        for (const toolCallId of openToolCalls) {
          await emit({ type: AguiEventType.TOOL_CALL_END, toolCallId })
        }
        await text.close()
        await emit({
          type: AguiEventType.RUN_ERROR,
          message: describeAiError(aiError),
          code: aiError.code,
        })
      } catch {
        // The connection went away while we were reporting the failure; nothing left to say.
      }
    } finally {
      await handle.close()
      await tracer.flush()
    }
  })
}

/**
 * Rows read per turn: one more than the count backstop, so "is there an older prefix?" is answered
 * exactly rather than inferred from a full page. The real budget is characters — see
 * `chat-history.ts` for why a count alone produces a thread that fails on every turn.
 */
export const HISTORY_FETCH_LIMIT = CHAT_HISTORY_MAX_MESSAGES + 1

export interface PrepareChatTurnOptions {
  /** Already resolved by the caller (the AG-UI endpoint resolves before it adopts a thread). */
  resolved?: ResolvedChat
  /**
   * Reuse an already-persisted user row instead of inserting one. `POST /api/agui/run` passes the
   * row a replayed message id resolved to, so a client retry does not double-insert.
   */
  userMessage?: MessageRow
  /**
   * Persist the user turn under an id the CLIENT chose, which is what makes a replay detectable at
   * all — without it the row gets a fresh id and the same request twice is two turns.
   */
  userMessageId?: string
  lead?: KitAguiEvent[]
  runId?: string
}

/**
 * Everything that must happen — and may fail as a JSON envelope — BEFORE a stream opens: resolve
 * the client (503 `ai_not_configured` lands here, with no row written), build the system prompt,
 * read the history the model sees, and persist the user turn.
 */
export async function prepareChatTurn(
  c: AppContext,
  conversation: ConversationRow,
  content: string,
  options: PrepareChatTurnOptions = {}
): Promise<ChatTurnParams> {
  const { db, tenantId, user, cfg, auth, defer } = withAuthAndDb(c)
  const resolved =
    options.resolved ?? (await resolveChat(db, cfg, c.env, tenantId, { promptKey: 'chat' }))
  const system = await resolvePrompt(db, tenantId, 'chat', {
    appName: cfg.APP_NAME,
    tenantName: auth.tenant?.name ?? '',
    userName: user.name,
  })
  const recent = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversation.id), eq(messages.tenantId, tenantId)))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(HISTORY_FETCH_LIMIT)
  const history = recent.reverse()
  const earlier = options.userMessage
    ? history.filter(m => m.id !== options.userMessage?.id)
    : history
  const isFirstUserTurn = !earlier.some(m => m.role === 'user')

  // Trim to the character budget, newest-first; whatever falls out belongs to the summary.
  const { window, dropped } = selectHistoryWindow(earlier, { maxChars: cfg.CHAT_HISTORY_MAX_CHARS })
  const notices: KitNoticeCode[] = []
  if (dropped.length > 0) {
    notices.push(conversation.summary ? 'history_summarised' : 'history_truncated')
    // Compaction is a job, so the turn that FIRST crosses the budget answers without a summary —
    // the notice says so. The job recomputes the window itself and decides whether the pending
    // material is worth a model call, so enqueuing on every long turn is cheap and idempotent.
    if (pendingCompaction(dropped, conversation.summarisedThroughId).length > 0) {
      defer(() =>
        enqueueJob(c.env.JOBS_QUEUE, {
          type: 'chat.compact',
          payload: { tenantId, conversationId: conversation.id },
        })
      )
    }
  }

  // A replayed row is the turn: its stored text is what the model saw the first time, so the
  // caller's copy of it never overrides the record.
  let userMessage = options.userMessage
  const turnText = userMessage?.content ?? content
  if (!userMessage) {
    const [row] = await db
      .insert(messages)
      .values({
        ...(options.userMessageId ? { id: options.userMessageId } : {}),
        conversationId: conversation.id,
        tenantId,
        role: 'user',
        content,
      })
      .returning()
      .catch(err => {
        // The client chose an id that already exists in ANOTHER conversation. Rare, and better
        // said out loud than papered over with a server id the client cannot replay against.
        if (isUniqueViolation(err))
          throw new ConflictError('That message id is already in use', 'message_id_in_use')
        throw err
      })
    if (!row) throw new Error('messages: insert returned no row')
    userMessage = row
  }

  const chatMessages: ChatMessage[] = [
    ...window.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: turnText },
  ]

  return {
    conversation,
    userMessage,
    chatMessages,
    // The trimmed prefix comes back as the system prompt's volatile half, not as messages.
    system: withSummary(system, conversation.summary),
    resolved,
    // `AGENT_MAX_TURNS` (30) is a budget for a Workflow step with a ten-minute timeout; an
    // interactive reply shares the Worker's CPU and subrequest budget, so it gets the lower cap.
    buildTools: cfg.CHAT_KNOWLEDGE_TOOLS
      ? sdb => buildAgentTools({ db: sdb, cfg, env: c.env, tenantId })
      : () => [],
    maxTurns: Math.min(cfg.AGENT_MAX_TURNS, CHAT_MAX_TOOL_TURNS),
    isFirstUserTurn,
    lead: options.lead,
    notices,
    runId: options.runId,
  }
}
