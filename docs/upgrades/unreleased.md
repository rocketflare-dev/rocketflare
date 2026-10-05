---
version: unreleased
previous: 0.17.0
date: null
breaking: false
migrations: []
areas: [config]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

`pnpm kit:upgrade` now prints each release note at `.upgrade/work/<version>/notes/X.Y.Z.md`, the copy it writes, instead of the kit's `docs/upgrades/X.Y.Z.md`, which a copy does not have until `--apply`.

- `scripts/lib/upgrade-lib.mjs` (+ `.d.mts`): `NOTES_SUBDIR`, `notePath(workDir, file)` and `noteReportLines(...)`; a `--dry-run` names the note as `<ref>:docs/upgrades/X.Y.Z.md`, labelled as the kit's, since nothing is written.
- `scripts/upgrade.mjs`: the report's `Release notes` lines use them; `plan.json` `notes[]` gains `path` (null on a dry run); `plan.md` says where each note's copy is.
- `.claude/skills/rf-upgrade/SKILL.md`: read the notes from `.upgrade/work/<version>/notes/` or `plan.md`, never the app's `docs/upgrades/` before the apply.
- `apps/web/tests/config/upgrade-note-paths.test.ts`: runs `upgrade.mjs` over a two-release fixture kit and asserts every printed note path exists in the copy.
- Why: an agent reading the report before applying got "file does not exist" on every note, which cost each unattended upgrade (Launch's) a failed first turn.

## How to apply

1. This upgrade itself still runs the copy's previous `scripts/upgrade.mjs`, so its report names `docs/upgrades/<version>.md`; read the note at `.upgrade/work/<version>/notes/<version>.md` instead. Later upgrades print that path themselves.

## Conflicts to expect

- `.claude/skills/rf-upgrade/SKILL.md` → three passages now name `.upgrade/work/<version>/notes/` → keep your own edits, take the note-location sentences.

## Verify

1. `pnpm --filter @<slug>/web exec vitest run --project config tests/config/upgrade-note-paths.test.ts tests/config/upgrade-lib.test.ts` passes.
2. `pnpm kit:upgrade --dry-run` prints `Release notes (in the kit at <ref> — dry run, …)` when a release is in range.
