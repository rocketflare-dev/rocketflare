# Phase 8 — Examples and docs

## The shipped examples

### `summarize-text` uses `ctx.interrupt`, **not** `requiresApproval`

A deliberate departure from issue #17 §9. `summarize-text` has **no tool loop**: it is one
`callStructuredTool`, and `ingestText` is straight-line code, not a `Tool`. Bolting a tool loop onto
the simplest example — *the file every adopter copies* — to demonstrate a flag would make the
simplest agent the most complicated one.

So: an `approval` interrupt keyed `'approve-index'` before the existing `ctx.once('index-summary',
…)`, gated on `input.index`:

```ts
if (input.index) {
  const approval = await ctx.interrupt({
    key: 'approve-index',                 // stable: a resumed run finds the ANSWER, not a new ask
    kind: 'approval',
    message: 'Add this summary to the knowledge base as a searchable document?',
  })                                      // rejected → InterruptDeclinedError → the run cancels
  await ctx.step('index', 'Indexing the summary for search', 'running', 'approved')
  const document = await ctx.once('index-summary', …)   // unchanged
  await ctx.artifact({ key: 'summary-document', kind: 'document', title: …,
                       data: { kind: 'document', documentId: document.id } })
}
await ctx.artifact({ key: 'summary', kind: 'markdown', title: 'Summary', data: { kind: 'markdown', markdown: … } })
```

This is also the Definition-of-done line for `docs/CONCEPTS.md` §14.

### `research-topic` exercises everything else

An `ask_human` tool raising a **`choice` interrupt from inside a tool handler** — the single best
exercise of the whole machine:

> handler throws → `runHandler` rethrows (T3) → the loop checkpoints and parks → resume executes the
> pending call (T1) → the handler re-runs and finds its answer recorded (T2)

Plus `beforeTurn` steering on a live loop, a `markdown` artifact for the answer and a `table`
artifact for the citations. `requiresApproval` itself is demonstrated here and in tests.

`approvers` stays default on both — no shipped example touches money, so `approvers: 'admin'` is
exercised by **tests only**.

## Docs, in the same PR (the kit's non-negotiable)

### `docs/upgrades/unreleased.md` — CI fails a PR touching `apps/**` or `packages/**` without it

```yaml
migrations:
  - "agent_run_interrupts and agent_run_artifacts tables"
  - "the active-run exclusive index widens to include awaiting_input"
  - "ai_usage gains agent_run_id"
areas: [api, shared, ui, db, config]
requires_surfaces: [feature-agents]
touches_surfaces: [example-agent-summarize-text, example-agent-research-topic]
```

`requires_surfaces` is what lets a copy that deleted the agents surface skip the release entirely.

### `docs/CONCEPTS.md`

- **§9** — the interrupt lifecycle, the four kinds, the approver policy, artifacts, steering,
  streaming. **Delete** *"There is no SSE endpoint for runs, deliberately"* and *"Nothing streams —
  runs are rows"*. **Correct "instance id IS the run id"** (T5 — it is now the *latest* instance).
  Add the Agents SDK comparison from [00-cloudflare-validation.md](00-cloudflare-validation.md) so
  the next person finds it rather than rediscovering it.
- **§5** — the Workflow table gains the suspend/resume shape.
- **§14** — the walkthrough gains the approval step.

### `.claude/rules/`

| File | What |
|---|---|
| `api.md` | `ctx.interrupt`'s **mandatory key**, `requiresApproval`, the `ctx.once` obligation, artifacts, steering. The read-stream rules: never `RUN_ERROR` for the stream's own failure, `id:` on the last frame of a group, never `reconcileRun` in a loop |
| `cloudflare.md` | `waitForEvent` / `sendEvent`, **event names allow only `[A-Za-z0-9_-]`**, unique step names in a loop, a `waiting` instance is not executing, instance retention 30 d / 3 d, a read-stream holds one Hyperdrive connection for its life |
| `database.md` | the widened partial index as **the** worked example of "the predicate is the guarantee" |
| `ui.md` | `runOwesAnswer` vs `isRunActive`; a parked run polls never; a stream that carries durable rows writes them into the cache via a pure merge, and only chat's in-flight text is local state |

### Per-directory `CLAUDE.md`

`services/agents/`, `workflows/`, `routes/`, `db/schema/`, `src/ui/` — each gains the new surface,
and `src/ui/CLAUDE.md` replaces its `RunDetailDrawer` bullets with the workspace shape, the two
registries, and the cache rule.

## Finally

Delete `docs/plans/agent-hitl/` in the PR that ships the last phase. Git history is the archive, and
a stale plan sitting beside current documentation is exactly what
`.claude/rules/code-quality.md` forbids.

---

## Docs debt found during phases 1–4 (close it here)

Each verified stale against the code as it now stands, not guessed:

- **`docs/CONCEPTS.md` §9, line ~968** — "creates the Workflow instance with **id = run id**" is now
  wrong on the resume path. §5 was corrected in phase 3; §9 was not.
- **`docs/CONCEPTS.md` §5, line ~393** — the exclusive index is quoted as
  `WHERE status IN ('queued','running')`. Phase 2 widened it to include `awaiting_input`, and the
  predicate is now *derived* from `ACTIVE_RUN_STATUSES` rather than typed out.
- **§9's "There is no SSE endpoint for runs, deliberately"** and **"Nothing streams — runs are
  rows"** — both become false with phase 6. Already in this file's list; repeated here so the three
  travel together.
- **`docs/CONCEPTS.md` §9 Known gaps** — the "live run streaming with `Last-Event-ID` replay is
  still deferred" line, and the AG-UI gap list, need re-reading end to end rather than patching:
  several entries are closed by phases 5–7.
