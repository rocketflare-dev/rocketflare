/**
 * What an eval run is configured with. `scripts/eval.mjs` loads `apps/web/.env.test` (the
 * test database on :5433) and the AI keys from `apps/web/.dev.vars` into `process.env`, plus the
 * flags as `EVAL_*`; this module reads them once.
 *
 * Models resolve through the app's own resolver, so a suite exercises the same chain production
 * does: the platform `ANTHROPIC_API_KEY`, pinned per prompt key through `agent_models` when
 * `--model` is given. Without a key there is nothing to evaluate, and every suite SKIPS with the
 * reason instead of failing — `createTestEnv` would otherwise hand the resolver the test `AI` stub,
 * which answers chat with canned text and would score as a real (and terrible) model.
 * `--provider fireworks|gemini` puts the target on a tenant `ai_configs` row instead
 * (`providers.ts`); `--judge-provider` does the same for the judge.
 */
import { loadConfig } from '@/config'
import { createTestEnv, type TestEnv } from '../../web/tests/mocks/bindings'
import { evalProvider, evalReranker } from './providers'

export const EVAL_MODEL = process.env.EVAL_MODEL || undefined
export const EVAL_JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL || undefined
/** `--provider` / `--judge-provider`: `anthropic` (default, the platform key), `fireworks`, `gemini`. */
export const EVAL_PROVIDER = evalProvider(process.env.EVAL_PROVIDER)
export const EVAL_JUDGE_PROVIDER = evalProvider(process.env.EVAL_JUDGE_PROVIDER)
/**
 * `--rerank none|fireworks`: which reranker knowledge search uses. `none` (the default) searches
 * with `rerank: false`, because the test `AI` stub answers reranks in fused order and would only
 * add noise; `fireworks` writes a tenant `rerank` row (`useRerank`) on FIREWORKS_API_KEY.
 */
export const EVAL_RERANK = evalReranker(process.env.EVAL_RERANK)

/** Why suites cannot run here, or null when both the target's and the judge's models resolve. */
export function evalSkipReason(): string | null {
  for (const provider of new Set([EVAL_PROVIDER, EVAL_JUDGE_PROVIDER])) {
    if (!process.env[provider.keyEnv]) {
      return `no ${provider.keyEnv} in apps/web/.dev.vars — the ${provider.name} provider needs it (see docs/EVALS.md)`
    }
  }
  return null
}

let warned = false

/** `describeEval({ skipIf: skipEvals })` — says WHY once per file, rather than skipping in silence. */
export function skipEvals(): boolean {
  const reason = evalSkipReason()
  if (reason && !warned) {
    warned = true
    console.warn(`evals skipped: ${reason}`)
  }
  return reason !== null
}

/**
 * The Worker env a target runs against: the test bindings, with the real keys `createTestEnv`
 * copies from `process.env`. With `EMBEDDINGS_API_KEY` the `AI` stub is dropped so retrieval embeds
 * for real; without it the stub's deterministic vectors apply and retrieval leans on the lexical
 * half of hybrid search — fine for the starter cases, noted in docs/EVALS.md.
 */
export function evalWorkerEnv(): TestEnv {
  // `RERANK_CANDIDATES=20 pnpm eval retrieval --rerank …` — `createTestEnv` copies only the vars it
  // names, so a tuning knob an eval compares has to be handed over here.
  const tuning = process.env.RERANK_CANDIDATES
    ? { RERANK_CANDIDATES: process.env.RERANK_CANDIDATES }
    : {}
  if (EVAL_RERANK === 'workers-ai') return createTestEnv({ ...tuning, AI: workersAiRestBinding() })
  return createTestEnv({ ...tuning, ...(process.env.EMBEDDINGS_API_KEY ? { AI: undefined } : {}) })
}

/**
 * `--rerank workers-ai`: an `AI` binding whose `run` is Workers AI's REST API — the same models,
 * reached from Node. Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (a token with Workers
 * AI access; `docs/EVALS.md`). Only `run` exists: the eval needs nothing else from the binding.
 */
export function workersAiRestBinding(): Ai {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!account || !token) {
    throw new Error('--rerank workers-ai needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN')
  }
  const run = async (model: string, inputs: unknown) => {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(inputs),
      }
    )
    const body = (await res.json()) as { success?: boolean; result?: unknown; errors?: unknown }
    if (!res.ok || body.success === false) {
      throw new Error(`Workers AI ${model}: ${res.status} ${JSON.stringify(body.errors ?? body)}`)
    }
    return body.result
  }
  return { run } as unknown as Ai
}

export function evalConfig(env: TestEnv = evalWorkerEnv()) {
  return loadConfig(env)
}
