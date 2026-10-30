/**
 * Run metering and budgets. Every model call and decision an agent run makes goes through ONE
 * meter, which does two things in order:
 *
 *   check   before the call — the run's tokens and cost so far against its budget
 *           (`meta.budget` over `AGENT_RUN_MAX_TOKENS` / `AGENT_RUN_MAX_COST_USD`), then the
 *           tenant's agent spend today against `AGENT_TENANT_DAILY_COST_USD`. Over → throw
 *           `AgentBudgetExceededError`, which the runtime settles `failed` with event code
 *           `agent_budget_exceeded`. Never retried: a retry would only spend more.
 *   record  after the call — one `ai_usage` row carrying the run id, AWAITED (the next check must
 *           see it), and added to the meter's running total.
 *
 * The meter starts from `runSpend` — every attempt's rows — so a retried or resumed `execute` step
 * carries the budget across attempts rather than starting it again.
 *
 * A budget is checked BEFORE a call, so a run can overshoot by what its last call cost — and, under
 * `ctx.map`, by the calls already in flight. It is a brake, not an invoice. TypeSafe decisions are
 * unpriced, so they count toward the token budget only.
 */
import type { AgentBudget } from '@rocketflare/shared/ai/agents'
import type { TokenUsage } from '@rocketflare/shared/ai/chat'
import type { AiProvider } from '@rocketflare/shared/ai/config'
import { MICROCENTS_PER_USD } from '@rocketflare/shared/ai/pricing'
import { ERROR_CODES } from '@rocketflare/shared/errors'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { ApiError } from '../../utils/core/errors'
import type { Logger } from '../../utils/core/logger'
import type { ChatClient } from '../ai/types'
import { type RunSpend, recordUsage, runSpend, tenantAgentSpendToday } from '../ai/usage'

/** The caps one run is held to. Absent = no cap on that axis. */
export interface RunBudget {
  maxTokens?: number
  maxCostMicrocents?: number
  tenantDailyMicrocents?: number
}

export type BudgetLimit = 'run_tokens' | 'run_cost' | 'tenant_daily_cost'

/** A run reached a cap. A TYPE, so no message can reclassify it — and never retryable. */
export class AgentBudgetExceededError extends Error {
  readonly code = ERROR_CODES.agentBudgetExceeded
  constructor(
    readonly limit: BudgetLimit,
    readonly used: number,
    readonly max: number
  ) {
    super(budgetMessage(limit, used, max))
    this.name = 'AgentBudgetExceededError'
  }
}

/** 429 `ai_budget_exceeded`: the tenant's agent spend today has reached its cap. */
export class TenantBudgetExceededError extends ApiError {
  constructor(usedMicrocents: number, maxMicrocents: number) {
    super(
      429,
      budgetMessage('tenant_daily_cost', usedMicrocents, maxMicrocents),
      ERROR_CODES.aiBudgetExceeded,
      {
        usedUsd: usdOf(usedMicrocents),
        maxUsd: usdOf(maxMicrocents),
      }
    )
    this.name = 'TenantBudgetExceededError'
  }
}

const usdOf = (microcents: number) => microcents / MICROCENTS_PER_USD
const microcentsOf = (usd: number | undefined) =>
  usd === undefined ? undefined : Math.round(usd * MICROCENTS_PER_USD)

function budgetMessage(limit: BudgetLimit, used: number, max: number): string {
  if (limit === 'run_tokens') {
    return `The run reached its token budget (${used} of ${max} tokens)`
  }
  const money = `$${usdOf(used).toFixed(4)} of $${usdOf(max).toFixed(4)}`
  return limit === 'run_cost'
    ? `The run reached its cost budget (${money})`
    : `This organisation's agent spend today has reached its cap (${money})`
}

/** The deployment's caps, with the agent's own `meta.budget` taking precedence per axis. */
export function budgetFor(cfg: AppConfig, agentBudget?: AgentBudget): RunBudget {
  return {
    maxTokens: agentBudget?.maxTokens ?? cfg.AGENT_RUN_MAX_TOKENS,
    maxCostMicrocents: microcentsOf(agentBudget?.maxCostUsd ?? cfg.AGENT_RUN_MAX_COST_USD),
    tenantDailyMicrocents: microcentsOf(cfg.AGENT_TENANT_DAILY_COST_USD),
  }
}

/** The enqueue-time check: 429 when the tenant's agent spend today is at its cap. */
export async function assertTenantDailyBudget(
  db: Database,
  cfg: AppConfig,
  tenantId: string
): Promise<void> {
  const max = microcentsOf(cfg.AGENT_TENANT_DAILY_COST_USD)
  if (max === undefined) return
  const used = await tenantAgentSpendToday(db, tenantId)
  if (used >= max) throw new TenantBudgetExceededError(used, max)
}

export interface MeteredCall {
  provider: AiProvider
  model: string
  usage: TokenUsage
  /** Default `agent:<key>`. */
  feature?: string
}

export interface RunMeter {
  /** Throws `AgentBudgetExceededError` when the run (or the tenant today) is at a cap. */
  check(): Promise<void>
  /** One `ai_usage` row with the run id, awaited; a failed write is logged, never fatal. */
  record(call: MeteredCall): Promise<void>
  /** What the run has spent, every attempt included. */
  spent(): RunSpend
}

export interface RunMeterDeps {
  db: Database
  tenantId: string
  runId: string
  userId: string | null
  agentKey: string
  budget: RunBudget
  logger: Logger
}

export async function createRunMeter(deps: RunMeterDeps): Promise<RunMeter> {
  const { db, tenantId, runId, budget } = deps
  const spend = await runSpend(db, tenantId, runId)
  return {
    async check() {
      const tokens = spend.inputTokens + spend.outputTokens
      if (budget.maxTokens !== undefined && tokens >= budget.maxTokens) {
        throw new AgentBudgetExceededError('run_tokens', tokens, budget.maxTokens)
      }
      if (
        budget.maxCostMicrocents !== undefined &&
        spend.costMicrocents >= budget.maxCostMicrocents
      ) {
        throw new AgentBudgetExceededError(
          'run_cost',
          spend.costMicrocents,
          budget.maxCostMicrocents
        )
      }
      if (budget.tenantDailyMicrocents !== undefined) {
        const today = await tenantAgentSpendToday(db, tenantId)
        if (today >= budget.tenantDailyMicrocents) {
          throw new AgentBudgetExceededError(
            'tenant_daily_cost',
            today,
            budget.tenantDailyMicrocents
          )
        }
      }
    },
    async record(call) {
      // Counted BEFORE the write: a ledger outage must not let the run spend past its budget.
      spend.calls += 1
      spend.inputTokens += call.usage.inputTokens
      spend.outputTokens += call.usage.outputTokens
      try {
        const cost = await recordUsage(db, {
          tenantId,
          userId: deps.userId,
          agentRunId: runId,
          feature: call.feature ?? `agent:${deps.agentKey}`,
          provider: call.provider,
          model: call.model,
          usage: call.usage,
        })
        spend.costMicrocents += cost ?? 0
      } catch (err) {
        deps.logger.warn({ err, runId }, 'agent-run: usage write failed')
      }
    },
    spent: () => ({ ...spend }),
  }
}

/**
 * The run's chat client, metered: `check()` before every `complete`/`stream`, `record()` after it.
 * This is why an agent no longer writes its own ledger rows — every call through `ctx.chat.client`
 * is one row, turn by turn, including the turns of a tool loop that is later cancelled.
 */
export function meterChatClient(client: ChatClient, meter: RunMeter): ChatClient {
  return {
    provider: client.provider,
    countTokens: client.countTokens?.bind(client),
    async complete(params) {
      await meter.check()
      const result = await client.complete(params)
      await meter.record({ provider: client.provider, model: result.model, usage: result.usage })
      return result
    },
    async *stream(params) {
      await meter.check()
      for await (const delta of client.stream(params)) {
        if (delta.type === 'end') {
          await meter.record({
            provider: client.provider,
            model: delta.result.model,
            usage: delta.result.usage,
          })
        }
        yield delta
      }
    },
  }
}
