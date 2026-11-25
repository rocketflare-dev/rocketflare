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
  ScaleIcon,
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
    case 'decision':
      return <ScaleIcon className={`${ICON} text-secondary`} />
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
    case 'decision':
      return <DecisionBody row={row} />
    case 'unknown':
      return <JsonDisclosure summary={row.type} value={row.data} className="mt-0" />
    default:
      return null
  }
}

/** Answers shown inline; a sift over many items folds the rest behind a disclosure. */
const DECISION_INLINE_ANSWERS = 4

/**
 * A `ctx.decide` call: the question set's key, each answer with its confidence, and whether
 * the numbers are calibrated — a self-reported probability must never read like Jev's.
 */
function DecisionBody({ row }: { row: Extract<Row, { kind: 'decision' }> }) {
  const inline = row.answers.slice(0, DECISION_INLINE_ANSWERS)
  const rest = row.answers.slice(DECISION_INLINE_ANSWERS)
  return (
    <div>
      <p>
        <span className="font-medium">Decided</span>{' '}
        <span className="font-mono text-xs">{row.key}</span>{' '}
        {row.method === 'typesafe' ? (
          <span className="badge badge-ghost badge-sm">Jev</span>
        ) : (
          <span
            className="badge badge-warning badge-outline badge-sm"
            title="The chat model reported these probabilities itself; they are not calibrated"
          >
            self-reported
          </span>
        )}
      </p>
      <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-secondary">
        {inline.map(answer => (
          <li key={answer.id}>
            <span className="font-mono">{answer.id}</span> → {answer.answer}{' '}
            <span className="text-muted">({answer.confidence.toFixed(2)})</span>
          </li>
        ))}
      </ul>
      {rest.length > 0 && <JsonDisclosure summary={`${rest.length} more answers`} value={rest} />}
    </div>
  )
}
