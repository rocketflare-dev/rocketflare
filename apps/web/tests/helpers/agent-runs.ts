/**
 * Drive one agent run to its end in-process — the Workflow's claim and execute steps, called
 * directly — and return the settled row. For a test that wants a real run of a real agent (its
 * tools built from every unit, bound to the requester) without the Workflow harness. A model-free
 * agent needs nothing else; an agent that calls a model needs a scripted client
 * (`scriptPlatformChat`).
 */
import { enqueueRun, getRun } from '@/api/services/agents/runs'
import { claimStep, executeRun } from '@/api/services/agents/runtime'
import { loggerFor } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import type { Database } from '@/db/client'
import type { TestEnv } from '../mocks/bindings'

export interface RunAgentOptions {
  tenantId: string
  agentKey: string
  input: unknown
  /** Who the run is for; its tools answer what this person may read. Null = a system run. */
  userId?: string | null
}

export async function runAgent(env: TestEnv, db: Database, options: RunAgentOptions) {
  const cfg = loadConfig(env)
  const logger = loggerFor(cfg, { test: 'runAgent' })
  const { run } = await enqueueRun(db, cfg, env, {
    tenantId: options.tenantId,
    agentKey: options.agentKey as never,
    input: options.input,
    userId: options.userId ?? null,
  })
  const params = { runId: run.id, tenantId: options.tenantId }
  await claimStep(db, env, logger, params)
  const outcome = await executeRun(db, cfg, env, logger, params)
  const row = await getRun(db, options.tenantId, run.id)
  if (!row) throw new Error('runAgent: the run vanished')
  return { outcome, run: row }
}
