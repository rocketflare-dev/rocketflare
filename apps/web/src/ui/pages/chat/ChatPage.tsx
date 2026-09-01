/**
 * `/chat` and `/chat/:conversationId` (D17): a left rail of MY conversations (new, delete,
 * paginated) and the thread pane — `ChatBubble` list, the streaming assistant bubble from
 * `useSendMessage`, and the composer (Enter sends, Shift+Enter newline, Stop aborts). A tenant with
 * no chat provider (readiness `none`, or a 503 `ai_not_configured` from create/send) gets an
 * `EmptyState` whose action is "Configure AI" for `manage AiConfig` holders and "ask an admin"
 * for everyone else. Lazy in App.tsx so the markdown renderer is its own chunk.
 */

import {
  ChatBubbleLeftRightIcon,
  PaperAirplaneIcon,
  PlusIcon,
  SparklesIcon,
  StopIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'
import type { Conversation } from '@rocketflare/shared/ai/chat'
import { shortModelName } from '@rocketflare/shared/ai/config'
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ChatBubble } from '@/ui/components/ai/ChatBubble'
import { ConfirmModal, EmptyState, PaginationControls, SkeletonRows } from '@/ui/components/shared'
import { useAiReadiness } from '@/ui/hooks/useAiConfig'
import {
  useConversation,
  useConversations,
  useCreateConversation,
  useDeleteConversation,
  useSendMessage,
} from '@/ui/hooks/useChat'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { isAiNotConfigured } from '@/ui/lib/chatStream'
import { timeAgo } from '@/ui/lib/format'

export default function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>()
  const navigate = useNavigate()
  const { can } = usePermissions()
  const canConfigure = can('manage', 'AiConfig')

  const [page, setPage] = useState(1)
  const list = useConversations({ page })
  const readiness = useAiReadiness()
  const create = useCreateConversation()
  const remove = useDeleteConversation()
  const thread = useConversation(conversationId)
  const { send, stop, turn, isStreaming, error: sendError } = useSendMessage(conversationId)
  const [deleting, setDeleting] = useState<Conversation | null>(null)

  const notConfigured =
    readiness.data?.chat.ready === false ||
    isAiNotConfigured(create.error) ||
    isAiNotConfigured(sendError)

  const startConversation = () =>
    create.mutate({}, { onSuccess: created => navigate(`/chat/${created.id}`) })

  const conversations = list.data?.items ?? []

  return (
    <div className="flex gap-4 h-[calc(100vh-9rem)] min-h-[480px]">
      <aside
        aria-label="Conversations"
        className="surface-panel p-0 w-64 shrink-0 hidden md:flex flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-[color:var(--border-subtle)]">
          <h2 className="text-sm font-semibold">Conversations</h2>
          <button
            type="button"
            className="btn btn-primary btn-xs gap-1"
            onClick={startConversation}
            disabled={create.isPending || notConfigured}
          >
            <PlusIcon className="w-3.5 h-3.5" />
            New
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto p-2" aria-label="Conversation list">
          {list.isLoading ? (
            <SkeletonRows rows={4} className="p-2" />
          ) : conversations.length === 0 ? (
            <p className="text-xs text-muted p-2">No conversations yet.</p>
          ) : (
            <ul className="space-y-0.5">
              {conversations.map(conversation => {
                const active = conversation.id === conversationId
                return (
                  <li key={conversation.id} className="group relative">
                    <Link
                      to={`/chat/${conversation.id}`}
                      data-active={active}
                      aria-current={active ? 'page' : undefined}
                      className="nav-item block px-2.5 py-1.5 pr-8"
                    >
                      <span className="block text-sm truncate">{conversation.title}</span>
                      <span className="block text-xs text-muted">
                        {timeAgo(conversation.lastMessageAt ?? conversation.createdAt)}
                      </span>
                    </Link>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs btn-square absolute right-1 top-1.5 opacity-0 group-hover:opacity-100 focus:opacity-100"
                      aria-label={`Delete "${conversation.title}"`}
                      onClick={() => setDeleting(conversation)}
                    >
                      <TrashIcon className="w-3.5 h-3.5" />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </nav>
        {list.data && (
          <div className="px-3 pb-2">
            <PaginationControls
              pagination={list.data.pagination}
              onPageChange={setPage}
              isLoading={list.isFetching}
            />
          </div>
        )}
      </aside>

      <section
        aria-label="Conversation"
        className="surface-panel p-0 flex-1 min-w-0 flex flex-col overflow-hidden"
      >
        {notConfigured ? (
          <div className="flex-1 flex items-center justify-center p-6">
            <EmptyState
              icon={SparklesIcon}
              message="AI is not configured"
              description={
                canConfigure
                  ? 'Add a chat provider so this workspace can answer.'
                  : 'Ask an administrator to add a chat provider in Settings → AI.'
              }
              action={
                canConfigure ? (
                  <Link to="/settings?tab=ai" className="btn btn-primary btn-sm">
                    Configure AI
                  </Link>
                ) : undefined
              }
            />
          </div>
        ) : !conversationId ? (
          <div className="flex-1 flex items-center justify-center p-6">
            <EmptyState
              icon={ChatBubbleLeftRightIcon}
              message="Start a conversation"
              description="Pick a thread on the left or begin a new one."
              action={
                <button
                  type="button"
                  className="btn btn-primary btn-sm gap-1.5"
                  onClick={startConversation}
                  disabled={create.isPending}
                >
                  <PlusIcon className="w-4 h-4" />
                  New conversation
                </button>
              }
            />
          </div>
        ) : (
          <>
            <header className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-[color:var(--border-subtle)]">
              <h1 className="text-sm font-semibold truncate">
                {thread.data?.title ?? 'Conversation'}
              </h1>
              {thread.data && (
                <span
                  className="badge badge-ghost badge-sm font-mono shrink-0"
                  title={`${thread.data.provider} · ${thread.data.model}`}
                >
                  {shortModelName(thread.data.model)}
                </span>
              )}
            </header>
            <Transcript
              conversationId={conversationId}
              loading={thread.isLoading}
              messages={thread.data?.messages}
              turn={turn}
            />
            <Composer
              key={conversationId}
              disabled={!thread.data || thread.isError}
              streaming={isStreaming}
              onSend={send}
              onStop={stop}
            />
          </>
        )}
      </section>

      <ConfirmModal
        isOpen={deleting !== null}
        title="Delete conversation"
        message={`Delete "${deleting?.title ?? ''}"? Its messages are removed for good.`}
        confirmText="Delete"
        confirmButtonClass="btn-error"
        isLoading={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return
          const id = deleting.id
          remove.mutate(id, {
            onSuccess: () => {
              setDeleting(null)
              if (id === conversationId) navigate('/chat')
            },
          })
        }}
      />
    </div>
  )
}

type Turn = ReturnType<typeof useSendMessage>['turn']

function Transcript({
  conversationId,
  loading,
  messages,
  turn,
}: {
  conversationId: string
  loading: boolean
  messages: NonNullable<ReturnType<typeof useConversation>['data']>['messages'] | undefined
  turn: Turn
}) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const count = messages?.length ?? 0

  // Follow the reply: every delta and every new message scrolls the log to its end.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on content changes, not on ref identity
  useEffect(() => {
    const el = bottomRef.current
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'end' })
  }, [count, turn.text, turn.status, conversationId])

  const showTurn = turn.status !== 'idle'
  return (
    <div
      className="flex-1 overflow-y-auto px-4 py-3 space-y-1"
      role="log"
      aria-live="polite"
      aria-label="Messages"
    >
      {loading ? (
        <SkeletonRows rows={3} />
      ) : count === 0 && !showTurn ? (
        <p className="text-sm text-muted text-center py-8">Say hello to begin.</p>
      ) : (
        messages
          ?.filter(m => m.role === 'user' || m.role === 'assistant')
          .map(message => (
            <ChatBubble
              key={message.id}
              speaker={message.role as 'user' | 'assistant'}
              content={message.content}
              time={message.createdAt}
              usage={message.usage}
            />
          ))
      )}
      {showTurn && (
        <ChatBubble
          speaker="assistant"
          content={turn.text}
          streaming={turn.status === 'streaming'}
          usage={turn.usage}
          model={turn.model}
          toolSteps={turn.toolSteps}
          error={turn.error?.message}
        />
      )}
      <div ref={bottomRef} />
    </div>
  )
}

function Composer({
  disabled,
  streaming,
  onSend,
  onStop,
}: {
  disabled: boolean
  streaming: boolean
  onSend: (content: string) => void
  onStop: () => void
}) {
  const [draft, setDraft] = useState('')
  const canSend = !disabled && !streaming && draft.trim().length > 0

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (!canSend) return
    onSend(draft.trim())
    setDraft('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <form
      onSubmit={submit}
      className="border-t border-[color:var(--border-subtle)] p-3 flex items-end gap-2"
    >
      <label htmlFor="chat-composer" className="sr-only">
        Message
      </label>
      <textarea
        id="chat-composer"
        className="textarea textarea-sm w-full resize-none leading-snug"
        rows={2}
        placeholder="Write a message… (Enter to send, Shift+Enter for a new line)"
        value={draft}
        disabled={disabled}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {streaming ? (
        <button type="button" className="btn btn-sm btn-outline gap-1.5" onClick={onStop}>
          <StopIcon className="w-4 h-4" />
          Stop
        </button>
      ) : (
        <button type="submit" className="btn btn-sm btn-primary gap-1.5" disabled={!canSend}>
          <PaperAirplaneIcon className="w-4 h-4" />
          Send
        </button>
      )}
    </form>
  )
}
