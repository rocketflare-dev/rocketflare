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
}

/** `env` from cloudflare:workers — tests pass env explicitly instead. */
export const env = {} as Record<string, unknown>
