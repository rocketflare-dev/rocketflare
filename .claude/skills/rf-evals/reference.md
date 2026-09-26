# rf-evals reference

## Commands

| Command | What it does |
|---|---|
| `pnpm eval [suite…]` | Run the suites under `apps/evals/suites/` whose path contains the filter (all by default). Writes `apps/evals/.evals/runs/<ts>-<sha>.json`, prints the score/cost/latency table |
| `--case id,id` | Only these case ids (`EVAL_CASE`) |
| `--model <id>` | Pin the TARGET's model: an `agent_models` row per prompt key on each case's tenant |
| `--judge-model <id>` | Pin the JUDGE's model (`evals-judge` on the judge's tenant) |
| `--provider anthropic\|fireworks\|gemini` | The target's provider: `anthropic` = the platform key (default); the others write an encrypted `ai_configs` row (Fireworks = the kit's `fireworks` preset, Gemini = `openai_compatible`) from `FIREWORKS_API_KEY` / `GEMINI_API_KEY` in `.dev.vars` |
| `--judge-provider …` | The same for the judge |
| `--compare [baseline\|<run.json>]` | Diff against the committed baselines (default) or another run; exit 1 on a regression |
| `--threshold 0.1` | The per-judge drop that counts as a regression |
| `--concurrency 2` | Suite files run at once (`EVAL_CONCURRENCY`) — provider rate limits are the ceiling |
| `pnpm eval:baseline [suite…] [--from <run.json>]` | Write `apps/evals/baselines/<suite>.json` from the latest (or named) run |
| `pnpm eval:view [a.json [b.json]] [--compare …]` | Print the score diff (two runs, or the latest vs the one before / the baselines), then serve the vitest-evals report UI over the runs |
| `pnpm --filter @rocketflare/evals test` | The eval kit's own unit tests (no model, no DB) — in the gate |
| `pnpm cli feedback list [--rating up\|down] [--target message\|agent_run] [--json]` | The thumbs queue (admin+) |
| `pnpm cli evals promote <id> --dataset <name> [--run] [--id <caseId>] [--dir <path>] [--yes]` | Append a draft case from a real message or run (admin+). Refuses to write tenant data unconfirmed |

## `EvalCase` (`packages/shared/src/ai/evals.ts`)

```jsonc
{
  "id": "refund-window",                 // lowercase, unique in the dataset — baselines key on it
  "input": "How long do customers have to ask for a refund?",   // chat: a string; agent: its input object
  "messages": [{ "role": "user", "content": "…" }, { "role": "assistant", "content": "…" }],  // chat history, oldest first
  "context": [{ "title": "Refund policy", "text": "…" }],       // ingested into the case's own tenant first
  "expected": {
    "output": "…",                        // a reference answer (Reference judge)
    "rubric": "States the 30-day window…", // plain-language criteria (Rubric judge)
    "tools": ["search_knowledge"],        // the trajectory (Trajectory judge)
    "toolsMatch": "strict",               // strict | unordered | subset | superset — overrides the suite's mode
    "contains": ["30 days"]               // substrings, case-insensitive (Contains judge)
  },
  "tags": ["rag", "holdout"],
  "source": { "kind": "hand" },           // or { kind: 'message'|'agent_run', id, promotedAt, feedback }
  "agentKey": "research-topic"            // promoted run cases only
}
```

`"tools": [], "toolsMatch": "strict"` means "call no tool at all" (the greeting case).

## Judges (`apps/evals/kit/judges.ts`)

A judge is attached to a case only when the case declares something for it (`appliesTo`), because
vitest-evals averages a `null` score as 0. A case passes when the mean of its judges reaches the
suite threshold (0.7 by default).

| Judge | Kind | Reads | Score |
|---|---|---|---|
| `ContainsJudge()` | deterministic | `expected.contains` | fraction of substrings present |
| `MatchesJudge(regex)` | deterministic | the output | 1 / 0 |
| `SchemaJudge(zodSchema)` | deterministic | the output | 1 / 0, with the first issues |
| `TrajectoryJudge(mode)` | deterministic | `expected.tools`, `toolsMatch` | 1 / 0 — agentevals semantics: `strict` same order · `unordered` same multiset · `subset` nothing outside · `superset` at least these |
| `BudgetJudge({ maxMs, maxTokens, maxCostUsd })` | deterministic | usage, timing | 1 / 0 (unknown cost never fails) |
| `RubricJudge()` | LLM | `expected.rubric` + the material retrieved (else the case context) | pass 1 · partial 0.5 · fail 0 |
| `FaithfulnessJudge()` | LLM | what retrieval RETURNED (`artifacts.retrieved`) | supported / (supported + unsupported); nothing retrieved → 0 |
| `ReferenceJudge()` | LLM | `expected.output` | vitest-evals `FactualityJudge` (A 0.4 · B 0.6 · C 1 · D 0 · E 1) |

LLM judges run through `judgeHarness`, which calls the kit's resolver on the `evals-judge` prompt
key (so Settings → agent models, or `--judge-model`, picks the model). Every call is an `ai_usage`
row under feature `evals.judge` and a trace `invoke_agent evals-judge` with `rocketflare.eval=true`.
The scorers are plain functions in `kit/scoring.ts`. An app's own judge is
`{ name, assess(ctx), appliesTo? }`, where `ctx.input` is the case, `ctx.output` the answer,
`ctx.toolCalls` the calls and `ctx.run` the whole transcript.

## Targets (`apps/evals/kit/`)

| | How it runs | Transcript |
|---|---|---|
| `chatHarness()` | `POST /api/chat/conversations` → seed `messages` → `POST …/messages` in-process (the real route, `prepareChatTurn` included) | answer text, tool calls from AG-UI, `retrieved` from `search_knowledge` results, usage from `ai_usage` |
| `agentHarness(key)` | `enqueueRun` → `claimStep` → `executeRun` (retried up to `EXECUTE_RETRIES`) → `finishStep` inline, no Workflow binding | output, `tool.start`/`tool.end` events, `retrieved` (600-char passage previews), run status |

A run that parks on a person is settled `cancelled` by `finishStep` and scores as a miss.

## Run file

A vitest JSON report plus a `rocketflare` header: `{ sha, dirty, createdAt, filters, model,
modelsObserved, judgeModel, promptHashes: { <promptKey>: [hash] } }`. Per case:
`testResults[].assertionResults[]` → `title` (the case id), `status`, `meta.eval.{avgScore, scores[]}`
(each with `metadata.rationale`) and `meta.harness.run` (`session.events`, `usage`, `timings`,
`artifacts`).
