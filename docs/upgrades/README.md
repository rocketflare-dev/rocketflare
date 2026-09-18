# Release notes, written for an agent

One file per kit release, `X.Y.Z.md`, plus `unreleased.md` which accumulates entries between
releases. `CHANGELOG.md` at the repository root is the human index; these are the porting
instructions, and `scripts/upgrade.mjs` reads their frontmatter.

They exist because a copy of the kit is detached and renamed, so it can never merge from upstream.
`pnpm kit:upgrade` replays a translated, filtered kit diff into a copy — and these notes are what
tell it, and the agent driving it, what a release actually did and what it must not do.

## The shape

```markdown
---
version: 0.5.0
previous: 0.4.0
date: 2026-09-11
breaking: false
migrations: ["agent budget columns on agent_runs"]
areas: [api, shared, ui]
touches_surfaces: [example-agent-summarize-text]
requires_surfaces: [feature-agents]
manual: false
---

## What changed
## How to apply
## Conflicts to expect
## Verify
```

| Field | Meaning |
|---|---|
| `version` | must equal the filename stem and the root `package.json` version at the tag |
| `previous` | the note this one follows; `null` only on the baseline. The chain must be unbroken — it is what `/rf-upgrade` walks |
| `breaking` | an adopter has to change their own code, not just accept ours |
| `migrations` | human descriptions of the schema change, **never file names**. An adopter never copies a kit migration; they port the schema and run `pnpm db:generate`. Several read better as a block sequence (`migrations:` then one `  - "…"` per line) than crammed into one inline list |
| `areas` | `api` · `ui` · `shared` · `db` · `cli` · `config` · `docs` — what to read first |
| `touches_surfaces` | surface ids from `.rocketflare.json`. Files under an absent surface are dropped |
| `requires_surfaces` | gates the WHOLE note: absent locally, the release does not apply to this app |
| `manual` | true when the change cannot be applied mechanically and the body is the only instruction |

Any list may be written inline (`areas: [api, ui]`) or as a block sequence, one `  - item` per
line. Quote an item that contains a comma — `parseNote` is quote-aware, so the comma stays inside
the string instead of splitting it in two.

The four headings are fixed and must appear in that order; `apps/web/tests/config/upgrade-notes.test.ts`
enforces every rule above.

## Writing one

Add to `unreleased.md` in the same pull request as the change — `.claude/rules/code-quality.md`
lists it in the "Docs in sync" table, CI fails a PR that touches `apps/**` or `packages/**` without
one, and `pnpm kit:release <version>` folds it into `X.Y.Z.md` at release time.

**A note is instructions, not an essay.** An agent ports a release by following it top to bottom.
Rationale lives in `docs/CONCEPTS.md` — the decision record — and is LINKED from here, never
restated; one sentence of "why" per change is all a note carries. Target **≤ 150 lines**.
`0.6.1.md` is the model.

Exactly the four headings above, exact text, in that order, and then:

- **`## What changed`** — **no `###` sub-headings**; they are what turned notes into essays.
  **Paragraph 1 is lifted VERBATIM into `CHANGELOG.md`** (`summaryOf()` in `scripts/release.mjs`),
  so it must be ONE standalone summary sentence of **≤ 40 words** that reads correctly with no other
  context around it — that is why changelog entries used to run a paragraph long. Then one bullet
  per change, one line each.
- **`## How to apply`** — numbered, imperative, and **each step self-contained**: no pronoun may
  refer outside its own step, so "these", "them" and "the above" are banned. Write it for someone
  who does not have your diff in front of them, months later, reading one step at a time. Name the
  registry entries a new file has to be added to, say which of the kit's own conventions the change
  depends on, and be explicit about anything the patch cannot carry: a new binding in both wrangler
  tomls, a `.dev.vars` key, a data backfill. "Nothing to do" is a whole step only when it says what
  it is about.
- **`## Conflicts to expect`** — one line each, `path → what changed → what to do`. Or `None.`,
  optionally followed by one short clause saying why there are none.
- **`## Verify`** — numbered checkable commands and assertions, and nothing else.
