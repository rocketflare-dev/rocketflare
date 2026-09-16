/**
 * One tool call and its answer, as ONE row (D7): a call and its result are one thing that happened,
 * so the input and the result share a disclosure and the row spins until it returns. A knowledge
 * tool additionally renders the documents it found as a card strip.
 */
import { ExclamationCircleIcon, WrenchScrewdriverIcon } from '@heroicons/react/24/outline'
import { formatDuration } from '@/ui/lib/format'
import { humaniseToolName, type ToolRow } from './timelineModel'
import { JsonDisclosure, ToolResultCards } from './toolResults'

export function ToolCallRow({ row }: { row: ToolRow }) {
  return (
    <div className="flex items-start gap-2.5 text-sm" data-event-kind="tool">
      {!row.done ? (
        <span className="loading loading-spinner loading-xs mt-0.5 shrink-0" />
      ) : row.isError ? (
        <ExclamationCircleIcon className="w-4 h-4 mt-0.5 shrink-0 text-error" />
      ) : (
        <WrenchScrewdriverIcon className="w-4 h-4 mt-0.5 shrink-0 text-secondary" />
      )}
      <div className="min-w-0 flex-1">
        <p>
          <span className="font-medium">{humaniseToolName(row.name)}</span>
          <span className={row.isError ? 'text-error' : 'text-muted'}>
            {' '}
            {row.done ? (row.isError ? 'failed' : 'returned') : 'running…'}
          </span>
          {row.durationMs !== undefined && (
            <span className="text-muted tabular-nums"> · {formatDuration(row.durationMs)}</span>
          )}
        </p>
        <ToolResultCards name={row.name} result={row.result} />
        {(row.input !== undefined || row.result !== undefined) && (
          <JsonDisclosure
            summary="Details"
            value={{
              ...(row.input !== undefined ? { input: row.input } : {}),
              ...(row.result !== undefined ? { result: row.result } : {}),
            }}
          />
        )}
      </div>
    </div>
  )
}
