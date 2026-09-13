/**
 * The AG-UI client for a chat turn: POST the user message and read the reply as AG-UI events.
 * Frames are spec AG-UI — `data: <one JSON event>`, **no `event:` line** — validated with
 * `kitAguiEventSchema`, so anything this build does not know is dropped rather than thrown.
 *
 * Everything that can fail before the stream opens comes back as the shared JSON envelope: a
 * tenant with no chat provider is a 503 `ai_not_configured`, surfaced here as
 * `AiNotConfiguredError` so the page can render a "configure AI" call to action instead of a
 * generic toast. Same cookie + `X-Requested-With` discipline as `lib/api-client.ts`.
 *
 * `@ag-ui/core` reaches the browser only through this module's import of
 * `@rocketflare/shared/ai/agui` — it must stay out of the eager shell (`.claude/rules/ui.md`).
 */
import {
  AguiEventType,
  chatRunResultSchema,
  KIT_CUSTOM_EVENTS,
  type KitAguiEvent,
  type KitNoticeCode,
  kitAguiEventSchema,
  parseKitCustom,
} from '@rocketflare/shared/ai/agui'
import type { TokenUsage } from '@rocketflare/shared/ai/chat'
import type { DocumentCard } from '@rocketflare/shared/ai/embeddings'
import type { ApiErrorBody } from '@rocketflare/shared/errors'
import { ApiError, notifyUnauthorized, parseErrorBody } from './api-client'
import { isAbortError, readSse } from './sse'

export const AI_NOT_CONFIGURED = 'ai_not_configured'

/** 503 `ai_not_configured` — no chat provider resolves for this tenant (tenant row or platform key). */
export class AiNotConfiguredError extends ApiError {
  constructor(body: ApiErrorBody) {
    super(body)
    this.name = 'AiNotConfiguredError'
  }
}

/** `true` for the typed error above OR the same envelope surfaced through `api.post` (create). */
export function isAiNotConfigured(error: unknown): boolean {
  return (
    error instanceof AiNotConfiguredError ||
    (error instanceof ApiError && error.status === 503 && error.code === AI_NOT_CONFIGURED)
  )
}

export interface RunChatTurnOptions {
  conversationId: string
  content: string
  onEvent: (event: KitAguiEvent) => void
  signal?: AbortSignal
}

/** What one streamed turn amounted to once the stream closed. */
export interface ChatTurnResult {
  /** Assistant text accumulated from `TEXT_MESSAGE_CONTENT`, across every message id in the run. */
  text: string
  /** Ids from `CUSTOM kit.chat.ids`, when it arrived. */
  messageId?: string
  userMessageId?: string
  model?: string
  usage?: TokenUsage
  notice?: KitNoticeCode
  /** The `RUN_ERROR` event, if the stream ended on one. */
  error?: { message: string; code: string }
  /**
   * Documents the turn's tool calls surfaced, from `CUSTOM kit.document` (D18), de-duplicated and
   * in arrival order. Empty for a turn that called no knowledge tool.
   */
  documents: DocumentCard[]
  /** `RUN_FINISHED` arrived — the assistant message is persisted. */
  completed: boolean
  /**
   * The caller's signal fired before the stream finished. A cancelled run emits NO terminal
   * event by design, so "closed with neither `RUN_FINISHED` nor `RUN_ERROR`" is the only signal.
   */
  aborted: boolean
}

const parseAguiFrame = (json: unknown) => {
  const parsed = kitAguiEventSchema.safeParse(json)
  return parsed.success
    ? ({ ok: true, event: parsed.data } as const)
    : ({ ok: false, reason: parsed.error.issues[0]?.message ?? 'unknown frame' } as const)
}

/**
 * POST the user turn and stream the reply. Resolves with the accumulated result when the stream
 * closes or the signal aborts; rejects with `AiNotConfiguredError` / `ApiError` for a pre-stream
 * failure and with the transport error for a dropped connection.
 */
export async function runChatTurn({
  conversationId,
  content,
  onEvent,
  signal,
}: RunChatTurnOptions): Promise<ChatTurnResult> {
  const result: ChatTurnResult = { text: '', documents: [], completed: false, aborted: false }

  let response: Response
  try {
    response = await fetch(
      `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'X-Requested-With': 'fetch',
        },
        body: JSON.stringify({ content }),
        signal,
      }
    )
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) return { ...result, aborted: true }
    throw error
  }

  if (!response.ok) {
    const body = await parseErrorBody(response)
    if (body.statusCode === 401) {
      const error = new ApiError(body)
      notifyUnauthorized(error)
      throw error
    }
    if (body.statusCode === 503 && body.code === AI_NOT_CONFIGURED) {
      throw new AiNotConfiguredError(body)
    }
    throw new ApiError(body)
  }

  await readSse(
    response,
    parseAguiFrame,
    event => {
      switch (event.type) {
        case AguiEventType.TEXT_MESSAGE_CONTENT:
          result.text += event.delta
          break
        case AguiEventType.CUSTOM: {
          const ids = parseKitCustom(KIT_CUSTOM_EVENTS.chatIds, event)
          if (ids) {
            result.messageId = ids.assistantMessageId
            result.userMessageId = ids.userMessageId
            result.model = ids.model
          }
          const usage = parseKitCustom(KIT_CUSTOM_EVENTS.usage, event)
          if (usage) result.usage = usage.usage
          const notice = parseKitCustom(KIT_CUSTOM_EVENTS.notice, event)
          if (notice) result.notice = notice.code
          const document = parseKitCustom(KIT_CUSTOM_EVENTS.document, event)
          // The same document can be named by several tool calls in one turn — one card each.
          if (document && !result.documents.some(d => d.id === document.card.id)) {
            result.documents.push(document.card)
          }
          break
        }
        case AguiEventType.RUN_FINISHED: {
          result.completed = true
          // The result restates the ids and usage for a client that reads only the terminal event.
          const parsed = chatRunResultSchema.safeParse(event.result)
          if (parsed.success) {
            result.messageId = parsed.data.messageId
            result.usage = parsed.data.usage
          }
          break
        }
        case AguiEventType.RUN_ERROR:
          result.error = { message: event.message, code: event.code ?? 'internal' }
          break
        default:
          break
      }
      onEvent(event)
    },
    { signal }
  )

  if (signal?.aborted && !result.completed) result.aborted = true
  return result
}
