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
3. `pnpm eval`. The first run takes a minute or two for the three starter suites (12 cases), and
   about $0.16 on the default Claude model plus the judge.
4. Optional, to compare vendors: `FIREWORKS_API_KEY` and/or `GEMINI_API_KEY` in `.dev.vars`, then
   `--provider fireworks|gemini` (and `--judge-provider`, see below).

Only the model keys (Anthropic, Fireworks, Gemini), the embeddings key and the tracing keys are
read from `.dev.vars`. A variable in the environment
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

It is its own workspace package because vitest-evals needs vitest 4 while `apps/web` is on vitest 5.
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

## Corpora: a whole business's documents

A dataset case brings two or three documents of its own. A **corpus** is a directory of dozens,
ingested once into one tenant and shared by every case that asks about it, so ranking matters and a
wrong hit is possible. Put one anywhere under `datasets/` (the kit's own fixture is
`datasets/kit-only/brightside/`, kit-only):

```
<name>/docs/<doc-id>.md   front matter (title, date, origin: upload|integration, source, kind) + markdown
<name>/corpus.json        optional {"organisation"} — the business the knowledge base belongs to
<name>/retrieval.jsonl    {"id","query","expected":[{"doc","passage"}],"tags"} — passage TEXT, never chunk ids
<name>/chat.jsonl         EvalCase lines about the corpus (`context: []`), run by `chat · knowledge`
<name>/entities.jsonl     {"entityType","name","aliases"}
<name>/facts.jsonl        planted facts {"id","entityType","entity","key","value","doc","quote","validFrom","validTo"}
<name>/conflicts.jsonl    planted contradictions {"id","entityType","entity","key","a","b","winner","why"}
```

- **Real embeddings only.** A corpus is ingested with `EMBEDDINGS_API_KEY` (the platform tier) or,
  without it, `GEMINI_API_KEY` as a tenant embeddings row on `gemini-embedding-001` at 1024
  dimensions. With neither, corpus suites skip: a ranking measured on the stub's deterministic
  vectors says nothing about production.
- **`knowledge · retrieval`** (`suites/knowledge/retrieval.eval.ts`) runs each query through the app's
  own `searchKnowledgeChunks` and grades the ranking: `Recall@5`, `Recall@10` and `MRR` in code,
  `ContextPrecision` by the judge over the top 5. No chat model runs, and no query fails the run —
  the summary prints each suite's mean row, which is what to read.
- **`--rerank none|fireworks`** measures retrieval with and without a reranker. `none` (the default)
  searches with `rerank: false`, because the test `AI` stub's reranker answers in fused order and
  measures nothing. `fireworks` writes a tenant `rerank` row (the kit's `fireworks-rerank` preset,
  `fireworks/qwen3-reranker-8b`, from `FIREWORKS_API_KEY`), so the run goes through
  `resolveRerank`'s tenant tier; the summary adds the median rerank latency. Workers AI's
  `bge-reranker-base` cannot be measured here: evals run in Node, with no real `AI` binding.
  On the kit fixture (2026-11-17, Gemini embeddings, 60 queries): without a reranker R@5 0.87,
  R@10 0.97, MRR 0.66, ContextPrecision 0.83; with Fireworks R@5 1.00, R@10 1.00, MRR 0.84,
  ContextPrecision 0.93, at a median 821 ms per search (p90 1.2 s, max 1.9 s) for 50 candidates.
  Every answer-key passage scored ≥ 0.18 on that reranker, so `RERANK_MIN_SCORE=0.15` keeps all
  of them and drops about 73 % of the other hits; the scale is per model, so the kit leaves the
  threshold off and an app sets it from its own run.
- **`knowledge · facts`** (`suites/knowledge/facts.eval.ts`, `kit/facts.ts`, `pnpm eval facts`) runs
  over every corpus with a `facts.jsonl`. It registers the corpus's entity types itself
  (`corpusEntityTypes` — staging-only, each key with a `.describe()`, never the app's registry),
  turns the `knowledge-facts` flag on for the corpus tenant, names the tenant after `corpus.json`'s
  `organisation`, and extracts every document OLDEST FIRST through the app's own job body
  (`extractDocumentFacts`), so each document meets what the earlier ones left. Stored facts are
  scored against the answer keys (an entity is scored under the first of its name and aliases the
  key knows): one case per document and `facts-all` (`Precision`, `Recall`), and one `conflicts`
  case — `ConflictsCaught`, `NoFalseAlarms` (1 − the false-alarm rate) and `WinnerAccuracy` (does
  the side an answer leads with match the planted winner). A flag is a `conflicts_with` link, or a
  supersession between two different documents (a change over time the key also calls a
  conflict); a supersession inside one document is sequential validity, not a flag.
  `judgeThreshold: null`: it measures, it never fails. On the kit fixture (2026-11-17, Haiku 5.5,
  Gemini embeddings, 42 documents): precision 0.91, recall 0.75, conflicts caught 0.82, false
  alarms 0.22, winner accuracy 1.00, $0.0009 per document. Runs vary by a few points either way;
  compare against `baselines/knowledge-facts.json` with `--compare`, not one run.
- **`chat · conflicts`** (`suites/chat/conflicts.eval.ts`, `kit/conflict-chat.ts`, `pnpm eval
  conflicts`) runs over every corpus with a `conflicts.jsonl`. It extracts the corpus's facts first
  (the same `factsRun` as `knowledge · facts`, through `chatHarness({ corpus, prepare })`), so chat
  has `lookup_facts` and `search_knowledge`'s facts block, then asks one question per conflicted
  entity and key. The question and rubric are built from the answer keys: every value the planted
  facts give, each with its document's title and date, must appear with its source, and the answer
  must say that they disagree. `RubricJudge` only. On the kit fixture (2026-11-17, Haiku 5.5,
  Gemini embeddings, 18 cases) one run scored 17/18 (mean 0.94) and the next 16/18 (0.89, the
  baseline). Every failure was the judge rejecting a further document the answer cited correctly
  but the rubric did not list (an ops meeting note, an invoice query), not a value left out, so
  read a failure's rationale before changing a prompt.
- `tests/corpus.test.ts` (in the gate) checks every corpus: each passage and quote is verbatim in
  its document, every id resolves, every conflict pairs two planted facts.

## Pick judges

Deterministic judges first: they're free, instant and never flaky. Use an LLM judge only for what a
string can't check.

| Want to check | Judge |
|---|---|
| a fact appears | `ContainsJudge()` + `expected.contains` |
| the output has the declared shape | `SchemaJudge(schema)` |
| it searched (or didn't), in what order | `TrajectoryJudge(mode)` + `expected.tools` / `toolsMatch` |
| latency, tokens, cost | `BudgetJudge({ maxMs, maxTokens, maxCostUsd })` |
| its typed decisions (`ctx.decide`, D37) came out right — and how well calibrated | `DecisionJudge()` + `expected.decisions` (scored from `agent_run_decisions`, no model call; Brier in the rationale). `suites/agents/triage-research.eval.ts` is the example; run it with and without `TYPESAFE_API_KEY` to compare Jev with the chat-model fallback |
| criteria in plain language | `RubricJudge()` + `expected.rubric` |
| every claim is grounded in what it retrieved | `FaithfulnessJudge()` |
| it agrees with a reference answer | `ReferenceJudge()` + `expected.output` |
| retrieval ranked the answer high (corpus suites) | `RecallAtK(k)`, `MRR()` (computed) · `ContextPrecision(k)` (judge) |

The full catalogue, with scoring, is `.claude/skills/rf-evals/reference.md`. LLM judges run
through the `evals-judge` prompt (Settings → Prompts), on whatever model Settings → Agent models
assigns it, or on `--judge-model <id>` for one run. Every judge call is costed in `ai_usage`
(feature `evals.judge`) and never counted in a case's own spend.

## Run and read

```
pnpm eval                          # everything
pnpm eval knowledge --case refund-window,not-covered
pnpm eval agents --model claude-haiku-5-5 --judge-model claude-opus-5-5
pnpm eval knowledge --provider gemini                      # gemini-2.5-flash as the target
pnpm eval knowledge --provider fireworks --model accounts/fireworks/models/gpt-oss-120b
pnpm eval knowledge --judge-provider gemini                # a non-Claude judge
pnpm eval retrieval --rerank fireworks                     # retrieval with a reranker
```

`--provider anthropic` (the default) is the resolver's platform tier. `fireworks` and `gemini`
write a real, encrypted `ai_configs` row on each case's tenant (Fireworks through the kit's own
`fireworks` preset, which is exactly what Settings → AI offers a tenant; Gemini as
`openai_compatible` at Google's OpenAI-compatible endpoint), so those runs also exercise the
tenant-config tier. `--model` picks a model on that
provider. Fireworks serverless availability varies by account, so pick one your key can call.
Neither vendor is in the kit's price table, so their cost reads "—". Hold the judge constant when
comparing targets.

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
