/**
 * Why a run failed, **above the tab bar and always visible**. A failure is not a tab: putting it
 * behind one means the page's headline answer to "what happened?" is a thing you have to go and
 * look for.
 *
 * A panel with an icon, not a saturated slab: the reason is information to read, and the next
 * step — Run again, with the same input — sits beside it for anyone who may start a run.
 */
import { ArrowPathIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'

export function RunErrorAlert({
  error,
  onRunAgain,
  runningAgain = false,
}: {
  error: string
  /** Absent when the reader may not start a run. */
  onRunAgain?: () => void
  runningAgain?: boolean
}) {
  return (
    <section
      className="surface-panel flex flex-wrap items-start gap-3 text-sm"
      role="alert"
      aria-label="Why this run failed"
    >
      <ExclamationTriangleIcon className="w-5 h-5 shrink-0 text-error" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-medium">This run did not finish</p>
        <p className="text-secondary whitespace-pre-wrap break-words">{error}</p>
      </div>
      {onRunAgain && (
        <button
          type="button"
          className="btn btn-sm gap-1.5"
          onClick={onRunAgain}
          disabled={runningAgain}
        >
          <ArrowPathIcon className="w-4 h-4" aria-hidden="true" />
          {runningAgain ? 'Starting…' : 'Run again'}
        </button>
      )}
    </section>
  )
}
