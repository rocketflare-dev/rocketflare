/**
 * One run, opened over the list at `/agents/runs/:id` (D7, D8, D17, D18): header (status, attempt,
 * timings, Cancel while active), the `AgentSteps` timeline from `GET /runs/:id` (reconciled by the
 * server; re-read on the `agent-run` nudge and every 3 s while active), the typed output panel
 * (`summarize-text` → summary, key points, a link to the indexed document when `documentId` is
 * set), the raw output JSON behind a toggle, and the error when the run failed. Closing the
 * drawer never touches the run — it is a durable row; Cancel is the explicit button.
 */

import { DocumentMagnifyingGlassIcon } from '@heroicons/react/24/outline'
import {
  type AgentRunWithEvents,
  isRunActive,
  summarizeTextOutputSchema,
} from '@rocketflare/shared/ai/agents'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Markdown } from '@/ui/components/ai/Markdown'
import { Modal, SkeletonRows } from '@/ui/components/shared'
import { useAgentList, useAgentRun, useCancelAgentRun } from '@/ui/hooks/useAgents'
import { useAuth } from '@/ui/hooks/useAuth'
import { formatDateTime } from '@/ui/lib/format'
import { AgentSteps } from './AgentSteps'
import { RunStatusBadge } from './RunStatusBadge'

/** `1m 12s`, `840ms`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

/** Elapsed for a settled run; `null` while it still owes an answer or never started. */
export function runDuration(run: {
  startedAt: Date | null
  finishedAt: Date | null
}): string | null {
  if (!run.startedAt || !run.finishedAt) return null
  return formatDuration(run.finishedAt.getTime() - run.startedAt.getTime())
}

export function RunDetailDrawer({ runId, onClose }: { runId: string; onClose: () => void }) {
  const run = useAgentRun(runId)
  const agents = useAgentList()
  const title = agents.data?.items.find(a => a.key === run.data?.agentKey)?.title

  return (
    <Modal
      open
      onClose={onClose}
      className="max-w-3xl"
      title={
        <span className="flex items-center gap-2 flex-wrap">
          {title ?? run.data?.agentKey ?? 'Run'}
          {run.data && <RunStatusBadge status={run.data.status} />}
        </span>
      }
    >
      {run.isLoading ? (
        <SkeletonRows rows={4} />
      ) : run.isError || !run.data ? (
        <p className="text-sm text-error" role="alert">
          This run could not be loaded — it may belong to someone else or no longer exist.
        </p>
      ) : (
        <RunBody run={run.data} />
      )}
    </Modal>
  )
}

function RunBody({ run }: { run: AgentRunWithEvents }) {
  const cancel = useCancelAgentRun()
  const { user } = useAuth()
  const active = isRunActive(run.status)
  const duration = runDuration(run)
  const requestedBy =
    run.requestedByUserId === null
      ? 'system'
      : run.requestedByUserId === user?.id
        ? 'you'
        : run.requestedByUserId.slice(0, 8)

  return (
    <div className="space-y-5">
      <section className="flex items-start justify-between gap-4" aria-label="Run summary">
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-xs flex-1">
          <dt className="text-muted">Requested</dt>
          <dd>
            {formatDateTime(run.createdAt)} <span className="text-muted">by {requestedBy}</span>
          </dd>
          <dt className="text-muted">Started</dt>
          <dd>{formatDateTime(run.startedAt)}</dd>
          <dt className="text-muted">Finished</dt>
          <dd>{formatDateTime(run.finishedAt)}</dd>
          <dt className="text-muted">Duration</dt>
          <dd>
            {duration ?? (active ? <span className="text-muted">in progress…</span> : '—')}
            <span className="text-muted"> · attempt {run.attempt}</span>
          </dd>
        </dl>
        {active && (
          <button
            type="button"
            className="btn btn-sm btn-outline btn-error shrink-0"
            onClick={() => cancel.mutate(run.id)}
            disabled={cancel.isPending || run.cancelRequestedAt !== null}
          >
            {run.cancelRequestedAt ? 'Cancelling…' : 'Cancel run'}
          </button>
        )}
      </section>

      <section aria-label="Progress">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">Progress</h4>
        <AgentSteps events={run.events} />
      </section>

      {run.error && (
        <section className="alert alert-error text-sm" role="alert">
          {run.error}
        </section>
      )}

      {run.output !== null && run.output !== undefined && (
        <OutputPanel agentKey={run.agentKey} output={run.output} />
      )}
    </div>
  )
}

function OutputPanel({ agentKey, output }: { agentKey: string; output: unknown }) {
  const [raw, setRaw] = useState(false)
  const summary = agentKey === 'summarize-text' ? summarizeTextOutputSchema.safeParse(output) : null

  return (
    <section aria-label="Output" className="surface-inset rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Output</h4>
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          aria-pressed={raw}
          onClick={() => setRaw(r => !r)}
        >
          {raw ? 'Formatted' : 'Raw JSON'}
        </button>
      </div>
      {raw || !summary?.success ? (
        <pre className="text-xs whitespace-pre-wrap break-words max-h-80 overflow-auto">
          {JSON.stringify(output, null, 2)}
        </pre>
      ) : (
        <div className="space-y-3">
          <Markdown content={summary.data.summary} className="text-sm" />
          {summary.data.keyPoints.length > 0 && (
            <div>
              <h5 className="text-sm font-medium mb-1">Key points</h5>
              <ul className="list-disc pl-5 text-sm space-y-0.5">
                {summary.data.keyPoints.map(point => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </div>
          )}
          {summary.data.documentId && (
            <Link
              to={`/documents?documentId=${encodeURIComponent(summary.data.documentId)}`}
              className="link link-primary text-sm inline-flex items-center gap-1.5"
            >
              <DocumentMagnifyingGlassIcon className="w-4 h-4" />
              Indexed as a searchable document
            </Link>
          )}
        </div>
      )}
    </section>
  )
}
