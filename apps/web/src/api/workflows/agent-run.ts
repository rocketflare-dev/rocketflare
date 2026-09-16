/**
 * `AgentRunWorkflow` (D5, D7) — the ONE Workflow class, bound as `AGENT_RUN_WORKFLOW`; the agent
 * runtime IS the example workflow. The instance id starts as the run id (`enqueueRun` creates it
 * after the `agent_runs` row exists) and becomes `<runId>-r1`, `-r2`… if a park has to be restarted
 * on a lost instance (`nudgeOrRestartInstance`, T5). The steps — Workflows checkpoint between them:
 *   claim       → `claimRun` (row is the gate; a cancelled-while-queued run exits here)
 *   execute#N   → the whole tool loop INSIDE one step (`retries: 2`, `timeout: 10 minutes`); the
 *                 runtime rethrows only faults a retry can fix, and the retry re-claims through the
 *                 same row. `awaiting_input` back means a person now owes the run an answer
 *   resume#N    → `step.waitForEvent(AGENT_RESUME_EVENT)` — the durable park (issue #17). The
 *                 resolve route flips the row `awaiting_input → running` and THEN wakes us, so the
 *                 next `execute#N+1` re-enters `run()` from the top and finds the answer as a row
 *   expire#N    → nobody answered inside `AGENT_INTERRUPT_TIMEOUT`: settle `cancelled`, `error` NULL
 *   finish      → backstop settle + final nudge
 * **Every step name carries its round.** A step name is its identity to the platform: a fixed
 * `'execute'` called twice replays the first call's result, and the bug reads as "the agent ignored
 * my approval". `MAX_INTERRUPT_ROUNDS` bounds the loop — a correctness guard, not a capacity one
 * (the step budget is 10,000; 32 rounds is two steps each).
 * The loop body is un-step-shaped on purpose, and that is now a settled decision rather than a gap:
 * one `step.do` per model turn was investigated and rejected (`docs/CONCEPTS.md` §9 Known gaps has
 * the evidence). Short version — steps do not nest, so per-turn steps need `run()` to move outside
 * `step.do`, and Workflows replays everything outside a step, which would double the
 * `agent_run_events` timeline unless every emit and tool call got its own step. Meanwhile wall clock
 * per step is UNLIMITED (the 10 minutes below is our policy, raise it if a run needs longer), CPU
 * per step excludes I/O and goes to 300 s via `[limits] cpu_ms`, and resuming a retry at turn N is
 * what `agent_runs.checkpoint` already does.
 * Each step opens its OWN DB client and closes it in `finally` — Hyperdrive is the pool.
 * Exported from `src/worker.ts`, never from `api/index.ts`.
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowSleepDuration,
  type WorkflowStep,
} from 'cloudflare:workers'
import { AGENT_RESUME_EVENT, MAX_INTERRUPT_ROUNDS } from '@rocketflare/shared/ai/agents'
import { type AppConfig, loadConfig } from '../../config'
import { createDatabase, type Database, resolveDatabaseUrl } from '../../db/client'
import type { AgentRunParams } from '../services/agents/runs'
import {
  claimStep,
  EXECUTE_RETRIES,
  type ExecuteOutcome,
  executeRun,
  finishStep,
} from '../services/agents/runtime'
import type { AppBindings } from '../types'
import { loggerFor } from '../utils/core/logger'

/** One DB client per step, closed whatever happens (rule: `.claude/rules/cloudflare.md`). */
export async function withStepDatabase<T>(
  env: AppBindings,
  cfg: AppConfig,
  fn: (db: Database) => Promise<T>
): Promise<T> {
  const handle = createDatabase(
    resolveDatabaseUrl({
      HYPERDRIVE: env.HYPERDRIVE,
      PREVIEW_DATABASE_URL: cfg.PREVIEW_DATABASE_URL,
      DATABASE_URL: cfg.DATABASE_URL,
    })
  )
  try {
    return await fn(handle.db)
  } finally {
    await handle.close()
  }
}

export class AgentRunWorkflow extends WorkflowEntrypoint<AppBindings, AgentRunParams> {
  async run(event: WorkflowEvent<AgentRunParams>, step: WorkflowStep): Promise<ExecuteOutcome> {
    const params = event.payload
    const env = this.env
    const cfg = loadConfig(env)
    const logger = loggerFor(cfg, { handler: 'workflow', workflow: 'agent-run', ...params })

    const claimed = await step.do('claim', () =>
      withStepDatabase(env, cfg, db => claimStep(db, env, logger, params))
    )
    if (!claimed) return { runId: params.runId, status: 'skipped' }

    let outcome: ExecuteOutcome | undefined
    // One round per human decision: `execute#N` runs the agent, `resume#N` parks the INSTANCE on
    // the answer. The `#N` is not decoration — a Workflow step name is its identity, so a second
    // `step.do('execute')` would hand back the FIRST one's cached result and the run would look
    // like it had ignored the approval.
    for (let round = 0; ; round++) {
      try {
        outcome = await step.do(
          `execute#${round}`,
          {
            retries: { limit: EXECUTE_RETRIES, delay: '10 seconds', backoff: 'exponential' },
            timeout: '10 minutes',
          },
          () => withStepDatabase(env, cfg, db => executeRun(db, cfg, env, logger, params))
        )
      } catch (err) {
        // Past its retries (or a fault outside the runtime's classification): finish settles the
        // row. `outcome` is cleared deliberately — carrying a PREVIOUS round's `awaiting_input`
        // into the fall-through would tell `finish` the run is parked when it is not.
        logger.error({ err }, 'agent-run: execute step failed')
        outcome = undefined
        break
      }

      if (outcome.status !== 'awaiting_input') break

      if (round >= MAX_INTERRUPT_ROUNDS) {
        // A correctness guard, not a capacity one: an agent that asks the same question every
        // round would otherwise grow step state without bound inside one instance. The row is
        // parked here, and `finish` reads `status: 'failed'` in this outcome as "abandoned" —
        // failed with a sentence, not cancelled, because a runaway agent is a bug.
        outcome = {
          runId: params.runId,
          status: 'failed',
          error: `The agent asked for input more than ${MAX_INTERRUPT_ROUNDS} times without finishing`,
        }
        break
      }

      try {
        // The payload is ignored on purpose: the answer is already a row, written by the resolve
        // route before it woke us, and re-entering `execute` reads it (decision 2). The event is
        // a nudge. `AGENT_RESUME_EVENT` is a constant because a `.` in the type is rejected by
        // the platform with `workflow.invalid_event_type` (T8).
        await step.waitForEvent(`resume#${round}`, {
          type: AGENT_RESUME_EVENT,
          // `[vars]`, so a string: the platform parses it, and `WorkflowSleepDuration` is a
          // template-literal type no runtime value can satisfy structurally. A bad duration is a
          // deploy-time failure on the first park, which is what `.dev.vars.example` documents.
          timeout: cfg.AGENT_INTERRUPT_TIMEOUT as WorkflowSleepDuration,
        })
      } catch (err) {
        // Nobody answered inside `AGENT_INTERRUPT_TIMEOUT`. `finishStep`'s expiry arm settles the
        // parked row `cancelled` with `error` NULL — a cancel is a status, not a message.
        logger.info({ err, round }, 'agent-run: nobody answered, expiring the park')
        outcome = await step.do(`expire#${round}`, () =>
          withStepDatabase(env, cfg, db => finishStep(db, env, logger, params, outcome))
        )
        break
      }
    }

    return step.do('finish', () =>
      withStepDatabase(env, cfg, db => finishStep(db, env, logger, params, outcome))
    )
  }
}
