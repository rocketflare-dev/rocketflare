/**
 * `AgentRunWorkflow` (D5, D7) — the ONE Workflow class, bound as `AGENT_RUN_WORKFLOW`; the agent
 * runtime IS the example workflow. Instance id = run id (deterministic; `enqueueRun` creates it
 * after the `agent_runs` row exists). Three steps — Workflows checkpoint between them:
 *   claim   → `claimRun` (row is the gate; a cancelled-while-queued run exits here)
 *   execute → the whole tool loop INSIDE one step (`retries: 2`, `timeout: 10 minutes`); the runtime
 *             rethrows only faults a retry can fix, and the retry re-claims through the same row
 *   finish  → backstop settle + final nudge
 * v1 keeps the loop body un-step-shaped on purpose; the scaling path (documented, not built) is one
 * `step.do` per model turn with the transcript persisted between them (09 (g) 1). Each step opens
 * its OWN DB client and closes it in `finally` — Hyperdrive is the pool. CPU is bounded PER STEP by
 * `[limits] cpu_ms`. Exported from `src/worker.ts`, never from `api/index.ts`.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
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
    try {
      outcome = await step.do(
        'execute',
        {
          retries: { limit: EXECUTE_RETRIES, delay: '10 seconds', backoff: 'exponential' },
          timeout: '10 minutes',
        },
        () => withStepDatabase(env, cfg, db => executeRun(db, cfg, env, logger, params))
      )
    } catch (err) {
      // Past its retries (or a fault outside the runtime's classification): finish settles the row.
      logger.error({ err }, 'agent-run: execute step failed')
    }

    return step.do('finish', () =>
      withStepDatabase(env, cfg, db => finishStep(db, env, logger, params, outcome))
    )
  }
}
