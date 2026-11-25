/**
 * Child runs (D44 phase 3): `ctx.spawn(key, agentKey, input)` starts ANOTHER agent as a run of its
 * own — its own Workflow instance, its own 10-minute attempts, its own record — with
 * `parent_run_id` pointing back. Inline composition (calling the other agent's body, or a
 * `ctx.map`) stays the default for short sub-tasks; a child is for one that would not fit in the
 * parent's attempt.
 *
 * - **Keyed like everything else.** The child's id is derived from the parent's id and `key`
 *   (`enqueueRun`'s idempotency key `spawn:<runId>:<key>`), so a retried or resumed parent finds
 *   the SAME child rather than starting another. Its settled output is recorded as the effect
 *   `spawn:<key>`, which is what replay serves.
 * - **The parent parks on it** through the same machinery a person's answer uses: a child still
 *   going throws {@link ChildRunPending}; the runtime parks the parent (`awaiting_input` with no
 *   pending ask, which the sweeper and the inbox already read as "waiting on something that is not
 *   a person") and the child's settle — or the sweeper — wakes it (`wakeParent`). A parked parent
 *   costs nothing while it waits.
 * - **Budget.** The child's cap is what the parent could still spend when it was spawned
 *   (`remainingBudget`), and the parent's meter counts every descendant's spend, so the two can
 *   never spend past the parent's budget together.
 * - **Cancel cascades** (`cancelChildren`) — a cancel of the parent cancels every active child, and
 *   a parent that settles any other way than success takes its active children with it.
 * - **Visibility.** A child is reached through its parent: the runs list leaves it out
 *   (`?parentRunId=` lists one run's children), and it carries the parent's requester.
 * - **Traces link** by attribute: the child's spans carry `rocketflare.parent_run_id` and
 *   `rocketflare.parent_trace_id`.
 */
import type { AgentKey } from '@rocketflare/shared/ai/agents'
import { isRunActive } from '@rocketflare/shared/ai/agents'
import { ERROR_CODES } from '@rocketflare/shared/errors'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { type AgentRunRow, agentRuns } from '../../../db/schema'
import type { Logger } from '../../utils/core/logger'
import type { Realtime } from '../realtime'
import { type RunMeter, remainingBudget } from './budget'
import {
  type AgentRunsEnv,
  enqueueRun,
  getRun,
  idempotentRunId,
  requestCancel,
  runOnce,
} from './runs'

export { wakeParent } from './runs'

/** Thrown by `ctx.spawn` while the child is still going: the runtime parks the parent on it. */
export class ChildRunPending extends Error {
  constructor(readonly childRunId: string) {
    super(`Waiting on child run ${childRunId}`)
    this.name = 'ChildRunPending'
  }
}

/** The child settled without succeeding. Catch it to carry on; uncaught, the parent fails. */
export class ChildRunFailedError extends Error {
  readonly code = ERROR_CODES.agentChildFailed
  constructor(
    readonly childRunId: string,
    readonly childStatus: 'failed' | 'cancelled',
    readonly childError: string | null
  ) {
    super(
      childStatus === 'cancelled'
        ? `Child run ${childRunId} was cancelled`
        : `Child run ${childRunId} failed: ${childError ?? 'no reason given'}`
    )
    this.name = 'ChildRunFailedError'
  }
}

export interface SpawnDeps {
  db: Database
  cfg: AppConfig
  env: AgentRunsEnv
  run: AgentRunRow
  meter: RunMeter
  logger: Logger
}

/**
 * The runtime's `ctx.spawn`, plus `settled()` — what the catch arm awaits before it parks, so a
 * `Promise.all` of spawns has created every child (each one rejects, and the first rejection
 * would otherwise park while the others are still being created).
 */
export function createSpawn(deps: SpawnDeps) {
  const { db, cfg, env, run, meter } = deps
  const inflight: Promise<unknown>[] = []
  const spawn = async <Output = unknown>(
    key: string,
    agentKey: AgentKey,
    input: unknown
  ): Promise<Output> => {
    const work = (async () => {
      const effectKey = `spawn:${key}`
      const childId = await idempotentRunId(run.tenantId, agentKey, `spawn:${run.id}:${key}`)
      let child = await getRun(db, run.tenantId, childId)
      if (!child) {
        // Before the child exists: a parent already at its budget must not hand out a share of
        // nothing — the child would fail on its first call anyway, having cost a run.
        await meter.check()
        child = (
          await enqueueRun(db, cfg, env, {
            tenantId: run.tenantId,
            agentKey,
            input,
            userId: run.requestedByUserId,
            idempotencyKey: `spawn:${run.id}:${key}`,
            parentRunId: run.id,
            budget: remainingBudget(meter.budget, meter.spent()),
          })
        ).run
      }
      if (child.status === 'succeeded') {
        return (await runOnce(
          db,
          run.tenantId,
          run.id,
          effectKey,
          async () => child.output
        )) as Output
      }
      if (child.status === 'failed' || child.status === 'cancelled') {
        throw new ChildRunFailedError(child.id, child.status, child.error)
      }
      throw new ChildRunPending(child.id)
    })()
    inflight.push(work.catch(() => {}))
    return work
  }
  return { spawn, settled: () => Promise.allSettled(inflight) }
}

/** The active children of a run. */
export async function activeChildren(
  db: Database,
  tenantId: string,
  parentRunId: string
): Promise<AgentRunRow[]> {
  const children = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.tenantId, tenantId), eq(agentRuns.parentRunId, parentRunId)))
  return children.filter(child => isRunActive(child.status))
}

/** Cancel every active child of a run (and, through `requestCancel`, theirs). */
export async function cancelChildren(
  db: Database,
  env: AgentRunsEnv,
  tenantId: string,
  parentRunId: string,
  realtime?: Realtime
): Promise<number> {
  const children = await activeChildren(db, tenantId, parentRunId)
  for (const child of children) await requestCancel(db, tenantId, child.id, realtime, env)
  return children.length
}
