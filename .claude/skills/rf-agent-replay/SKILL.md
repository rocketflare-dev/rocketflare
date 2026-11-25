---
name: rf-agent-replay
description: Replay an agent's past runs with the code in this working tree — recorded decisions, effects and answers served from Postgres, no model calls by default — and explain what would change before the change ships. Use when someone changes an agent's threshold, decision questions, routing or prompt and asks "what would this have done?", "is this safe?", "re-judge the old cases", "replay", "backtest", or wants to prove a cheaper variant against the full agent's history.
argument-hint: "<agent key> [--tenant <slug>] [--candidate <file>] [--live]"
---

# Replay — run today's agent code over yesterday's runs

D38 (`docs/CONCEPTS.md` §9). Every settled run recorded what the outside world told it: decision
answers (`agent_run_decisions`), `ctx.once` results (`agent_run_effects`), a person's answers
(`agent_run_interrupts`). Replay runs the agent's CURRENT `run()` and answers every one of those
calls from the record, so a code change is checked against real past cases in minutes, for free.

**Read-only, and you may run it yourself.** Each run replays inside a READ ONLY transaction and
`ctx.db` refuses writes. Default mode makes no model call. `--live` does, and costs tokens: say so
and get a yes first.

## 1. Run it

```
pnpm web agent:replay <agentKey>                       # lists the tenants that have runs of it
pnpm web agent:replay <agentKey> --tenant <slug> [--since 7d] [--limit 20] [--run <id>] [--json]
pnpm web agent:replay <agentKey> --tenant <slug> --candidate path/to/variant.ts   # another definition
pnpm web agent:replay <agentKey> --tenant <slug> --live                          # asks for what's missing
pnpm web agent:replay <agentKey> --tenant <slug> --run <id> --record apps/web/tests/agent-recordings  # commit a recording
```

- Run it **before** the change too. A baseline that already shows misses or diffs is not caused by
  the change.
- `--db-url` points at another database. Against anything but local, confirm with the user first,
  even though it is read-only.
- Exit 0 = every run matches. 1 = something differs or could not be replayed. 2 = usage.
- `--live` is a replay against **today's** tenant: its knowledge base as it is now (edited and
  deleted documents included), its current prompt overrides and model assignments. Searches frozen
  in a `ctx.once` still come from the record. The script borrows the Worker's Workers AI binding
  through wrangler (it needs `wrangler login`). A `⚠ live replay:` line means knowledge search is
  degraded in this process: no provider, or a different embedding model. Report it with the
  results, and do not read a changed answer that depends on the knowledge base as a behaviour
  change.

## 2. Read a line

```
match       bd112d31  succeeded → succeeded  diff 0
differs     f5905640  succeeded → succeeded  diff 3  decisions answerable:stale
incomplete  ce0f45b1  succeeded → miss       diff 0  misses chat:chat
differs     7a1c09e2  succeeded → succeeded  diff 0  turns 1/3 served (tool-loop#2:drift tool-loop#3:drift)
differs     90b2d3f4  succeeded → succeeded  diff 0  order drift (decide:answerable → once:triage:search)
```

| You see | It means | Usually |
|---|---|---|
| `match` | Same status, same output, every decision served | The change does not touch this case |
| `diff N` | The output differs at N JSON paths (`--json` → `outputDiff[].path`) | The intended effect, or a regression. Read the paths |
| `decisions k:drift` | `k`'s questions were reworded; the OLD answers were used | Rerun with `--live` to see what the new wording decides |
| `decisions k:stale` | Same questions, different state. Code upstream changed what `k` is about | The recorded answer describes inputs this run no longer has. `--live` re-asks |
| `decisions k:unused` | Recorded, never asked by the new code | A branch the change removed or now skips |
| `decisions k:asked(n changed)` | `--live` asked again; n answers changed label | The re-judged cases. This is the number to report |
| `misses decide:k` | A decision key nothing recorded | A new decision. Needs `--live` |
| `turns a/b served` | A tool loop's model turns, answered from its journal (`agent_run_turns`) | All served: the loop saw the same transcript and system prompt as the run |
| `<loop>#<n>:drift` | Strict: turn n's transcript or system prompt changed, and the RECORDED reply was used anyway | Your change reaches the loop (a prompt, a seed, a tool). Rerun with `--live`, which re-asks from the first drifted turn |
| `<loop>#<n>:asked` | `--live` asked the model for turn n | Count these for the token cost |
| `order drift (…)` | Today's code asks its top-level `once`/`decide` keys in another order than the run did | A moved step. Fine for a new run; a run PARKED across the deploy re-enters the new order, so say so |
| `misses chat:<loop> turn <n>` | A loop turn the journal does not have | A run older than `AGENT_TRANSCRIPT_RETENTION_DAYS` (30), or one from before the journal existed, or a loop not given `journal: ctx.journal`. `--live` settles it |
| `misses chat:chat` | A model call outside a tool loop the record cannot answer | A path the run never took (e.g. an escalation), or a `callStructuredTool` not wrapped in `ctx.once` |
| `misses once:k` | A `ctx.once` key nothing recorded | A run older than that key, or a new effect. Never re-run automatically: it may have a side effect |
| `misses tool:<name>` | A tool handler called outside a `once` | Strict cannot search; `--live` can |
| `refused N write(s)` | The agent tried to write; the replay refused | Harmless unless the status also changed |
| `→ parked` | An interrupt with no recorded answer | The new code asks a person something the old one did not |
| `→ input_incompatible` | The recorded input no longer parses | `inputSchema` changed. Old runs cannot be replayed as they are |

## 3. Report

Tell the user, in this order:
1. How many runs: match, differ, incomplete.
2. What the change actually changed: the diff paths that move, with two or three runs as examples
   (`--json --run <id>` for one run).
3. What a replay could not judge (misses), and whether `--live` would settle it. Give the token cost
   of a `--live` run already made.

**Never say "safe" over incomplete runs.** Say how many were judged.

## 4. Make an agent replayable (when misses get in the way)

- Anything learned from outside goes through `ctx`: `once`, `decide`, `interrupt`, `tools`, `chat`.
  A query run directly on `ctx.db` replays against TODAY's data.
- A `ctx.once` whose `fn` is a pure model call takes `{ replay: 'rerun' }`, so `--live` re-runs it
  and a prompt change shows. Leave anything with a side effect on the default.
- Freeze the items a decision is about behind `ctx.once` before deciding. Otherwise a replay
  reports `stale` for every run.
- A tool loop is replayable when it is given `journal: ctx.journal` (`research-topic` is), and only
  for runs inside the journal's retention (30 days by default). A loop without it stops strict
  replay at its first model call. Decomposing the loop into `once` and `decide` steps (`rf-how-do-i`,
  the D37 example `triage-research`) still gives the sharper report: a judgment per question rather
  than per turn.
- A `ctx.once` called in a loop passes what differs as `{ inputs }`. The same key twice in one
  attempt fails the run (`agent_effect_key_conflict`), in a replay as in production.

## 4b. Before you change an agent

Replay the agent's recent runs BEFORE the edit, so the baseline's misses and diffs are not
blamed on you, then again after. Read `order drift` and `drift` lines as questions for the change:
did you mean to move a step, or to change what a loop sees? A step moved in a run that is parked
on a person right now is what that run meets when it resumes.

## 4c. Recordings: the version check in the gate

`--record <dir>` writes each selected run as `<dir>/<agent>-<runId>.json` (the run plus its
decisions, effects, asks, steering and turns). Every file under `apps/web/tests/agent-recordings/`
is replayed by `tests/api/agent-recordings.test.ts` on every gate: a change that moves, renames or
drops a top-level `once`/`decide` key at the SAME `meta.version` fails with "bump `meta.version`".
When it fails, tell the user which agent and key, and ask whether runs in flight should `continue`,
`fail` or `rerun` across the change — then bump `meta.version` and set `onVersionChange`. Record
only from a dev or seeded tenant: a recording holds the run's input and model turns. A recording
whose agent is now at a newer version than it was recorded at is no longer checked; re-record it.

## 5. A candidate

A candidate is a `.ts` file whose default export is an agent definition with the SAME `meta.key`.
It is usually a variant that wraps the registry's agent:

```ts
import { decideWithShapes } from '<repo>/apps/web/src/api/services/agents/decisions'
import { triageResearchAgent } from '<repo>/apps/web/src/api/services/agents/examples/triage-research'
export default {
  meta: triageResearchAgent.meta,
  run: (ctx: any) => {
    const decide = decideWithShapes((k, r) => ctx.decide(k, r))
    const sift = decide.sift
    decide.sift = (key, o) => sift(key, { ...o, threshold: 0.8 })   // the one thing being tried
    return triageResearchAgent.run({ ...ctx, decide })
  },
}
```

- Keep scratch candidates out of the repo (`/tmp`). Make the real change in the agent file once the
  replay supports it.
- Then run `pnpm eval agent:<key>` (`rf-evals`). Replay says what CHANGED; evals say whether it got
  BETTER.
