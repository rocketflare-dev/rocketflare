/**
 * Chat (D17): MY conversations (`GET/POST /api/chat/conversations`, paginated), one thread with
 * its messages (`GET /:id`), delete, and the streaming turn. `useSendMessage` is the only hook in
 * the kit that writes to the cache mid-flight: the user bubble lands optimistically, the assistant
 * reply accumulates in LOCAL state from `text.delta` frames (it is not server truth until
 * `message.end`), `usage` is captured, and on `message.end` the finished message is written into
 * the cache and the whole `chat.conversations` family is invalidated so the list re-sorts and the
 * auto-title arrives. Stop = `AbortController.abort()` — an abort is a normal end, never an error.
 */
import {
  type ConversationWithMessages,
  type CreateConversationRequest,
  conversationSchema,
  conversationWithMessagesSchema,
  type Message,
  type TokenUsage,
} from '@gmgo/shared/ai/chat'
import { paginatedResponse } from '@gmgo/shared/pagination'
import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api, showToast } from '@/ui/lib/api-client'
import { type ChatStreamResult, isAiNotConfigured, sendChatMessage } from '@/ui/lib/chatStream'
import { cleanFilters, queryKeys, toSearchParams } from '@/ui/lib/query-keys'

export const conversationsResponseSchema = paginatedResponse(conversationSchema)

export interface ConversationsFilters {
  page?: number
  pageSize?: number
}

export function conversationsQueryOptions(filters: ConversationsFilters = {}) {
  return queryOptions({
    queryKey: queryKeys.chat.conversations.list(cleanFilters(filters)),
    queryFn: () =>
      api.get(`/api/chat/conversations${toSearchParams(filters)}`, {
        schema: conversationsResponseSchema,
      }),
    placeholderData: keepPreviousData,
  })
}

export function conversationQueryOptions(id: string) {
  return queryOptions({
    queryKey: queryKeys.chat.conversations.detail(id),
    queryFn: () =>
      api.get(`/api/chat/conversations/${encodeURIComponent(id)}`, {
        schema: conversationWithMessagesSchema,
      }),
  })
}

export function useConversations(filters: ConversationsFilters = {}) {
  return useQuery(conversationsQueryOptions(filters))
}

export function useConversation(id: string | undefined) {
  return useQuery({ ...conversationQueryOptions(id ?? ''), enabled: Boolean(id) })
}

/**
 * `POST /api/chat/conversations` — 503 `ai_not_configured` is the page's business (it renders
 * the configure call to action), so the default error toast is off and re-applied for the rest.
 */
export function useCreateConversation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateConversationRequest = {}) =>
      api.post('/api/chat/conversations', body, {
        schema: conversationSchema,
        showErrorToast: false,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.chat.conversations.all }),
    onError: error => {
      if (!isAiNotConfigured(error)) showToast(error.message, 'error')
    },
  })
}

export function useDeleteConversation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.delete(`/api/chat/conversations/${encodeURIComponent(id)}`, undefined, {
        showSuccessToast: true,
        successMessage: 'Conversation deleted',
      }),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: queryKeys.chat.conversations.detail(id) })
      return queryClient.invalidateQueries({ queryKey: queryKeys.chat.conversations.all })
    },
  })
}

// ---- the streaming turn -----------------------------------------------------------------------

export type StreamingStatus = 'idle' | 'streaming' | 'error'

/** The assistant turn in flight — LOCAL state, rendered as the trailing bubble. */
export interface StreamingTurn {
  status: StreamingStatus
  text: string
  model?: string
  usage?: TokenUsage
  /** Human one-liners for `tool.start`/`tool.end` frames (the kit's chat runs zero tools). */
  toolSteps: string[]
  error?: { message: string; code: string }
}

const IDLE_TURN: StreamingTurn = { status: 'idle', text: '', toolSteps: [] }

const OPTIMISTIC_PREFIX = 'optimistic-'

function appendMessage(
  thread: ConversationWithMessages | undefined,
  message: Message
): ConversationWithMessages | undefined {
  if (!thread) return thread
  return {
    ...thread,
    lastMessageAt: message.createdAt,
    messages: [...thread.messages.filter(m => m.id !== message.id), message],
  }
}

export function useSendMessage(conversationId: string | undefined) {
  const queryClient = useQueryClient()
  const [turn, setTurn] = useState<StreamingTurn>(IDLE_TURN)
  const abortRef = useRef<AbortController | null>(null)

  const stop = useCallback(() => abortRef.current?.abort(), [])

  // Switching thread (or unmounting) mid-reply ends the stream; the server keeps what it saved.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on thread change by design
  useEffect(() => {
    setTurn(IDLE_TURN)
    return () => abortRef.current?.abort()
  }, [conversationId])

  const mutation = useMutation({
    mutationFn: async (content: string): Promise<ChatStreamResult> => {
      if (!conversationId) throw new Error('No conversation selected')
      const key = queryKeys.chat.conversations.detail(conversationId)
      const controller = new AbortController()
      abortRef.current = controller
      const optimisticId = `${OPTIMISTIC_PREFIX}${Date.now()}`

      queryClient.setQueryData<ConversationWithMessages>(key, old =>
        appendMessage(old, {
          id: optimisticId,
          conversationId,
          role: 'user',
          content,
          createdAt: new Date(),
        })
      )
      setTurn({ ...IDLE_TURN, status: 'streaming' })

      let result: ChatStreamResult
      try {
        result = await sendChatMessage({
          conversationId,
          content,
          signal: controller.signal,
          onEvent: event => {
            switch (event.type) {
              case 'message.start':
                // The user message now has its real id; keep the bubble, swap the key.
                queryClient.setQueryData<ConversationWithMessages>(key, old =>
                  old
                    ? {
                        ...old,
                        messages: old.messages.map(m =>
                          m.id === optimisticId ? { ...m, id: event.userMessageId } : m
                        ),
                      }
                    : old
                )
                setTurn(t => ({ ...t, model: event.model }))
                break
              case 'text.delta':
                setTurn(t => ({ ...t, text: t.text + event.delta }))
                break
              case 'tool.start':
                setTurn(t => ({ ...t, toolSteps: [...t.toolSteps, `Using ${event.name}…`] }))
                break
              case 'tool.end':
                setTurn(t => ({
                  ...t,
                  toolSteps: [
                    ...t.toolSteps,
                    event.isError ? `${event.name} failed` : `${event.name} done`,
                  ],
                }))
                break
              case 'usage':
                setTurn(t => ({ ...t, usage: event.usage }))
                break
              case 'error':
                setTurn(t => ({
                  ...t,
                  status: 'error',
                  error: { message: event.message, code: event.code },
                }))
                break
              default:
                break
            }
          },
        })
      } catch (error) {
        // Nothing streamed, nothing persisted: take the optimistic bubble back.
        queryClient.setQueryData<ConversationWithMessages>(key, old =>
          old ? { ...old, messages: old.messages.filter(m => m.id !== optimisticId) } : old
        )
        setTurn(IDLE_TURN)
        throw error
      } finally {
        if (abortRef.current === controller) abortRef.current = null
      }

      if (result.completed && result.messageId) {
        // Persisted server-side before `message.end`: write it into the cache so the reply never
        // blinks out between "stream closed" and "refetch landed".
        const assistant: Message = {
          id: result.messageId,
          conversationId,
          role: 'assistant',
          content: result.text,
          toolCalls: null,
          usage: result.usage ?? null,
          createdAt: new Date(),
        }
        queryClient.setQueryData<ConversationWithMessages>(key, old =>
          appendMessage(old, assistant)
        )
        setTurn(IDLE_TURN)
      } else if (result.aborted) {
        setTurn(IDLE_TURN)
      }
      // `error` frame: the turn stays in `error` status (the page shows it) until the next send.

      await queryClient.invalidateQueries({ queryKey: queryKeys.chat.conversations.all })
      return result
    },
    onError: error => {
      if (isAiNotConfigured(error)) return
      showToast(error instanceof ApiError ? error.message : 'The reply could not be sent', 'error')
    },
  })

  const reset = useCallback(() => setTurn(IDLE_TURN), [])

  return {
    send: mutation.mutate,
    sendAsync: mutation.mutateAsync,
    stop,
    reset,
    turn,
    isStreaming: mutation.isPending,
    error: mutation.error,
  }
}
