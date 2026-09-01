/**
 * A run's durable event stream as a timeline (D7, D17). Events arrive in `seq` order from
 * `agent_run_events`; `step` rows merge by `key` (a `done` updates the row its `running`
 * announced — the checklist reads as progress, not as a log of the same stage twice), tool
 * frames show the tool name with the rest of the payload behind a `<details>`, `text` renders
 * through `Markdown` (model output), `status` and `error` are quiet status lines. Payloads beyond
 * `step` are `unknown` on the wire, so each is parsed leniently here rather than read blind.
 */

import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  WrenchScrewdriverIcon,
} from '@heroicons/react/24/outline'
import {
  type AgentRunEvent,
  type AgentStepEventData,
  agentStepEventDataSchema,
} from '@rocketflare/shared/ai/agents'
import { useMemo } from 'react'
import { z } from 'zod'
import { Markdown } from '@/ui/components/ai/Markdown'

const toolDataSchema = z.object({ name: z.string() }).passthrough()
const textDataSchema = z.object({ text: z.string() })
const statusDataSchema = z.object({ status: z.string(), attempt: z.number().optional() })
const errorDataSchema = z.object({
  message: z.string(),
  attempt: z.number().optional(),
  willRetry: z.boolean().optional(),
})

type Row =
  | { kind: 'step'; id: string; step: AgentStepEventData; at: Date }
  | { kind: 'tool'; id: string; phase: 'start' | 'end'; name: string; rest: unknown; at: Date }
  | { kind: 'text'; id: string; text: string; at: Date }
  | { kind: 'status'; id: string; status: string; attempt?: number; at: Date }
  | { kind: 'error'; id: string; message: string; willRetry: boolean; at: Date }
  | { kind: 'unknown'; id: string; type: string; data: unknown; at: Date }

/** Pure: events (any order) → timeline rows in `seq` order, `step` rows merged by key. */
export function buildTimeline(events: readonly AgentRunEvent[]): Row[] {
  const rows: Row[] = []
  const stepIndex = new Map<string, number>()
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    switch (event.type) {
      case 'step': {
        const parsed = agentStepEventDataSchema.safeParse(event.data)
        if (!parsed.success) {
          rows.push({
            kind: 'unknown',
            id: event.id,
            type: event.type,
            data: event.data,
            at: event.at,
          })
          break
        }
        const existing = stepIndex.get(parsed.data.key)
        if (existing !== undefined) {
          rows[existing] = { kind: 'step', id: event.id, step: parsed.data, at: event.at }
        } else {
          stepIndex.set(parsed.data.key, rows.length)
          rows.push({ kind: 'step', id: event.id, step: parsed.data, at: event.at })
        }
        break
      }
      case 'tool.start':
      case 'tool.end': {
        const parsed = toolDataSchema.safeParse(event.data)
        const { name, ...rest } = parsed.success ? parsed.data : { name: 'tool' }
        rows.push({
          kind: 'tool',
          id: event.id,
          phase: event.type === 'tool.start' ? 'start' : 'end',
          name,
          rest: Object.keys(rest).length > 0 ? rest : undefined,
          at: event.at,
        })
        break
      }
      case 'text': {
        const parsed = textDataSchema.safeParse(event.data)
        if (parsed.success)
          rows.push({ kind: 'text', id: event.id, text: parsed.data.text, at: event.at })
        else
          rows.push({
            kind: 'unknown',
            id: event.id,
            type: event.type,
            data: event.data,
            at: event.at,
          })
        break
      }
      case 'status': {
        const parsed = statusDataSchema.safeParse(event.data)
        if (parsed.success)
          rows.push({ kind: 'status', id: event.id, ...parsed.data, at: event.at })
        break
      }
      case 'error': {
        const parsed = errorDataSchema.safeParse(event.data)
        rows.push({
          kind: 'error',
          id: event.id,
          message: parsed.success ? parsed.data.message : 'The run reported an error',
          willRetry: parsed.success ? Boolean(parsed.data.willRetry) : false,
          at: event.at,
        })
        break
      }
      default:
        rows.push({
          kind: 'unknown',
          id: event.id,
          type: event.type,
          data: event.data,
          at: event.at,
        })
    }
  }
  return rows
}

/** `submit_summary` → `Submit summary`. */
export function humaniseToolName(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const time = (at: Date) => at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function AgentSteps({
  events,
  className = '',
}: {
  events: readonly AgentRunEvent[]
  className?: string
}) {
  const rows = useMemo(() => buildTimeline(events), [events])
  if (rows.length === 0) {
    return <p className={`text-sm text-muted ${className}`}>No progress reported yet.</p>
  }
  return (
    <ol className={`space-y-2 ${className}`} aria-label="Run timeline">
      {rows.map(row => (
        <li key={row.id} className="flex items-start gap-2.5 text-sm" data-event-kind={row.kind}>
          <TimelineIcon row={row} />
          <div className="min-w-0 flex-1">
            <TimelineBody row={row} />
          </div>
          <time
            className="text-xs text-muted tabular-nums shrink-0"
            dateTime={row.at.toISOString()}
          >
            {time(row.at)}
          </time>
        </li>
      ))}
    </ol>
  )
}

function TimelineIcon({ row }: { row: Row }) {
  const cls = 'w-4 h-4 mt-0.5 shrink-0'
  if (row.kind === 'step') {
    if (row.step.status === 'done') return <CheckCircleIcon className={`${cls} text-success`} />
    if (row.step.status === 'error')
      return <ExclamationCircleIcon className={`${cls} text-error`} />
    return <span className="loading loading-spinner loading-xs mt-0.5 shrink-0 text-primary" />
  }
  if (row.kind === 'tool') return <WrenchScrewdriverIcon className={`${cls} text-secondary`} />
  if (row.kind === 'error') return <ExclamationCircleIcon className={`${cls} text-error`} />
  if (row.kind === 'status') return <ArrowPathIcon className={`${cls} text-muted`} />
  return <span className={`${cls} rounded-full border border-[color:var(--border-default)]`} />
}

function TimelineBody({ row }: { row: Row }) {
  switch (row.kind) {
    case 'step':
      return (
        <p className={row.step.status === 'done' ? 'text-secondary' : ''}>
          <span className="font-medium">{row.step.label}</span>
          {row.step.detail && <span className="text-muted"> · {row.step.detail}</span>}
        </p>
      )
    case 'tool':
      return (
        <div>
          <p>
            <span className="font-medium">{humaniseToolName(row.name)}</span>
            <span className="text-muted"> {row.phase === 'start' ? 'called' : 'returned'}</span>
          </p>
          {row.rest !== undefined && (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-muted select-none">Details</summary>
              <pre className="surface-inset rounded-md p-2 mt-1 text-xs whitespace-pre-wrap break-words max-h-48 overflow-auto">
                {pretty(row.rest)}
              </pre>
            </details>
          )}
        </div>
      )
    case 'text':
      return <Markdown content={row.text} className="text-sm" />
    case 'status':
      return (
        <p className="text-xs text-muted">
          Status → {row.status}
          {row.attempt !== undefined && ` (attempt ${row.attempt})`}
        </p>
      )
    case 'error':
      return (
        <p className="text-error" role="alert">
          {row.message}
          {row.willRetry && <span className="text-muted"> · retrying</span>}
        </p>
      )
    default:
      return (
        <details>
          <summary className="cursor-pointer text-xs text-muted select-none">{row.type}</summary>
          <pre className="surface-inset rounded-md p-2 mt-1 text-xs whitespace-pre-wrap break-words">
            {pretty(row.data)}
          </pre>
        </details>
      )
  }
}
