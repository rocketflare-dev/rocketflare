/**
 * What an eval run is configured with (D33). `scripts/eval.mjs` loads `apps/web/.env.test` (the
 * test database on :5433) and the AI keys from `apps/web/.dev.vars` into `process.env`, plus the
 * flags as `EVAL_*`; this module reads them once.
 *
 * Models resolve through the kit's own resolver, so a suite exercises the same chain production
 * does: the platform `ANTHROPIC_API_KEY`, pinned per prompt key through `agent_models` when
 * `--model` is given. Without a key there is nothing to evaluate, and every suite SKIPS with the
 * reason instead of failing — `createTestEnv` would otherwise hand the resolver the test `AI` stub,
 * which answers chat with canned text and would score as a real (and terrible) model.
 */
import { loadConfig } from '@/config'
import { createTestEnv, type TestEnv } from '../../web/tests/mocks/bindings'

export const EVAL_MODEL = process.env.EVAL_MODEL || undefined
export const EVAL_JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL || undefined

/** Why suites cannot run here, or null when a real chat model resolves. */
export function evalSkipReason(): string | null {
  if (!process.env.ANTHROPIC_API_KEY) {
    return 'no ANTHROPIC_API_KEY in apps/web/.dev.vars — evals need a real model (see docs/EVALS.md)'
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
 * half of hybrid search — fine for the kit's starter cases, noted in docs/EVALS.md.
 */
export function evalWorkerEnv(): TestEnv {
  return createTestEnv(process.env.EMBEDDINGS_API_KEY ? { AI: undefined } : {})
}

export function evalConfig(env: TestEnv = evalWorkerEnv()) {
  return loadConfig(env)
}
