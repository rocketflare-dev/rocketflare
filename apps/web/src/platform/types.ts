/**
 * The platform seam — the run-engine slice. The agent run's durable body
 * (`api/workflows/agent-run-body.ts`) is written against THESE types, never against
 * `cloudflare:workers`, so the runtime, the tool loop, the records and replay above it are
 * engine-neutral: Cloudflare Workflows adapts to them in `api/workflows/agent-run.ts`, and
 * Rocketpod's OpenWorkflow adapter (`src/node/runs.ts` there) drives the same body.
 *
 * The names and shapes are Rocketpod's (`rocketpod/apps/web/src/platform/types.ts`, the
 * "Durable runs" section) — keep them identical, so a change above the seam ports between the two
 * kits without a hand edit. Rocketpod's file carries the rest of its `Platform` (jobs, storage,
 * realtime…) and its `RunEngine`, which here are still the Worker bindings
 * (`env.AGENT_RUN_WORKFLOW` in `services/agents/runs.ts`): this file grows when one of them moves.
 */

/** A duration: milliseconds, or a `'<n> <unit>'` string (`'10 seconds'`, `'168 hours'`). */
export type Duration = number | `${number} ${DurationUnit}`
export type DurationUnit =
  | 'second'
  | 'seconds'
  | 'minute'
  | 'minutes'
  | 'hour'
  | 'hours'
  | 'day'
  | 'days'
  | 'week'
  | 'weeks'
  | 'month'
  | 'months'
  | 'year'
  | 'years'

export interface StepOptions {
  retries?: {
    limit: number
    delay: Duration
    backoff?: 'constant' | 'linear' | 'exponential'
  }
  timeout?: Duration
}

/**
 * What a durable run's body is handed. A step NAME is its identity: a completed step replays its
 * recorded result instead of running again, so a name must be unique within one run.
 */
export interface Step {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>
  do<T>(name: string, options: StepOptions, fn: () => Promise<T>): Promise<T>
  /** Park until an event of `type` arrives; rejects when `timeout` passes first. */
  waitForEvent(name: string, options: WaitForEventOptions): Promise<unknown>
  /**
   * True for an error the ENGINE threw to steer the run — a park, a lease lost to another worker —
   * which a body's `try/catch` must rethrow untouched (`if (step.isControlFlow?.(err)) throw err`).
   * OpenWorkflow parks a run by throwing out of `waitForEvent`. Optional: an engine (or a test's
   * fake step) that never throws to steer a run leaves it undefined — Cloudflare Workflows does.
   */
  isControlFlow?(err: unknown): boolean
}

export interface WaitForEventOptions {
  type: string
  timeout?: Duration
  /**
   * For an engine that does NOT buffer events (OpenWorkflow drops a signal nobody is waiting on):
   * asked once, checkpointed, before parking. `true` means the event's effect has already landed —
   * the wait returns without parking. An engine that buffers events may ignore it; Cloudflare
   * Workflows buffers, so its adapter does.
   */
  arrived?: () => Promise<boolean>
}
