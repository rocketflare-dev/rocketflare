---
version: unreleased
previous: 0.7.0
date: null
breaking: false
migrations: []
areas: [config, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

**Porting notes are instructions now, not essays**: every released note is rewritten as one summary
sentence, bulleted changes and numbered self-contained steps, and two release-tooling defects are
fixed.

- The eight kit notes went from 3,270 lines to 1,291 with no instruction dropped — rationale now
  links to `docs/CONCEPTS.md` rather than being restated. `docs/upgrades/README.md` § "Writing one"
  states the format, and the `unreleased.md` template teaches it.
- **Paragraph 1 of `## What changed` is lifted verbatim into `CHANGELOG.md`**, so it must be one
  standalone sentence of ≤ 40 words. That is why changelog entries used to run a paragraph long;
  every entry now matches its note.
- `## What changed` carries no `###` sub-headings; `upgrade-notes.test.ts` asserts it over every
  note plus a fixture.
- **`requires_surfaces` was read with a regex matching inline lists only**, so a note written as a
  block sequence — which `README.md` explicitly permits — read as EMPTY and the release was deemed
  applicable to an app lacking the surface. It uses `parseNote` now, and an unreadable value means
  "not gated" rather than a `TypeError` on the upgrade path.
- A plugin release stamps its `anchor` as well as its manifest, so the two copies of a plugin's
  version can no longer disagree. The anchor is what `pnpm plugin check` compares against the
  recorded surface, so one left behind failed every install and took the host's whole gate down.

## How to apply

1. Accept the rewritten `docs/upgrades/*.md` and `CHANGELOG.md`; they carry the same instructions
   in fewer words. Your own notes are unaffected.
2. Take `scripts/upgrade.mjs` for the `requires_surfaces` fix if you wrote any note's
   `requires_surfaces` as a YAML block sequence — before the fix that note was never gated.
3. Take `scripts/release.mjs` if you maintain a plugin repository, and re-cut any release whose
   anchor is behind its manifest.

## Conflicts to expect

`scripts/release.mjs` → `releaseContext` gained anchor stamping and a new `unreleased.md` template →
accept ours. `scripts/upgrade.mjs` → the `requires_surfaces` read moved to `parseNote` → accept ours.

## Verify

1. `pnpm web test:config` passes, including `upgrade-notes.test.ts`.
2. `node scripts/release.mjs <next> --dry-run` exits 0 and lists the files it would stamp.
