/**
 * What this run actually did — **and an honest gap where the money should be**.
 *
 * `ai_usage` gains a nullable run reference in this release but nothing populates it yet, so there
 * is no truthful per-run cost to show. The tab therefore reports what the rows genuinely know —
 * attempts, stages, tool calls, retries, wall-clock, per-tool totals — and **says in words** that
 * model cost is not attributed per run in this deployment, rather than rendering a `$0.00` that
 * reads as "this was free". That is the `unpricedTurns` honesty rule from the chat inspector,
 * copied across: a figure that leaves something out has to say so, or it is not a figure.
 *
 * It is also where the run's TIMESTAMPS live (requested, started, finished, by whom). They were
 * four rows of chrome in the header above the fold; this panel is already the answer to "what did
 * this run actually do", so they belong in the same list rather than in a second one nobody reads.
 */
import type { AgentRun } from '@rocketflare/shared/ai/agents'
import { Link } from 'react-router-dom'
import { Row, Section } from '@/ui/components/ai/StatRows'
import { formatDateTime, formatDuration, runDuration } from '@/ui/lib/format'
import { humaniseToolName, type RunWorkStats } from '../timeline/timelineModel'

export function RunUsageTab({
  run,
  stats,
  requestedBy,
}: {
  run: AgentRun
  stats: RunWorkStats
  /** "you" / "system" / a short id — the row carries only a user id (no name resolution yet). */
  requestedBy: string
}) {
  const elapsed =
    runDuration(run) ??
    (run.startedAt ? formatDuration(Date.now() - run.startedAt.getTime()) : null)

  return (
    <div className="surface-panel p-0 overflow-hidden">
      <Section title="This run">
        <Row label="Status" value={run.status} />
        <Row label="Requested" value={formatDateTime(run.createdAt)} />
        <Row label="Requested by" value={requestedBy} />
        <Row label="Started" value={formatDateTime(run.startedAt)} />
        <Row label="Finished" value={formatDateTime(run.finishedAt)} />
        <Row label="Attempts" value={String(run.attempt)} />
        <Row label="Wall clock" value={elapsed ?? '—'} hint="Started to finished, not CPU." />
        <Row label="Stages" value={String(stats.steps)} />
        <Row label="Model turns" value={String(stats.textTurns)} hint="Replies the model wrote." />
      </Section>
      <Section title="Tools">
        <Row label="Calls" value={String(stats.toolCalls)} />
        {stats.failedToolCalls > 0 && (
          <Row label="Failed calls" value={String(stats.failedToolCalls)} />
        )}
        {stats.tools.map(tool => (
          <Row
            key={tool.name}
            label={humaniseToolName(tool.name)}
            value={`${tool.calls}${tool.totalMs === null ? '' : ` · ${formatDuration(tool.totalMs)}`}`}
            hint={tool.totalMs === null ? 'One call never reported an end.' : undefined}
          />
        ))}
      </Section>
      <Section title="Interventions">
        <Row label="Questions asked" value={String(stats.asks)} />
        <Row label="Notes sent" value={String(stats.steeringNotes)} />
        <Row label="Artifacts" value={String(stats.artifacts)} />
        <Row label="Errors" value={String(stats.errors)} />
        <Row label="Retries" value={String(stats.retries)} />
      </Section>
      <section className="px-3 py-2">
        <h3 className="text-xs font-semibold mb-1">Model cost</h3>
        <p className="text-xs text-secondary">
          Not attributed per run in this deployment: <code>ai_usage</code> records every model call
          against the tenant and the feature, not the run. The tenant-wide ledger is on{' '}
          <Link to="/settings?tab=usage" className="link">
            Settings → Usage
          </Link>
          .
        </p>
      </section>
    </div>
  )
}
