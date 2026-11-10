/**
 * `streamChat` — a scoped, streamed chat turn for a plugin route, in AG-UI.
 *
 * The kit's own chat (`services/ai/chat-turn.ts`) is bound to a conversation row: it persists both
 * turns, compacts history and offers the knowledge tools. A plugin that answers a question in its
 * own surface ("Ask the Guide") wants none of that, and it must not rebuild the parts it DOES want —
 * the resolve seam, the streaming tool loop, the AG-UI encoder, usage and tracing — because a copy
 * of those is the thing that drifts. This is those parts, with the plugin's prompt and its tools:
 *
 * ```
 * RUN_STARTED → STATE_SNAPSHOT { provider, model, tools[] } [→ CUSTOM kit.notice…]
 *   → per model turn: TEXT_MESSAGE_START → CONTENT… → END
 *                     TOOL_CALL_START → ARGS → END → TOOL_CALL_RESULT [→ CUSTOM <id>.… from a tool]
 *   -- recordUsage (awaited, on the stream's own client) --
 *   → CUSTOM <id>.… from onFinish → CUSTOM kit.usage → RUN_FINISHED { result: { text, usage, stopReason } }
 * ```
 *
 * The rules it holds for the plugin, so the plugin cannot get them wrong:
 *
 * - **Everything that can fail as JSON fails BEFORE the stream.** No chat provider is the kit's
 *   503 `ai_not_configured` envelope; a prompt key the plugin did not register or a feature label
 *   outside its namespace is a 500 with no stream opened.
 * - **The namespace is the PROMPT's owner.** `promptKey` must be one this plugin registered in
 *   `ServerPlugin.prompts`; the plugin that registered it is the id every CUSTOM event and the
 *   `feature` label must carry. A CUSTOM name outside `<id>.` (or under `kit.`) is refused: the
 *   run ends with `RUN_ERROR` code `invalid_custom_event`, never with the event on the wire.
 * - **Tools are built inside the stream, from the stream's database client** — the request's is
 *   closed the moment the Response is returned. Only the plugin's tools are offered; a tool that
 *   declares an approval gate is withheld (chat cannot park a turn).
 * - **Budgets are the chat's**: `AGENT_MAX_OUTPUT_TOKENS` per call (the resolved ceiling),
 *   `maxTurns` clamped to the interactive cap, history trimmed to `CHAT_HISTORY_MAX_CHARS`
 *   newest-first (a `kit.notice history_truncated` says so). Like the kit's chat, a turn is not
 *   counted against `AGENT_TENANT_DAILY_COST_USD`, which meters agent runs only.
 * - **Cancellation emits nothing**; a failure closes open messages and emits `RUN_ERROR` — the
 *   same terminal conventions as the kit's chat.
 *
 * `services/prompts` (the registry, and `promptOwner` over it) is reached through a FUNCTION-SCOPE
 * `await import(...)`: it reads the plugin barrel at module scope, which imports every plugin,
 * which imports this module — the cycle `http.ts` documents.
 */
import {
  AguiEventType,
  KIT_CUSTOM_EVENTS,
  type KitAguiEvent,
  type KitNoticeCode,
} from '@rocketflare/shared/ai/agui'
import {
  CHAT_HISTORY_MAX_MESSAGES,
  CHAT_MAX_TOOL_TURNS,
  type TokenUsage,
} from '@rocketflare/shared/ai/chat'
import { stream } from 'hono/streaming'
import { traceChatClient, withAgentTrace } from '../../api/observability/tracing'
import { accessScopeOf } from '../../api/services/access-sql'
import {
  runStreamingChat,
  type StreamingToolCall,
  type Tool,
} from '../../api/services/ai/agent-loop'
import {
  aguiTextSegmenter,
  aguiToolEvents,
  createAguiEncoder,
  kitCustom,
} from '../../api/services/ai/agui'
import { workersAiStreamsTools } from '../../api/services/ai/client'
import { AiError, describeAiError, normalizeAiError } from '../../api/services/ai/errors'
import { resolveChat } from '../../api/services/ai/resolve'
import type { StopReason } from '../../api/services/ai/types'
import { recordUsage } from '../../api/services/ai/usage'
import type { RegistryPromptKey } from '../../api/services/prompts'
import type { AppContext } from '../../api/types'
import { streamDatabase, withAuthAndDb } from '../../api/utils/routes/route-helpers'
import { type ToolCtx, toolCtx } from './ai'

/** One prior turn of the plugin's own conversation, oldest first. */
export interface StreamChatTurn {
  role: 'user' | 'assistant'
  content: string
}

/** Emit one CUSTOM event named `<plugin id>.<what>`. Any other name is refused. */
export type StreamChatEmit = (name: string, value: unknown) => Promise<void>

/** What a plugin's tool builder is handed: the usual `ToolCtx`, on the stream's client, plus `emit`. */
export interface StreamChatToolCtx extends ToolCtx {
  emit: StreamChatEmit
}

/** What the turn produced, handed to `onFinish` and returned in `RUN_FINISHED.result`. */
export interface StreamChatResult {
  /** The text the reader was shown, every turn's joined. */
  text: string
  toolCalls: StreamingToolCall[]
  usage: TokenUsage
  stopReason: StopReason | 'max_turns'
  provider: string
  model: string
}

export interface StreamChatOptions {
  /**
   * A key THIS plugin registered in `ServerPlugin.prompts`. Its text (a tenant's override or the
   * default) is the system prompt, and `agent_models` may assign it a model of its own.
   */
  promptKey: string
  /**
   * Per-request context appended AFTER the prompt (the volatile half of the system prompt, so the
   * prompt itself stays cacheable) — the screen the person is on, say. Never tenant data the reader
   * could not otherwise see.
   */
  system?: string
  /** `{{variables}}` for the prompt, over the defaults `appName`, `tenantName` and `userName`. */
  variables?: Record<string, string | undefined>
  /** The conversation so far, oldest first. Trimmed newest-first to `CHAT_HISTORY_MAX_CHARS`. */
  history?: readonly StreamChatTurn[]
  /** This turn's question. */
  message: string
  /**
   * The plugin's own tools, built INSIDE the stream from the context it is handed (the stream's
   * database client, the reader's scope and grants). No kit knowledge tool is added.
   */
  tools?: (ctx: StreamChatToolCtx) => Tool[] | Promise<Tool[]>
  /** Model turns allowed; clamped to the interactive cap (`CHAT_MAX_TOOL_TURNS`, `AGENT_MAX_TURNS`). */
  maxTurns?: number
  /** The `ai_usage` label: `<plugin id>`, `<plugin id>:<what>` or `<plugin id>.<what>`. */
  feature: string
  /** Aborts the turn as if the client went away (nothing more is emitted). */
  signal?: AbortSignal
  /** Echoed as `threadId` on `RUN_STARTED` / `RUN_FINISHED`; a fresh uuid when absent. */
  threadId?: string
  /**
   * After the model's last turn, before `RUN_FINISHED`: emit the plugin's closing events
   * (`guide.answer` with its citations). A throw here is a `RUN_ERROR`.
   */
  onFinish?: (result: StreamChatResult, ctx: { emit: StreamChatEmit }) => void | Promise<void>
}

/** A CUSTOM name a plugin may not emit. A TYPE, so the stream can say which code it was. */
export class InvalidCustomEventError extends Error {
  readonly code = 'invalid_custom_event'
  constructor(message: string) {
    super(message)
    this.name = 'InvalidCustomEventError'
  }
}

/** Why `name` is not a CUSTOM event `pluginId` may emit, or null when it may. Pure. */
export function customEventNameIssue(pluginId: string, name: string): string | null {
  if (name.startsWith('kit.')) return `'${name}' is in the kit's reserved 'kit.' namespace`
  const prefix = `${pluginId}.`
  if (!name.startsWith(prefix) || name.length === prefix.length) {
    return `'${name}' must be named '${prefix}<what>'`
  }
  return null
}

/** Why `feature` is not a usage label `pluginId` may record under, or null when it may. Pure. */
export function usageFeatureIssue(pluginId: string, feature: string): string | null {
  if (feature === pluginId) return null
  if (
    (feature.startsWith(`${pluginId}:`) || feature.startsWith(`${pluginId}.`)) &&
    feature.length > pluginId.length + 1
  ) {
    return null
  }
  return `feature '${feature}' must be '${pluginId}', '${pluginId}:<what>' or '${pluginId}.<what>'`
}

/** Newest-first under both budgets; the newest turn is kept even when it alone is over. */
function trimHistory(
  history: readonly StreamChatTurn[],
  maxChars: number
): { kept: StreamChatTurn[]; dropped: number } {
  const kept: StreamChatTurn[] = []
  let chars = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i] as StreamChatTurn
    chars += turn.content.length
    if (kept.length > 0 && (chars > maxChars || kept.length >= CHAT_HISTORY_MAX_MESSAGES)) break
    kept.unshift(turn)
  }
  // The window opens on a person's turn: an assistant turn first, or two user turns in a row once
  // this turn's message is appended, is a request some providers refuse.
  while (kept[0]?.role === 'assistant') kept.shift()
  return { kept, dropped: history.length - kept.length }
}

/**
 * Stream one chat turn for a plugin route, as AG-UI (SSE, or protobuf when the client's `Accept`
 * negotiates it). Call it as the route's return value:
 *
 * ```ts
 * router.post('/ask', validate('json', askSchema), c =>
 *   streamChat(c, { promptKey: 'guide-chat', feature: 'guide:ask', message, history,
 *     tools: ctx => guideTools(ctx), onFinish: (r, { emit }) => emit('guide.answer', cite(r.text)) }))
 * ```
 */
export async function streamChat(c: AppContext, options: StreamChatOptions): Promise<Response> {
  const { db, cfg, tenantId, user, auth, tracer, logger } = withAuthAndDb(c)

  // ---- everything that can fail as JSON, before the first frame ----
  const { promptOwner, resolvePrompt } = await import('../../api/services/prompts')
  const pluginId = promptOwner(options.promptKey)
  if (!pluginId) {
    throw new Error(
      `streamChat: prompt '${options.promptKey}' is not registered by any installed plugin's ServerPlugin.prompts`
    )
  }
  const featureIssue = usageFeatureIssue(pluginId, options.feature)
  if (featureIssue) throw new Error(`streamChat: ${featureIssue}`)

  // 503 `ai_not_configured` lands here, as an envelope.
  const resolved = await resolveChat(db, cfg, c.env, tenantId, { promptKey: options.promptKey })
  const prompt = await resolvePrompt(db, tenantId, options.promptKey as RegistryPromptKey, {
    appName: cfg.APP_NAME,
    tenantName: auth.tenant?.name ?? '',
    userName: user.name,
    ...options.variables,
  })
  const system = options.system ? { stable: prompt, volatile: options.system } : prompt
  const { kept, dropped } = trimHistory(options.history ?? [], cfg.CHAT_HISTORY_MAX_CHARS)
  const notices: KitNoticeCode[] = dropped > 0 ? ['history_truncated'] : []
  const chatMessages = [
    ...kept.map(t => ({ role: t.role, content: t.content })),
    { role: 'user' as const, content: options.message },
  ]
  const maxTurns = Math.max(
    1,
    Math.min(options.maxTurns ?? CHAT_MAX_TOOL_TURNS, CHAT_MAX_TOOL_TURNS, cfg.AGENT_MAX_TURNS)
  )
  const scope = accessScopeOf(auth)
  const threadId = options.threadId ?? crypto.randomUUID()
  const runId = crypto.randomUUID()

  const encoder = createAguiEncoder(c.req.header('Accept'))
  c.header('Content-Type', encoder.contentType)
  if (!encoder.binary) {
    c.header('Cache-Control', 'no-cache')
    c.header('Connection', 'keep-alive')
    c.header('X-Accel-Buffering', 'no')
  }

  return stream(c, async s => {
    const handle = streamDatabase(c)
    const sdb = handle.db
    const abort = new AbortController()
    s.onAbort(() => abort.abort())
    if (options.signal?.aborted) abort.abort()
    else options.signal?.addEventListener('abort', () => abort.abort(), { once: true })

    const write = async (event: KitAguiEvent) => {
      const bytes = encoder.encode(event)
      if (bytes) await s.write(bytes)
    }
    // The first refused name, kept so a refusal inside a TOOL (whose throw the loop turns into an
    // error result the model reads) still ends the run.
    let refused: InvalidCustomEventError | null = null
    const emit: StreamChatEmit = async (name, value) => {
      const issue = customEventNameIssue(pluginId, name)
      if (issue) {
        refused ??= new InvalidCustomEventError(`Plugin '${pluginId}' may not emit ${issue}`)
        throw refused
      }
      await write({ type: AguiEventType.CUSTOM, name, value })
    }
    const text = aguiTextSegmenter(write, crypto.randomUUID())
    const toolEvents = aguiToolEvents(write, text)

    try {
      await write({ type: AguiEventType.RUN_STARTED, threadId, runId })
      const tools = options.tools
        ? await options.tools({
            ...toolCtx({
              db: sdb,
              cfg,
              env: c.env,
              scope,
              can: (action, subject) => auth.ability.can(action, subject),
            }),
            emit,
          })
        : []

      await write({
        type: AguiEventType.STATE_SNAPSHOT,
        snapshot: {
          provider: resolved.provider,
          model: resolved.model,
          tools: tools.map(t => t.name),
          capabilities: { humanInTheLoop: { supported: false, feedback: false } },
        },
      })
      if (
        resolved.provider === 'workers_ai' &&
        tools.length > 0 &&
        !workersAiStreamsTools(resolved.model)
      ) {
        await write(kitCustom(KIT_CUSTOM_EVENTS.notice, { code: 'workers_ai_no_token_streaming' }))
      }
      for (const code of notices) await write(kitCustom(KIT_CUSTOM_EVENTS.notice, { code }))

      const loop = await withAgentTrace(
        options.feature,
        {
          tracer,
          tenantId,
          userId: user.id,
          tags: [pluginId, 'chat'],
          metadata: { model: resolved.model, promptKey: options.promptKey },
          input: options.message,
        },
        trace =>
          runStreamingChat(
            traceChatClient(resolved.client, trace, { provider: resolved.provider }, tracer),
            {
              model: resolved.model,
              maxTokens: resolved.maxOutputTokens,
              system,
              messages: chatMessages,
              tools,
              maxTurns,
              signal: abort.signal,
              onDelta: delta => text.delta(delta),
              onToolStart: toolEvents.onToolStart,
              onToolEnd: async call => {
                await toolEvents.onToolEnd(call)
                if (refused) throw refused
              },
            }
          )
      )
      await text.close()

      // Recorded BEFORE the terminal event, on the stream's client, awaited — even when a refused
      // event is about to fail the run: the tokens were spent either way.
      await recordUsage(sdb, {
        tenantId,
        userId: user.id,
        feature: options.feature,
        provider: resolved.provider,
        model: resolved.model,
        usage: loop.usage,
      })
      if (refused) throw refused

      const result: StreamChatResult = {
        text: loop.text,
        toolCalls: loop.toolCalls,
        usage: loop.usage,
        stopReason: loop.stopReason,
        provider: resolved.provider,
        model: resolved.model,
      }
      await options.onFinish?.(result, { emit })
      await write(kitCustom(KIT_CUSTOM_EVENTS.usage, { usage: loop.usage }))
      await write({
        type: AguiEventType.RUN_FINISHED,
        threadId,
        runId,
        result: { text: loop.text, usage: loop.usage, stopReason: loop.stopReason },
        usage: [
          {
            provider: resolved.provider,
            model: resolved.model,
            inputTokens: loop.usage.inputTokens,
            outputTokens: loop.usage.outputTokens,
          },
        ],
      })
    } catch (err) {
      // A cancelled turn closes silently: the socket is gone, and a terminal frame would be a lie.
      if (abort.signal.aborted) return
      const failure =
        err instanceof InvalidCustomEventError
          ? { message: err.message, code: err.code }
          : (() => {
              const aiError =
                err instanceof AiError ? err : normalizeAiError(err, resolved.provider)
              return { message: describeAiError(aiError), code: aiError.code as string }
            })()
      logger.warn({ err, plugin: pluginId, feature: options.feature }, 'streamChat: turn failed')
      try {
        await toolEvents.closeOpen()
        await text.close()
        await write({ type: AguiEventType.RUN_ERROR, ...failure })
      } catch {
        // The connection went away while we were reporting the failure; nothing left to say.
      }
    } finally {
      await handle.close()
      await tracer.flush()
    }
  })
}
