/**
 * One chat turn (D17) on DaisyUI's `chat` primitives. User turns render verbatim (pre-wrapped);
 * assistant turns render as Markdown. The trailing streaming bubble passes `streaming` (a dots
 * indicator, `aria-busy`), optional tool one-liners, and the `usage` footnote appears once the
 * `usage` frame (or the persisted message) carries it. Memoised for the same reason `Markdown` is.
 */
import type { TokenUsage } from '@rocketflare/shared/ai/chat'
import { memo } from 'react'
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
  toolSteps?: readonly string[]
  /** The stream ended on an `error` frame. */
  error?: string
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
  error,
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
            {toolSteps.map((step, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only step log
              <li key={i}>{step}</li>
            ))}
          </ul>
        )}
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
        {error && (
          <p role="alert" className="mt-2 text-xs text-error">
            {error}
          </p>
        )}
      </div>
      {footnote.length > 0 && (
        <div className="chat-footer text-xs text-muted mt-0.5">{footnote.join(' · ')}</div>
      )}
    </div>
  )
}

export const ChatBubble = memo(ChatBubbleImpl)
