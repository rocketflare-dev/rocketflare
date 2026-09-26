---
name: rf-evals
description: Write, run and interpret evals for this kit's chat and agents — decide what "good" means, scaffold a suite and starter cases, run pnpm eval, explain failures from the judges' reasoning, compare models or prompts on score/cost/latency, harvest thumbs-down answers into cases, manage baselines and CI, and run a disciplined improve loop. Use when someone says "eval", "evaluate", "is this prompt better", "compare models", "did this change make it worse", "regression", "thumbs down", "golden set", or wants to test AI quality.
argument-hint: "[explain | author <what> | run [suite] | compare <a> <b> | harvest | baseline | improve <suite>]"
---

# Evals — measure whether chat and agents got better or worse

The kit ships a developer-run eval harness (D33, `docs/CONCEPTS.md` §9, how-to in `docs/EVALS.md`).
It lives in `apps/evals` (vitest-evals on vitest 4), runs locally with `pnpm eval`, and is **never
part of the gate**. Its targets run the product's real code in-process against the TEST database
(:5433): the chat target calls the real chat route and the agent target runs the real agent runtime.
Each case gets a tenant of its own with its documents ingested. `reference.md` beside this file has
the judge catalogue, the `EvalCase` schema and the command table. Read it before you author anything.

Pick the mode from `$ARGUMENTS`, or from what the person says. If you can't tell, start with
**Explain**.

**Ground rules, in every mode:**
- **Never edit an `expected` value, a rubric or a baseline to make a case pass.** A gold expectation
  changes only when a person has read the new answer and said it is better. Say what you would
  change and why, and wait.
- **Never weaken a judge** (a lower threshold, a judge removed, `toolsMatch` loosened) without asking.
- A run costs real tokens. Before a full `pnpm eval`, say roughly how many cases will run and
  suggest a suite filter or `--case` if a smaller run answers the question.
- Promoted cases are **tenant data**. Say so every time one is about to enter the repository.

## Preconditions (check once)

1. `pnpm test:db:up` — the evals use the test database and migrate it themselves.
2. A model key: `ANTHROPIC_API_KEY` in `apps/web/.dev.vars` (or in the environment). Without one,
   every suite skips and prints why. That is not a failure, but it's not a result either. Say so.
   `EMBEDDINGS_API_KEY` is optional: without it retrieval uses the test stub's deterministic vectors
   plus lexical search, which is fine for the starter cases.
3. `pnpm cli login` is needed only for **Harvest** (`feedback list`, `evals promote` are admin+).

## Explain / orient

Before anything is written, ask **what "good" means** for the surface in one or two sentences, and
**what would make them distrust an answer**. Then map that onto:

| Surface | Target | Typical judges |
|---|---|---|
| Knowledge chat (RAG) | `chatHarness()` | `Trajectory` (did it search, or stay quiet), `Contains`, `Faithfulness`, `Rubric` |
| A tool-calling agent | `agentHarness('<key>')` | `Trajectory`, `Schema` (its output schema), `Faithfulness`, `Rubric` |
| A structured-output agent | `agentHarness('<key>')` | `Schema`, `Contains`, `Rubric`, `Budget` |

Teach the order: **deterministic first** (`Contains`, `Matches`, `Schema`, `Trajectory`, `Budget`).
They are free, instant and never flaky. Add an **LLM judge** only for what a string check can't see:
tone, completeness, grounding. Faithfulness grades against what retrieval **actually returned**, not
against the dataset's documents.

## Author

1. Agree the surface, the target and 3–4 judges with the person, and say why each judge.
2. Draft **5–10 cases** into `apps/evals/datasets/<name>.jsonl`, one `EvalCase` per line:
   happy paths, one "should refuse / should not know", one "should NOT call a tool", one edge
   (too short, multi-turn, ambiguous). Every case must say what good means: `contains`, `tools`,
   `rubric` or `output`. `tests/datasets.test.ts` enforces it. Explain each case in a sentence so
   the person learns the pattern.
3. Write `apps/evals/suites/<surface>/<name>.eval.ts` with `describeCases(...)`, copying
   `suites/chat/knowledge.eval.ts`. A new agent needs nothing else: the target resolves it from the
   registry.
4. `pnpm --filter @rocketflare/evals test` (the dataset parses) → `pnpm eval <name>` → **Run & interpret**.

## Run & interpret

```
pnpm eval [suite] [--case id,id] [--model <id>] [--judge-model <id>] [--compare [baseline|<run.json>]]
```

The terminal shows each case's judge scores, then a table of score / tokens / cost / ms and the run
file `apps/evals/.evals/runs/<ts>-<sha>.json`. For each failing case, read that file (`jq`), not
just the table: `testResults[].assertionResults[].meta.eval.scores[]` gives the judge's
`metadata.rationale` (and `output`), and `meta.harness.run` gives the transcript, tool calls,
`artifacts.retrieved` and usage. Explain in plain language, per case: what was asked, what the model
did (which tools, what it retrieved), which judge failed and **the judge's own reasoning**. Then say
whether the fault is the model, the prompt, the tools/retrieval, or the case itself. Offer
`pnpm eval:view` when a visual walk through transcripts helps. It prints the score diff against the
previous run first. Eval traces are in `ai_spans` tagged `rocketflare.eval=true`
(`pnpm cli traces …` against the test DB is not wired, so read the run file).

## Compare (model vs model, prompt vs prompt)

- Models: `pnpm eval <suite> --model A` then `--model B`, then `pnpm eval:view <runA> <runB>`
  (it prints the diff and serves both). Use the same `--judge-model` for both, or the comparison is
  confounded.
- Prompts: prompts are code (`apps/web/src/api/services/prompts.ts`). Run, change the prompt, run
  again. The run header's `promptHashes` proves which text each run used.
- Present a table: mean score, pass count, tokens, cost, total ms per variant, plus the cases that
  moved and why (from the rationales). Recommend one, with the trade-off in a sentence.

## Harvest (from real traffic)

1. `pnpm cli feedback list --rating down` (admin+). Pick candidates with the person.
2. `pnpm cli evals promote <messageId|runId> --dataset <name>`. **Warn that the case is tenant
   data** before it runs, and suggest redacting names, emails and ids in the written line.
3. The draft's `expected.output` is the answer the user **disliked**. Draft a corrected expectation
   and a `rubric` from the feedback comment and the retrieved context, show them, and **stop for
   sign-off on every gold expectation.** Never commit an unreviewed promoted case.

## Baseline & CI

- `pnpm eval:baseline [suite]` writes `apps/evals/baselines/<suite>.json` from the latest run
  (`--from <run.json>` for another). Update it only after reading the run and agreeing it's the new
  normal, with a sentence in the PR saying so. Then `pnpm eval --compare` exits 1 on any per-case,
  per-judge drop over `--threshold` (0.1).
- CI: `.github/workflows/evals.yml` runs on manual dispatch or the `run-evals` PR label, with the
  `ANTHROPIC_API_KEY` repository secret, and uploads the run file. It is outside the gate on
  purpose: a model's variance must never block a merge.

## Improve loop

Only with a target ("Rubric ≥ 0.9 on knowledge-chat") and an iteration cap (default 3).

1. Split the dataset: keep ~⅓ of cases as a **held-out** set (tag them `holdout`), and don't look at
   their failures while diagnosing.
2. Run and mine the failures on the rest. Find the pattern behind them, not the individual cases.
3. Propose **one** change to the prompt, a tool description or the retrieval parameters, explained.
   On a yes, apply it.
4. Re-run the training cases **and** the held-out ones. Keep the change only if the training cases
   improve and the held-out ones don't regress. Otherwise revert it and say what you learned.
5. Stop at the target, at the cap, or when two changes in a row don't help. Report what changed,
   the before/after table, and what is left.

Never edit an expected output or loosen a judge inside this loop. That's gaming, not improving.
