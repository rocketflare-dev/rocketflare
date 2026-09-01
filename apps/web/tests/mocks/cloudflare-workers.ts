/**
 * Stub for the `cloudflare:workers` module (D15). Tests run under Node, not workerd;
 * vitest.config.ts aliases the module here so files that `extends DurableObject` or
 * `extends WorkflowEntrypoint` (Phase 2/3) still import. Ported from the Workers reference app
 * `tests/mocks/cloudflare-workers.ts`.
 */

export class DurableObject<Env = unknown> {
  protected ctx: unknown
  protected env: Env
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx
    this.env = env
  }
}

export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  protected ctx: unknown
  protected env: Env
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx
    this.env = env
  }
  run(_event: WorkflowEvent<Params>, _step: WorkflowStep): Promise<unknown> {
    return Promise.resolve()
  }
}

export interface WorkflowEvent<P = unknown> {
  payload: P
  timestamp: Date
  instanceId: string
}

export interface WorkflowStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>
  do<T>(name: string, config: Record<string, unknown>, fn: () => Promise<T>): Promise<T>
  sleep(name: string, duration: string | number): Promise<void>
  sleepUntil(name: string, timestamp: Date | number): Promise<void>
  waitForEvent<T>(name: string, options: { type: string; timeout?: string | number }): Promise<T>
}

/** `env` from cloudflare:workers — tests pass env explicitly instead. */
export const env = {} as Record<string, unknown>

export interface RecordedStep {
  name: string
  config?: Record<string, unknown>
}

/**
 * A `WorkflowStep` that just runs the callback inline and records `do(name, config?)` calls — no
 * retries, no timeouts, no checkpoints — for unit-testing a `WorkflowEntrypoint` subclass under Node.
 * A callback that throws propagates to the caller exactly as the platform would after its retries.
 */
export function createFakeWorkflowStep() {
  const calls: RecordedStep[] = []
  const step: WorkflowStep = {
    async do<T>(
      name: string,
      configOrFn: Record<string, unknown> | (() => Promise<T>),
      maybeFn?: () => Promise<T>
    ): Promise<T> {
      const fn = typeof configOrFn === 'function' ? configOrFn : (maybeFn as () => Promise<T>)
      calls.push(typeof configOrFn === 'function' ? { name } : { name, config: configOrFn })
      return fn()
    },
    async sleep() {},
    async sleepUntil() {},
    async waitForEvent() {
      throw new Error('waitForEvent is not supported by the fake step')
    },
  }
  return { step, calls }
}
