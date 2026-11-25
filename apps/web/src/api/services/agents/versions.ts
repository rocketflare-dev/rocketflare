/**
 * Version pinning. Cloudflare Workflows cannot pin an instance to the code it started on, so a run
 * parked across a deploy — or retried after one — resumes under whatever is deployed. Each run
 * records the `meta.version` it runs under (`agent_runs.agent_version`) and the Worker deployment
 * it last ran on (`worker_version_id`, from the `[version_metadata]` binding); an attempt that
 * finds a different `meta.version` applies the agent's `onVersionChange`:
 *
 * - `continue` (the default) — carry on under the new version, sound because every key comes from
 *   recorded data; the row's version moves forward and a `status` event says so.
 * - `fail` — settle `failed`, code `agent_version_changed`. Forced for a `pinned` agent, whose keys
 *   come from ORDER and mean nothing to different code.
 * - `rerun` — cancel this run and start a NEW one of the same input under today's version. A new
 *   run rather than a wiped one: the old run's record (what it asked, what it was answered, what it
 *   spent) is an audit trail. The new run's idempotency key is derived from the old run's id, so a
 *   retried step starts it once.
 *
 * What it costs: nothing when the versions match — one integer comparison per attempt.
 */
import type { AgentMeta, AgentVersionChangePolicy } from '@rocketflare/shared/ai/agents'
import { ERROR_CODES } from '@rocketflare/shared/errors'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { type AgentRunRow, agentRuns } from '../../../db/schema'
import type { Logger } from '../../utils/core/logger'
import { expireInterrupts } from './interrupts'
import { type AgentRunsEnv, agentVersionOf, cancelRun, enqueueRun, failRun } from './runs'

/** The policy a run of this agent meets on a version change; `pinned` always fails. */
export function versionPolicyOf(meta: Pick<AgentMeta, 'pinned' | 'onVersionChange'>) {
  return meta.pinned ? 'fail' : (meta.onVersionChange ?? 'continue')
}

/**
 * Registry-time check: `pinned: true` with any `onVersionChange` but `fail` is a contradiction —
 * order-derived keys replayed against other code would hand calls each other's results.
 */
export function assertVersionMeta(meta: AgentMeta): void {
  const version = meta.version ?? 1
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`Agent "${meta.key}": meta.version must be a positive integer`)
  }
  if (meta.pinned && meta.onVersionChange && meta.onVersionChange !== 'fail') {
    throw new Error(
      `Agent "${meta.key}" is pinned, so onVersionChange must be 'fail' (got '${meta.onVersionChange}')`
    )
  }
}

type Emit = (event: { type: 'status' | 'error'; data: Record<string, unknown> }) => Promise<void>

export interface VersionCheck {
  /** Set when the run settled here; the attempt returns it without running the agent. */
  settled?: { status: 'failed' | 'cancelled'; error?: string }
  /** The policy applied, when the versions differed. */
  applied?: AgentVersionChangePolicy
}

/**
 * Run at the top of every `execute` attempt, before the agent runs. Records the Worker version,
 * and applies `onVersionChange` when the run recorded another `meta.version`.
 */
export async function checkRunVersion(
  db: Database,
  cfg: AppConfig,
  env: AgentRunsEnv & { CF_VERSION_METADATA?: { id: string } },
  logger: Logger,
  run: AgentRunRow,
  meta: AgentMeta,
  emit: Emit
): Promise<VersionCheck> {
  const workerVersionId = env.CF_VERSION_METADATA?.id ?? null
  const current = agentVersionOf(meta)
  if (run.agentVersion === current) {
    if (workerVersionId && workerVersionId !== run.workerVersionId) {
      await setVersions(db, run, { workerVersionId })
    }
    return {}
  }
  const policy = versionPolicyOf(meta)
  const change = { fromVersion: run.agentVersion, toVersion: current }
  logger.info({ runId: run.id, ...change, policy }, 'agent-run: agent version changed')
  if (policy === 'continue') {
    await setVersions(db, run, { agentVersion: current, workerVersionId })
    await emit({
      type: 'status',
      data: { status: 'running', reason: 'version_changed', ...change },
    })
    return { applied: policy }
  }
  if (policy === 'fail') {
    const message = `The agent changed from version ${change.fromVersion} to ${change.toVersion} while this run was in flight, and it does not continue across versions`
    await failRun(db, run.tenantId, run.id, message)
    await expireInterrupts(db, run.tenantId, run.id)
    await emit({
      type: 'error',
      data: { message, willRetry: false, code: ERROR_CODES.agentVersionChanged, details: change },
    })
    await emit({ type: 'status', data: { status: 'failed' } })
    return { applied: policy, settled: { status: 'failed', error: message } }
  }
  // `rerun`: cancel FIRST, so an exclusive agent's slot is free for the new run.
  await cancelRun(db, run.tenantId, run.id)
  await expireInterrupts(db, run.tenantId, run.id)
  let rerunRunId: string | undefined
  try {
    const { run: next } = await enqueueRun(db, cfg, env, {
      tenantId: run.tenantId,
      agentKey: meta.key,
      input: run.input,
      userId: run.requestedByUserId,
      inputFromRequester: run.inputFromRequester,
      idempotencyKey: `rerun:${run.id}`,
      ...(run.parentRunId && { parentRunId: run.parentRunId }),
      ...(run.budget && { budget: run.budget }),
    })
    rerunRunId = next.id
  } catch (err) {
    logger.warn({ err, runId: run.id }, 'agent-run: could not start the rerun')
  }
  await emit({
    type: 'status',
    data: { status: 'cancelled', reason: 'version_rerun', ...change, rerunRunId },
  })
  return { applied: policy, settled: { status: 'cancelled' } }
}

async function setVersions(
  db: Database,
  run: AgentRunRow,
  values: { agentVersion?: number; workerVersionId?: string | null }
): Promise<void> {
  await db
    .update(agentRuns)
    .set({
      ...(values.agentVersion !== undefined && { agentVersion: values.agentVersion }),
      ...(values.workerVersionId && { workerVersionId: values.workerVersionId }),
    })
    .where(and(eq(agentRuns.id, run.id), eq(agentRuns.tenantId, run.tenantId)))
}
