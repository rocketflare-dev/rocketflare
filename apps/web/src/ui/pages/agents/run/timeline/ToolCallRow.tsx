/**
 * One tool call and its answer, as ONE row: a call and its result are one thing that happened,
 * so the input and the result share a disclosure and the row spins until it returns. A knowledge
 * tool additionally renders the documents it found as a card strip.
 */
import {
  CpuChipIcon,
  ExclamationCircleIcon,
  StopCircleIcon,
  WrenchScrewdriverIcon,
} from '@heroicons/react/24/outline'
import { formatDuration } from '@/ui/lib/format'
import { humaniseToolName, modelUsage, type ToolRow } from './timelineModel'
import { JsonDisclosure, ToolResultCards } from './toolResults'

export function ToolCallRow({ row }: { row: ToolRow }) {
  return (
    <div className="flex items-start gap-2.5 text-sm" data-event-kind="tool">
      {row.stopped ? (
        <StopCircleIcon className="w-4 h-4 mt-0.5 shrink-0 text-muted" aria-label="Stopped" />
      ) : !row.done ? (
        <span className="loading loading-spinner loading-xs mt-0.5 shrink-0" />
      ) : row.isError ? (
        <ExclamationCircleIcon className="w-4 h-4 mt-0.5 shrink-0 text-error" />
      ) : row.model ? (
        <CpuChipIcon className="w-4 h-4 mt-0.5 shrink-0 text-secondary" />
      ) : (
        <WrenchScrewdriverIcon className="w-4 h-4 mt-0.5 shrink-0 text-secondary" />
      )}
      <div className="min-w-0 flex-1">
        <p>
          <span className="font-medium">
            {row.model ? `Model call · ${row.name}` : humaniseToolName(row.name)}
          </span>
          <span className={row.isError ? 'text-error' : 'text-muted'}>
            {' '}
            {row.done
              ? row.isError
                ? 'failed'
                : row.model
                  ? 'answered'
                  : 'returned'
              : row.stopped
                ? 'stopped'
                : 'running…'}
          </span>
          {row.durationMs !== undefined && (
            <span className="text-muted tabular-nums"> · {formatDuration(row.durationMs)}</span>
          )}
          {row.model && <ModelTokens result={row.result} />}
        </p>
        {!row.model && <ToolResultCards name={row.name} result={row.result} />}
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

/** `· 1,204 in · 312 out` from a recorded model call's usage, when the row carries one. */
function ModelTokens({ result }: { result: unknown }) {
  const { inputTokens, outputTokens } = modelUsage(result)
  if (inputTokens === 0 && outputTokens === 0) return null
  return (
    <span className="text-muted tabular-nums">
      {' '}
      · {inputTokens.toLocaleString()} in · {outputTokens.toLocaleString()} out
    </span>
  )
}
