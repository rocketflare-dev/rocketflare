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

/** One `step.waitForEvent(name, { type, timeout })` the class asked for. */
export interface RecordedWait {
  name: string
  type: string
  timeout?: string | number
}

export interface FakeWorkflowStepOptions {
  /**
   * Payloads handed to successive `waitForEvent` calls, in order. When the queue is empty and no
   * {@link FakeWorkflowStepOptions.onWait} supplies one, the wait REJECTS the way the platform's
   * own timeout does — which is how a test drives the expiry path.
   */
  events?: unknown[]
  /**
   * Called before each wait resolves — the test's stand-in for the resolve route, whose job in the
   * real system is to flip `awaiting_input → running` BEFORE it wakes the instance (decision 2).
   * Return a value to use it as the event payload; return nothing to fall through to the queue.
   */
  onWait?: (wait: RecordedWait) => unknown | Promise<unknown>
}

/** What the platform raises when `waitForEvent` reaches its timeout with nothing delivered. */
export class FakeWorkflowTimeoutError extends Error {
  constructor(name: string) {
    super(`workflow.wait_for_event_timeout: no event delivered to "${name}"`)
    this.name = 'FakeWorkflowTimeoutError'
  }
}

/**
 * A `WorkflowStep` that just runs the callback inline and records what was asked for — no retries,
 * no timeouts, no checkpoints — for unit-testing a `WorkflowEntrypoint` subclass under Node.
 * A callback that throws propagates to the caller exactly as the platform would after its retries.
 *
 * `waitForEvent` is a RECORDER rather than a throw, because the suspend/resume loop (issue #17) is
 * the interesting thing about this class. The one property no fake can check is the step NAME —
 * the platform treats it as the step's identity and replays a repeated name's earlier result — so
 * `names` is exposed in call order for the test that asserts they are distinct per round.
 */
export function createFakeWorkflowStep(options: FakeWorkflowStepOptions = {}) {
  const calls: RecordedStep[] = []
  const waits: RecordedWait[] = []
  /** Every recorded step name — `do` and `waitForEvent` alike — in the order they were asked for. */
  const names: string[] = []
  const queue: unknown[] = [...(options.events ?? [])]
  const step: WorkflowStep = {
    async do<T>(
      name: string,
      configOrFn: Record<string, unknown> | (() => Promise<T>),
      maybeFn?: () => Promise<T>
    ): Promise<T> {
      const fn = typeof configOrFn === 'function' ? configOrFn : (maybeFn as () => Promise<T>)
      calls.push(typeof configOrFn === 'function' ? { name } : { name, config: configOrFn })
      names.push(name)
      return fn()
    },
    async sleep() {},
    async sleepUntil() {},
    async waitForEvent<T>(
      name: string,
      waitOptions: { type: string; timeout?: string | number }
    ): Promise<T> {
      const wait: RecordedWait = { name, type: waitOptions.type, timeout: waitOptions.timeout }
      waits.push(wait)
      names.push(name)
      const supplied = await options.onWait?.(wait)
      if (supplied !== undefined) return supplied as T
      if (queue.length > 0) return queue.shift() as T
      throw new FakeWorkflowTimeoutError(name)
    },
  }
  return {
    step,
    calls,
    waits,
    names,
    /** Queue one more payload for a later wait. */
    queueEvent(payload: unknown) {
      queue.push(payload)
    },
  }
}
