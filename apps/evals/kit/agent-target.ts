/**
 * The agent target (D33): one case → one real agent run, IN-PROCESS, through the real runtime —
 * `enqueueRun` (the row, validated input), then the three Workflow step bodies inline (`claimStep` →
 * `executeRun` → `finishStep`) exactly as `AgentRunWorkflow` calls them, with no Workflow binding.
 * `executeRun` throws only to ask for a step retry, so it is retried here up to the same limit the
 * Workflow gives it (`EXECUTE_RETRIES`).
 *
 * A run that PARKS on a person (`ask_human`, an approval) cannot be answered by an eval: the final
 * `finishStep` settles it `cancelled`, the output is null, and the judges score it as the miss it
 * is. The transcript is built from `agent_run_events`, the same rows the run page and the AG-UI
 * projection read.
 */
import type { AgentKey } from '@rocketflare/shared/ai/agents'
import type { EvalCase } from '@rocketflare/shared/ai/evals'
import { and, asc, eq } from 'drizzle-orm'
import { createHarness, type Harness, type JsonValue } from 'vitest-evals'
import { withEvalScope } from '@/api/observability/context'
import { getAgent } from '@/api/services/agents/registry'
import { enqueueRun, getRun } from '@/api/services/agents/runs'
import {
  claimStep,
  EXECUTE_RETRIES,
  type ExecuteOutcome,
  executeRun,
  finishStep,
} from '@/api/services/agents/runtime'
import { resolvePrompt } from '@/api/services/prompts'
import { loggerFor } from '@/api/utils/core/logger'
import { agentRunEvents } from '@/db/schema'
import { caseWorld } from './fixtures'
import { promptHash, tenantSpend } from './spend'
import { transcriptFromRunEvents } from './transcript'

export function agentHarness(agentKey: AgentKey): Harness<EvalCase, JsonValue | undefined> {
  return createHarness<EvalCase, JsonValue | undefined>({
    name: `rocketflare-agent:${agentKey}`,
    run: async ({ input: evalCase }) => {
      const agent = getAgent(agentKey)
      const world = await caseWorld(evalCase, [agent.meta.promptKey])
      const logger = loggerFor(world.cfg, { eval: evalCase.id })
      const started = Date.now()
      const runId = await withEvalScope(async () => {
        const { run } = await enqueueRun(world.db, world.env, {
          tenantId: world.tenantId,
          agentKey,
          input: evalCase.input,
          userId: world.userId,
        })
        const params = { runId: run.id, tenantId: world.tenantId }
        let outcome: ExecuteOutcome | undefined
        if (await claimStep(world.db, world.env, logger, params)) {
          for (let attempt = 0; attempt <= EXECUTE_RETRIES && !outcome; attempt++) {
            try {
              outcome = await executeRun(world.db, world.cfg, world.env, logger, params, {
                round: 0,
              })
            } catch (err) {
              if (attempt === EXECUTE_RETRIES) throw err
            }
          }
        }
        await finishStep(world.db, world.env, logger, params, outcome, { cfg: world.cfg })
        return run.id
      })
      const totalMs = Date.now() - started

      const row = await getRun(world.db, world.tenantId, runId)
      if (!row) throw new Error(`agent run ${runId} vanished`)
      if (row.status === 'failed') throw new Error(`agent run failed: ${row.error ?? 'no reason'}`)
      const events = await world.db
        .select({ type: agentRunEvents.type, data: agentRunEvents.data })
        .from(agentRunEvents)
        .where(and(eq(agentRunEvents.tenantId, world.tenantId), eq(agentRunEvents.runId, runId)))
        .orderBy(asc(agentRunEvents.seq))
      const output = (row.output ?? undefined) as JsonValue | undefined
      const transcript = transcriptFromRunEvents(events, row.input, output, row.error)
      const prompt = await resolvePrompt(world.db, world.tenantId, agent.meta.promptKey as 'chat', {
        appName: world.cfg.APP_NAME,
        tenantName: world.tenantName,
      })
      return {
        output,
        events: transcript.events,
        usage: {
          toolCalls: transcript.toolCalls.length,
          ...(await tenantSpend(world.db, world.tenantId)),
        },
        timings: { totalMs },
        artifacts: {
          retrieved: transcript.retrieved,
          status: row.status,
          runId,
          promptKey: agent.meta.promptKey,
          promptHash: promptHash(prompt),
        },
      }
    },
  })
}
