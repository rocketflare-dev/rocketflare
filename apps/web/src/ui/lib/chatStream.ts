/**
 * The chat streaming client (D17): `POST /api/chat/conversations/:id/messages` and consume the
 * SSE reply through `readSse`. Everything that can fail before the stream opens comes back as
 * the shared JSON envelope — a tenant with no chat provider is a 503 `ai_not_configured`, thrown
 * here as `AiNotConfiguredError` so the page can render a "configure AI" call to action instead
 * of a generic toast. Same cookie + `X-Requested-With` discipline as `lib/api-client.ts`.
 */
import type { ChatStreamEvent, TokenUsage } from '@rocketflare/shared/ai/chat'
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

export interface SendChatMessageOptions {
  conversationId: string
  content: string
  onEvent: (event: ChatStreamEvent) => void
  signal?: AbortSignal
}

/** What one streamed turn amounted to once the stream closed. */
export interface ChatStreamResult {
  /** Assistant text accumulated from `text.delta` frames. */
  text: string
  /** Ids from `message.start`, when it arrived. */
  messageId?: string
  userMessageId?: string
  model?: string
  usage?: TokenUsage
  /** The `error` frame, if the stream ended on one. */
  error?: { message: string; code: string }
  /** `message.end` arrived — the assistant message is persisted. */
  completed: boolean
  /** The caller's signal fired before the stream finished. */
  aborted: boolean
}

/**
 * POST the user turn and stream the reply. Resolves with the accumulated result when the stream
 * closes or the signal aborts; rejects with `AiNotConfiguredError` / `ApiError` for a pre-stream
 * failure and with the transport error for a dropped connection.
 */
export async function sendChatMessage({
  conversationId,
  content,
  onEvent,
  signal,
}: SendChatMessageOptions): Promise<ChatStreamResult> {
  const result: ChatStreamResult = { text: '', completed: false, aborted: false }

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
    event => {
      switch (event.type) {
        case 'message.start':
          result.messageId = event.messageId
          result.userMessageId = event.userMessageId
          result.model = event.model
          break
        case 'text.delta':
          result.text += event.delta
          break
        case 'usage':
          result.usage = event.usage
          break
        case 'message.end':
          result.completed = true
          break
        case 'error':
          result.error = { message: event.message, code: event.code }
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
