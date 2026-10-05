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

Plugin dependencies stay in step: `plugin add` keeps declared ranges, `plugin check` accepts narrower ones, `plugin upgrade --apply` installs, re-ranges and removes them; and `kit:upgrade` prints porting-note paths that exist in the copy.

- `scripts/lib/plugin-lib.mjs` (+ `.d.mts`): `rangeWithin(have, range)` — a zero-dependency npm range subset test (`^2.3.0` within `^2.2.4`; wider, disjoint, prerelease and exotic ranges are not).
- `missingDependencies` and the host half of `dependencyClashes` use `rangeWithin` instead of string equality.
- `dependenciesToInstall` and `pinDeclaredRanges`: `plugin add --apply` installs only what is unsatisfied, writes the declared range back over `pnpm add`'s output, then runs `pnpm install --no-frozen-lockfile` to re-key the lockfile.
- `dependencyDelta(before, after, { packageJsons, installed })` (+ `renderDependencyDelta`, `withoutDependencies`): an upgrade's dependency changes. Added or re-ranged → install as `add` does (skipped when the host is already inside the new range); removed → dropped only when no other installed plugin declares it and the host holds exactly the old declared range, otherwise kept with the reason; a new range outside another installed plugin's declared one is a clash.
- `scripts/plugin.mjs` `upgrade`: diffs the manifest at `from` (the mirror) against the new one, prints a `Dependencies` block (and `dependencies` / `dependencyClashes` under the new `--json`), refuses a clash with exit 6 before writing anything, and on `--apply` changes `package.json` after the files are written, with one `pnpm install --no-frozen-lockfile` at the end.
- `scripts/plugin.mjs`: `installDependencies` uses `dependenciesToInstall` and `pinDeclaredRanges` through the shared `changeDependencies`; the `dependency-range` finding's `fix` names the edit (`pnpm add name@range` would write `^<resolved>` again).
- `apps/web/tests/config/plugin-lib.test.ts`: the drift (a resolved-newer `^2.3.0` host), the subset model, the install half, and the upgrade delta (add, raise, remove-owned, remove-shared-kept, clash).
- `apps/web/tests/config/plugin-skills.test.ts`: `upgrade` end to end against a fake `pnpm` — plan, `--json`, apply, an idempotent re-run, and a refused clash.
- `.claude/skills/rf-plugin/SKILL.md`, `.claude/skills/rf-plugin/reference.md`, `docs/CONCEPTS.md` §16: the rules.
- Why: react-grid-layout 2.3.0 (2026-10-05) turned kit CI's "Install the default plugins" step red — `pnpm add react-grid-layout@^2.2.4` saved `^2.3.0`, which the check refused.
- `scripts/lib/upgrade-lib.mjs` (+ `.d.mts`): `NOTES_SUBDIR`, `notePath(workDir, file)` and `noteReportLines(...)`; a `--dry-run` names the note as `<ref>:docs/upgrades/X.Y.Z.md`, labelled as the kit's, since nothing is written.
- `scripts/upgrade.mjs`: the report's `Release notes` lines use them; `plan.json` `notes[]` gains `path` (null on a dry run); `plan.md` says where each note's copy is.
- `.claude/skills/rf-upgrade/SKILL.md`: read the notes from `.upgrade/work/<version>/notes/` or `plan.md`, never the app's `docs/upgrades/` before the apply.
- `apps/web/tests/config/upgrade-note-paths.test.ts`: runs `upgrade.mjs` over a two-release fixture kit and asserts every printed note path exists in the copy.
- Why: an agent reading the report before applying got "file does not exist" on every note, which cost each unattended upgrade (Launch's) a failed first turn.

## How to apply

1. Take `scripts/plugin.mjs`, `scripts/lib/plugin-lib.mjs` and `scripts/lib/plugin-lib.d.mts` from the kit diff; no app code, schema or toml changes.
2. Read the new `Dependencies` block in a `pnpm plugin upgrade <id>` plan before `--apply`: it can now remove a package a plugin release stopped declaring from your `package.json`.
3. Leave a `package.json` range a previous `pnpm plugin add` wrote as `^<resolved>` (for example `"react-grid-layout": "^2.3.0"` for the analytics plugin's `^2.2.4`) as it is: `pnpm plugin check` accepts a range inside the declared one.
4. This upgrade itself still runs the copy's previous `scripts/upgrade.mjs`, so its report names `docs/upgrades/<version>.md`; read the note at `.upgrade/work/<version>/notes/<version>.md` instead. Later upgrades print that path themselves.

## Conflicts to expect

- None — `scripts/` is kit-owned.
- `.claude/skills/rf-upgrade/SKILL.md` → three passages now name `.upgrade/work/<version>/notes/` → keep your own edits, take the note-location sentences.

## Verify

1. `pnpm plugin check` passes with no `dependency-range` finding for a host range inside the plugin's declared range.
2. `pnpm plugin upgrade <id>` (no `--apply`) prints a `Dependencies` block.
3. `pnpm --filter @<slug>/web exec vitest run --project config tests/config/plugin-lib.test.ts tests/config/plugin-skills.test.ts` passes.
4. `pnpm --filter @<slug>/web exec vitest run --project config tests/config/upgrade-note-paths.test.ts tests/config/upgrade-lib.test.ts` passes.
5. `pnpm kit:upgrade --dry-run` prints `Release notes (in the kit at <ref> — dry run, …)` when a release is in range.
