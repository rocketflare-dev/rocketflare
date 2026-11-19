/**
 * `AgentRunWorkflow` — the ONE Workflow class, bound as `AGENT_RUN_WORKFLOW`, and the Cloudflare
 * adapter for the run-engine seam. The run itself — claim, `execute#N`, `resume#N`, `expire#N`,
 * finish, and every rule about them — is `runAgentRun` in `agent-run-body.ts`, written against
 * the neutral `Step` (`src/platform/types.ts`); this file only turns a `WorkflowStep` into one.
 * Exported from `src/worker.ts`, never from `api/index.ts`.
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowSleepDuration,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers'
import { MAX_INTERRUPT_ROUNDS } from '@rocketflare/shared/ai/agents'
import type { Step, StepOptions } from '../../platform/types'
import type { AgentRunParams } from '../services/agents/runs'
import type { ExecuteOutcome } from '../services/agents/runtime'
import type { AppBindings } from '../types'
import { runAgentRun } from './agent-run-body'

export { withStepDatabase } from './agent-run-body'

/**
 * A `WorkflowStep` as the neutral `Step`. The casts are the platform's own constraints, not ours:
 * `step.do` wants an `Rpc.Serializable` result (the body returns small plain objects, which is
 * what the constraint protects) and its durations are template-literal types a `Duration` matches
 * at runtime. `isControlFlow` is absent: Workflows never throws to steer a run, and it buffers an
 * event that arrives before the wait, so `arrived` is never asked.
 */
export function cloudflareStep(step: WorkflowStep): Step {
  // Always called AS A METHOD of `step`: under `wrangler dev` (and in production) `step` is an RPC
  // stub, whose members are remote-method proxies with no `bind` / `call` — `step.do.bind(step)`
  // throws "The RPC receiver does not implement the method \"bind\"" on the first step.
  const doStep = step as unknown as {
    do(
      name: string,
      ...rest: [() => Promise<unknown>] | [WorkflowStepConfig, () => Promise<unknown>]
    ): Promise<unknown>
  }
  return {
    do: (<T>(name: string, ...rest: [() => Promise<T>] | [StepOptions, () => Promise<T>]) =>
      (rest.length === 1
        ? doStep.do(name, rest[0])
        : doStep.do(name, rest[0] as WorkflowStepConfig, rest[1])) as Promise<T>) as Step['do'],
    waitForEvent: (name, options) =>
      step.waitForEvent(name, {
        type: options.type,
        ...(options.timeout !== undefined
          ? { timeout: options.timeout as WorkflowSleepDuration }
          : {}),
      }),
  }
}

export class AgentRunWorkflow extends WorkflowEntrypoint<AppBindings, AgentRunParams> {
  /**
   * The runaway guard's round count. An instance field so the test can lower it: the behaviour
   * under test is what happens AT the cap, and 32 rounds of real queries is latency-bound on a slow
   * link (30 s on a real Neon branch). Nothing else sets it.
   */
  maxInterruptRounds: number = MAX_INTERRUPT_ROUNDS

  async run(event: WorkflowEvent<AgentRunParams>, step: WorkflowStep): Promise<ExecuteOutcome> {
    return runAgentRun(event.payload, cloudflareStep(step), {
      env: this.env,
      maxInterruptRounds: this.maxInterruptRounds,
    })
  }
}
