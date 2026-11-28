# Pending porting-note fragments (kit repository only)

One file per pull request that changes behaviour: `<slug>.md`, a short kebab-case name (the branch
topic). `pnpm kit:release <version>` folds every fragment here, and `../unreleased.md` when it has
entries, into `../X.Y.Z.md`, then deletes them. The shape and the merge rules are in `../README.md`
("Writing one"). This directory is `kitOnly`: a copy never has it.

```markdown
---
breaking: false
migrations: []
areas: [api, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

One standalone summary sentence of ≤ 40 words.

- One bullet per change, one line each.

## How to apply

- Imperative, self-contained steps, unnumbered: the release numbers them.

## Conflicts to expect

None.

## Verify

- `pnpm test config apps/web/tests/config/example.test.ts` passes.
- `pnpm gate` passes.
```
