# Eval baselines

One file per suite, `<suite-file>.json`: the per-case, per-judge scores of a run somebody decided
was good. `pnpm eval --compare baseline` diffs a new run against them and exits non-zero on a
regression past the threshold. Write or refresh them with `pnpm eval:baseline [suite]` — after
reading the run, never to make a failing comparison pass. See `docs/EVALS.md` § Baselines.
