# Evals — how-to

Developer-run eval suites for the kit's chat and agents (D33; the rules and known gaps are in
`docs/CONCEPTS.md` §9). They answer one question: **did a prompt, model, tool or retrieval change
make answers better or worse?** They run locally with `pnpm eval`, cost real tokens, and are
**never part of the gate**. The `rf-evals` skill drives every step below and coaches as it goes.

## Setup

1. `pnpm test:db:up`. Evals use the TEST database (:5433, `apps/web/.env.test`) and migrate it
   themselves. They never truncate it, so a test run and an eval run can share it.
2. Put `ANTHROPIC_API_KEY` in `apps/web/.dev.vars`. It's the only key the target and the judge need:
   both resolve through the kit's own resolver, on the platform tier. With no key, every suite
   **skips** and says why. `EMBEDDINGS_API_KEY` is optional. Without it, retrieval uses the test
   stub's deterministic vectors and leans on the lexical half of hybrid search. That's enough for
   the starter cases, which share vocabulary with their documents.
3. `pnpm eval`. The first run takes a minute or two for the three starter suites (12 cases).

Only the model, embeddings and tracing keys are read from `.dev.vars`. A variable in the environment
(CI's secret) wins over both files. If `LANGFUSE_*` or `OTEL_EXPORTER_OTLP_*` keys are set, eval
traces are exported too, tagged `rocketflare.eval=true`.

## Layout

```
apps/evals/
  kit/            targets (chat, agent), judges, the judge harness, datasets, scoring — import from '../../kit'
  suites/<surface>/<name>.eval.ts     one describeCases(...) per suite
  datasets/<name>.jsonl               one EvalCase per line (packages/shared/src/ai/evals.ts)
  baselines/<suite>.json              committed scores of a known-good run
  .evals/runs/<ts>-<sha>.json         every run's full report (git-ignored)
  tests/          the kit's own unit tests — in the gate
```

It is its own workspace package because vitest-evals needs vitest 4 while `apps/web` is on vitest 3.
The targets import `apps/web` source in-process through the same `@/` alias.

## Write a suite

```ts
// apps/evals/suites/agents/triage-ticket.eval.ts
import { triageTicketOutputSchema } from '@rocketflare/shared/ai/agents'
import { agentHarness, ContainsJudge, describeCases, loadDataset, RubricJudge, SchemaJudge } from '../../kit'

describeCases('agent · triage-ticket', {
  harness: agentHarness('triage-ticket'),
  judges: [SchemaJudge(triageTicketOutputSchema), ContainsJudge(), RubricJudge()],
  cases: loadDataset('triage-ticket'),
  threshold: 0.7, // mean judge score a case must reach
})
```

```jsonl
{"id":"billing-refund","input":{"subject":"Charged twice","body":"…"},"expected":{"contains":["billing"],"rubric":"Routes to billing with high priority; quotes the duplicate charge."}}
```

- **The case carries its own expectations.** The harness input IS the `EvalCase`, so each judge reads
  `expected.contains | tools | toolsMatch | rubric | output` from the case. A judge is attached only
  to cases that declare something for it, because vitest-evals averages a `null` score as 0.
- **Each case runs in a tenant of its own**, with its `context` documents ingested first, so
  retrieval can only find what the case put there. Chat `messages` are seeded as the thread's
  earlier turns.
- 5–10 cases per suite: happy paths, one the model should refuse or not know, one that should call
  **no** tool (`"tools": [], "toolsMatch": "strict"`), and one edge case.

## Pick judges

Deterministic judges first: they're free, instant and never flaky. Use an LLM judge only for what a
string can't check.

| Want to check | Judge |
|---|---|
| a fact appears | `ContainsJudge()` + `expected.contains` |
| the output has the declared shape | `SchemaJudge(schema)` |
| it searched (or didn't), in what order | `TrajectoryJudge(mode)` + `expected.tools` / `toolsMatch` |
| latency, tokens, cost | `BudgetJudge({ maxMs, maxTokens, maxCostUsd })` |
| criteria in plain language | `RubricJudge()` + `expected.rubric` |
| every claim is grounded in what it retrieved | `FaithfulnessJudge()` |
| it agrees with a reference answer | `ReferenceJudge()` + `expected.output` |

The full catalogue, with scoring, is `.claude/skills/rf-evals/reference.md`. LLM judges run
through the `evals-judge` prompt (Settings → Prompts), on whatever model Settings → Agent models
assigns it, or on `--judge-model <id>` for one run. Every judge call is costed in `ai_usage`
(feature `evals.judge`) and never counted in a case's own spend.

## Run and read

```
pnpm eval                          # everything
pnpm eval knowledge --case refund-window,not-covered
pnpm eval agents --model claude-haiku-4-5 --judge-model claude-opus-5-5
```

Each case prints its judge scores. The run ends with a table of score, tokens, cost and
milliseconds, plus the path of the run file. For a failure, the run file has the judge's
`rationale`, the transcript, the tool calls and exactly what retrieval returned.
`pnpm eval:view` prints the per-judge score diff against the previous run (or two named runs, or
`--compare baseline`), then opens the vitest-evals report UI over the runs to walk the transcripts.

## Baselines

1. Run, read the results, and agree they're the new normal.
2. `pnpm eval:baseline [suite]` writes `apps/evals/baselines/<suite>.json` from the latest run
   (`--from <run.json>` to pick another). Commit it, with a sentence in the PR saying why.
3. From then on, `pnpm eval --compare` (or `--compare <run.json>`) prints regressions per case and
   judge, and exits 1 when one drops by more than `--threshold` (0.1).

Never refresh a baseline to make a comparison pass. A baseline is a claim about quality, not a
snapshot of the last run.

## Real traffic: thumbs and promotion

People rate answers in the UI (thumbs on chat replies and on run output → `POST /api/feedback`). An
admin turns a bad one into a case:

```
pnpm cli feedback list --rating down
pnpm cli evals promote <messageId|runId> --dataset knowledge-chat
```

The draft contains the question, the earlier turns, the passages retrieved, the tools called and
the **observed** answer as `expected.output`. That's the answer somebody disliked, so correct it and
write a rubric before committing (the `rf-evals` skill drafts both and waits for your sign-off). **A
promoted case is tenant data**: the command refuses to write without `--yes` or a confirmed prompt.
Redact names and emails before the line enters the repository.

## CI (optional)

`.github/workflows/evals.yml` runs `pnpm eval --compare` on manual dispatch, or on a pull request
labelled `run-evals`, with the `ANTHROPIC_API_KEY` repository secret. It uploads the run file as an
artifact. It is outside the gate on purpose: model variance must never block a merge.
