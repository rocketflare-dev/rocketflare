/**
 * Chat (D17): MY conversations (`GET/POST /api/chat/conversations`, paginated), one thread with
 * its messages (`GET /:id`), delete, and the streaming turn, which speaks **AG-UI**.
 * `useSendMessage` is the only hook in the kit that writes to the cache mid-flight: the user bubble
 * lands optimistically, `CUSTOM kit.chat.ids` swaps its id for the persisted one, the assistant
 * reply accumulates in LOCAL state from `TEXT_MESSAGE_CONTENT` deltas (it is not server truth until
 * `RUN_FINISHED`, and deltas are accumulated across every message id the run opens — one per model
 * turn), and on `RUN_FINISHED` the finished message is written into the cache and the whole
 * `chat.conversations` family is invalidated so the list re-sorts and the auto-title arrives.
 * Stop = `AbortController.abort()` — a cancelled run emits NO terminal event, which is the
 * protocol's way of saying "the client went away"; it is a normal end, never an error.
 */

import type { KitNoticeCode } from '@rocketflare/shared/ai/agui'
import { AguiEventType, KIT_CUSTOM_EVENTS, parseKitCustom } from '@rocketflare/shared/ai/agui'
import {
  type ConversationWithMessages,
  type CreateConversationRequest,
  conversationSchema,
  conversationWithMessagesSchema,
  type Message,
  type TokenUsage,
} from '@rocketflare/shared/ai/chat'
import { paginatedResponse } from '@rocketflare/shared/pagination'
import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type ChatTurnResult, isAiNotConfigured, runChatTurn } from '@/ui/lib/aguiStream'
import { ApiError, api, showToast } from '@/ui/lib/api-client'
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
  /** One entry per tool CALL — a call and its result are one thing that happened, not two lines. */
  toolSteps: ToolStep[]
  /** A `CUSTOM kit.notice` the reader should see — rendered as a quiet line, not an error. */
  notice?: KitNoticeCode
  error?: { message: string; code: string }
}

/** A tool call in flight or finished: `TOOL_CALL_RESULT` completes the row `TOOL_CALL_START` opened. */
export interface ToolStep {
  id: string
  label: string
  done: boolean
}

/** What a tool call is called in the transcript. An unknown tool falls back to its wire name. */
const TOOL_LABELS: Record<string, string> = {
  search_knowledge: 'Searching the knowledge base',
  get_document: 'Reading a document',
  list_documents: 'Listing documents',
}

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name
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
    mutationFn: async (content: string): Promise<ChatTurnResult> => {
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

      let result: ChatTurnResult
      try {
        result = await runChatTurn({
          conversationId,
          content,
          signal: controller.signal,
          onEvent: event => {
            switch (event.type) {
              case AguiEventType.CUSTOM: {
                const ids = parseKitCustom(KIT_CUSTOM_EVENTS.chatIds, event)
                if (ids) {
                  // The user message now has its real id; keep the bubble, swap the key.
                  queryClient.setQueryData<ConversationWithMessages>(key, old =>
                    old
                      ? {
                          ...old,
                          messages: old.messages.map(m =>
                            m.id === optimisticId ? { ...m, id: ids.userMessageId } : m
                          ),
                        }
                      : old
                  )
                  setTurn(t => ({ ...t, model: ids.model }))
                }
                const usage = parseKitCustom(KIT_CUSTOM_EVENTS.usage, event)
                if (usage) setTurn(t => ({ ...t, usage: usage.usage }))
                const notice = parseKitCustom(KIT_CUSTOM_EVENTS.notice, event)
                if (notice) setTurn(t => ({ ...t, notice: notice.code }))
                break
              }
              case AguiEventType.TEXT_MESSAGE_CONTENT:
                setTurn(t => ({ ...t, text: t.text + event.delta }))
                break
              case AguiEventType.TOOL_CALL_START:
                setTurn(t => ({
                  ...t,
                  toolSteps: [
                    ...t.toolSteps,
                    { id: event.toolCallId, label: toolLabel(event.toolCallName), done: false },
                  ],
                }))
                break
              case AguiEventType.TOOL_CALL_RESULT:
                // Complete the row this result answers, by id — never append a second one.
                setTurn(t => ({
                  ...t,
                  toolSteps: t.toolSteps.map(step =>
                    step.id === event.toolCallId ? { ...step, done: true } : step
                  ),
                }))
                break
              case AguiEventType.RUN_ERROR:
                setTurn(t => ({
                  ...t,
                  status: 'error',
                  error: { message: event.message, code: event.code ?? 'internal' },
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
        // Persisted server-side before `RUN_FINISHED`: write it into the cache so the reply never
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
      // `RUN_ERROR`: the turn stays in `error` status (the page shows it) until the next send.

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
