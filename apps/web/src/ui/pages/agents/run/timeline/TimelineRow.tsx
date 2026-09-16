/**
 * One non-step timeline row. Model text renders through `Markdown` (which is why everything under
 * `pages/agents/**` is a lazy chunk); user text — a steering note — renders verbatim.
 *
 * An `interrupt` row appears here as HISTORY, in the place it happened, and never with a form on
 * it: the live form exists only in the pinned action panel above. Two live forms for one decision
 * is the trap this whole page is arranged to avoid.
 */
import {
  ArrowPathIcon,
  ChatBubbleLeftEllipsisIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  HandRaisedIcon,
  PaperClipIcon,
  PauseCircleIcon,
} from '@heroicons/react/24/outline'
import { Markdown } from '@/ui/components/ai/Markdown'
import { ToolCallRow } from './ToolCallRow'
import type { TimelineRow as Row } from './timelineModel'
import { JsonDisclosure } from './toolResults'

const ICON = 'w-4 h-4 mt-0.5 shrink-0'

export function TimelineRow({ row }: { row: Row }) {
  if (row.kind === 'tool') return <ToolCallRow row={row} />

  return (
    <div className="flex items-start gap-2.5 text-sm" data-event-kind={row.kind}>
      <RowIcon row={row} />
      <div className="min-w-0 flex-1">
        <RowBody row={row} />
      </div>
    </div>
  )
}

function RowIcon({ row }: { row: Row }) {
  switch (row.kind) {
    case 'error':
      return <ExclamationCircleIcon className={`${ICON} text-error`} />
    case 'status':
      return <ArrowPathIcon className={`${ICON} text-muted`} />
    case 'interrupt':
      return <PauseCircleIcon className={`${ICON} text-warning`} />
    case 'interrupt.resolved':
      return <CheckCircleIcon className={`${ICON} text-success`} />
    case 'steering':
      return <ChatBubbleLeftEllipsisIcon className={`${ICON} text-primary`} />
    case 'artifact':
      return <PaperClipIcon className={`${ICON} text-secondary`} />
    case 'text':
      return <HandRaisedIcon className={`${ICON} text-transparent`} aria-hidden="true" />
    default:
      return <span className={`${ICON} rounded-full border border-[color:var(--border-default)]`} />
  }
}

function RowBody({ row }: { row: Row }) {
  switch (row.kind) {
    case 'text':
      return <Markdown content={row.text} className="text-sm" />
    case 'status':
      return (
        <p className="text-xs text-muted">
          Status → {row.status}
          {row.attempt !== undefined && ` (attempt ${row.attempt})`}
          {row.reason !== undefined && ` · ${row.reason}`}
        </p>
      )
    case 'error':
      return (
        <div>
          <p className="text-error" role="alert">
            {row.message}
            {row.willRetry && <span className="text-muted"> · retrying</span>}
          </p>
          {row.details !== undefined && (
            <JsonDisclosure summary="What the model returned" value={row.details} />
          )}
        </div>
      )
    case 'interrupt':
      return (
        <p>
          <span className="font-medium">Asked for a decision</span>
          {row.message && <span className="text-secondary"> — {row.message}</span>}
        </p>
      )
    case 'interrupt.resolved':
      return (
        <p className="text-secondary">
          {row.status === 'cancelled' ? 'Declined' : 'Answered'}
          {row.resolvedByUserId === null && <span className="text-muted"> automatically</span>}
        </p>
      )
    case 'steering':
      return (
        <div>
          <p className="text-xs text-muted">Note from {row.authorName ?? 'a person'}</p>
          {/* A person's own words, never markdown — the same rule the chat surface follows. */}
          <p className="whitespace-pre-wrap">{row.text}</p>
        </div>
      )
    case 'artifact':
      return (
        <p>
          <span className="font-medium">{row.title}</span>
          <span className="text-muted"> · {row.artifactKind} artifact</span>
        </p>
      )
    case 'unknown':
      return <JsonDisclosure summary={row.type} value={row.data} className="mt-0" />
    default:
      return null
  }
}
