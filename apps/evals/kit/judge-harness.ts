/**
 * The judge model (D33), as a vitest-evals `JudgeHarness`. Every LLM judge — ours and vitest-evals'
 * own `FactualityJudge` — calls through here, and here calls through the KIT:
 *
 * - the client comes from `resolveChat(..., { promptKey: 'evals-judge' })`, so Settings → agent
 *   models can pin the judge like any agent, `--judge-model` pins it for one run (an
 *   `agent_models` row on the judge's own tenant) and `--judge-provider fireworks|gemini` moves it
 *   to another provider (an `ai_configs` row there);
 * - the system prompt is the `evals-judge` registry entry followed by the judge's own instructions;
 * - every call is costed in `ai_usage` under feature `evals.judge` and traced (`invoke_agent
 *   evals-judge`, marked `rocketflare.eval=true`).
 *
 * The judge runs in ONE tenant per process, separate from the cases' tenants, so a case's spend
 * never includes the judging of it.
 */
import { createJudgeHarness, type JsonValue } from 'vitest-evals'
import { withEvalScope } from '@/api/observability/context'
import { databaseSpanStore } from '@/api/observability/span-store'
import { traceChatClient, tracerFor, withAgentTrace } from '@/api/observability/tracing'
import { resolveChat } from '@/api/services/ai/resolve'
import { recordUsage } from '@/api/services/ai/usage'
import { resolvePrompt } from '@/api/services/prompts'
import { agentModels } from '@/db/schema'
import { createTestTenant } from '../../web/tests/helpers/auth'
import { EVAL_JUDGE_MODEL, EVAL_JUDGE_PROVIDER, evalConfig, evalWorkerEnv } from './env'
import { evalDb } from './fixtures'
import { useProvider } from './providers'
import { JUDGE_FEATURE } from './spend'

let judgeTenant: Promise<string> | undefined

function judgeTenantId(): Promise<string> {
  judgeTenant ??= (async () => {
    const db = evalDb()
    const tenant = await createTestTenant(db, { name: 'Eval judge' })
    await useProvider(db, evalConfig(), tenant.id, EVAL_JUDGE_PROVIDER, EVAL_JUDGE_MODEL)
    if (EVAL_JUDGE_MODEL) {
      await db
        .insert(agentModels)
        .values({ tenantId: tenant.id, promptKey: 'evals-judge', model: EVAL_JUDGE_MODEL })
    }
    return tenant.id
  })()
  return judgeTenant
}

/** A judge's reply as JSON: bare, fenced, or the outermost `{…}` in surrounding prose. */
export function parseJudgeJson(text: string): JsonValue | string {
  const attempts = [text, text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]]
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) attempts.push(text.slice(start, end + 1))
  for (const candidate of attempts) {
    if (!candidate) continue
    try {
      return JSON.parse(candidate) as JsonValue
    } catch {
      // try the next shape
    }
  }
  return text
}

export const judgeHarness = createJudgeHarness({
  name: 'rocketflare-judge',
  run: async ({ system, prompt, responseFormat }) => {
    const db = evalDb()
    const env = evalWorkerEnv()
    const cfg = evalConfig(env)
    const tenantId = await judgeTenantId()
    const resolved = await resolveChat(db, cfg, env, tenantId, { promptKey: 'evals-judge' })
    const base = await resolvePrompt(db, tenantId, 'evals-judge', { appName: cfg.APP_NAME })
    const tracer = tracerFor(cfg, { store: databaseSpanStore(db) })
    const json = responseFormat?.type === 'json'
    const result = await withEvalScope(() =>
      withAgentTrace(
        'evals-judge',
        { tracer, tenantId, tags: ['eval', 'judge'], metadata: { model: resolved.model } },
        trace =>
          traceChatClient(resolved.client, trace, { provider: resolved.provider }, tracer).complete(
            {
              model: resolved.model,
              maxTokens: 1024,
              temperature: 0,
              system: system ? `${base}\n\n${system}` : base,
              messages: [
                {
                  role: 'user',
                  content: json ? `${prompt}\n\nRespond with a single JSON object only.` : prompt,
                },
              ],
            }
          )
      )
    )
    await tracer.flush()
    await recordUsage(db, {
      tenantId,
      feature: JUDGE_FEATURE,
      provider: resolved.provider,
      model: result.model,
      usage: result.usage,
    })
    const text = result.content
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim()
    return json ? parseJudgeJson(text) : text
  },
})
