/**
 * One chat turn (D17) on DaisyUI's `chat` primitives. User turns render verbatim (pre-wrapped);
 * assistant turns render as Markdown. The trailing streaming bubble passes `streaming` (a dots
 * indicator, `aria-busy`), optional tool one-liners, a strip of `DocumentCard`s for whatever the
 * turn's knowledge tools surfaced (D18), and the `usage` footnote appears once the
 * `usage` frame (or the persisted message) carries it. Memoised for the same reason `Markdown` is.
 */
import { CheckCircleIcon } from '@heroicons/react/24/outline'
import type { TokenUsage } from '@rocketflare/shared/ai/chat'
import type { DocumentCard as DocumentCardData } from '@rocketflare/shared/ai/embeddings'
import { memo, type ReactNode } from 'react'
import { DocumentCard } from '@/ui/components/shared'
import type { ToolStep } from '@/ui/hooks/useChat'
import { Markdown } from './Markdown'

export interface ChatBubbleProps {
  speaker: 'user' | 'assistant'
  content: string
  /** Pass the cached `Date` through; a fresh `new Date()` per render defeats the memo. */
  time?: Date
  usage?: TokenUsage | null
  model?: string
  /** Reply still arriving. */
  streaming?: boolean
  /** Tool-call one-liners for this turn (the kit's chat runs zero tools; kept for apps). */
  toolSteps?: readonly ToolStep[]
  /** A `CUSTOM kit.notice` — something the reader should know that is NOT a failure. */
  notice?: string
  /**
   * Documents this turn's tool calls surfaced (D18) — from `CUSTOM kit.document` while streaming,
   * and from `messages.toolCalls` through the same pure mapper once the row is persisted, so a
   * reloaded thread shows the same strip as the live one.
   */
  documents?: readonly DocumentCardData[]
  /** The stream ended on a `RUN_ERROR`. */
  error?: string
  /** Rendered in the footer after the usage line — the thumbs on a persisted answer (D33). */
  actions?: ReactNode
}

/** `1,204 in · 87 out` (+ cache figures when the provider reported them). */
export function formatUsage(usage: TokenUsage): string {
  const parts = [
    `${usage.inputTokens.toLocaleString()} in`,
    `${usage.outputTokens.toLocaleString()} out`,
  ]
  if (usage.cacheReadTokens) parts.push(`${usage.cacheReadTokens.toLocaleString()} cache read`)
  if (usage.cacheWriteTokens) parts.push(`${usage.cacheWriteTokens.toLocaleString()} cache write`)
  return parts.join(' · ')
}

function ChatBubbleImpl({
  speaker,
  content,
  time,
  usage,
  model,
  streaming = false,
  toolSteps,
  notice,
  documents,
  error,
  actions,
}: ChatBubbleProps) {
  const mine = speaker === 'user'
  const footnote = [usage ? `${formatUsage(usage)} tokens` : null, model].filter(Boolean)
  return (
    <div
      className={`chat ${mine ? 'chat-end' : 'chat-start'}`}
      data-speaker={speaker}
      aria-busy={streaming || undefined}
    >
      <div className="chat-header text-xs text-muted">
        {mine ? 'You' : 'Assistant'}
        {time && (
          <time className="ml-1.5" dateTime={time.toISOString()}>
            {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </time>
        )}
      </div>
      <div className={`chat-bubble ${mine ? 'chat-bubble-primary' : ''} max-w-[80%]`}>
        {toolSteps && toolSteps.length > 0 && (
          <ul className="mb-1 space-y-0.5 text-xs text-muted">
            {toolSteps.map(step => (
              <li key={step.id} className="flex items-center gap-1.5">
                {step.done ? (
                  <CheckCircleIcon className="h-3.5 w-3.5 shrink-0 text-success" />
                ) : (
                  <span className="loading loading-spinner loading-xs shrink-0" />
                )}
                <span>{step.label}</span>
              </li>
            ))}
          </ul>
        )}
        {notice && <p className="mb-1 text-xs text-muted italic">{notice}</p>}
        {mine ? (
          <span className="whitespace-pre-wrap break-words">{content}</span>
        ) : content ? (
          <Markdown content={content} />
        ) : streaming ? (
          <span role="status" aria-label="Assistant is replying">
            <span className="loading loading-dots loading-sm" />
          </span>
        ) : null}
        {content && streaming && (
          <span role="status" aria-label="Assistant is replying" className="ml-1 align-baseline">
            <span className="loading loading-dots loading-xs" />
          </span>
        )}
        {documents && documents.length > 0 && (
          <div className="mt-2 space-y-1.5">
            {documents.map(card => (
              <DocumentCard key={card.id} card={card} dense />
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="mt-2 text-xs text-error">
            {error}
          </p>
        )}
      </div>
      {(footnote.length > 0 || actions) && (
        <div className="chat-footer text-xs text-muted mt-0.5 flex items-center gap-1.5">
          {footnote.length > 0 && <span>{footnote.join(' · ')}</span>}
          {actions}
        </div>
      )}
    </div>
  )
}

export const ChatBubble = memo(ChatBubbleImpl)
