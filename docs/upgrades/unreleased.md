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

`pnpm plugin add` writes a plugin's declared dependency range, `pnpm plugin check` accepts any host range inside it, and `pnpm plugin upgrade --apply` now installs, re-ranges and removes the dependencies a plugin release changes.

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

## How to apply

1. Take `scripts/plugin.mjs`, `scripts/lib/plugin-lib.mjs` and `scripts/lib/plugin-lib.d.mts` from the kit diff; no app code, schema or toml changes.
2. Read the new `Dependencies` block in a `pnpm plugin upgrade <id>` plan before `--apply`: it can now remove a package a plugin release stopped declaring from your `package.json`.
3. Leave a `package.json` range a previous `pnpm plugin add` wrote as `^<resolved>` (for example `"react-grid-layout": "^2.3.0"` for the analytics plugin's `^2.2.4`) as it is: `pnpm plugin check` accepts a range inside the declared one.

## Conflicts to expect

None — `scripts/` is kit-owned.

## Verify

1. `pnpm plugin check` passes with no `dependency-range` finding for a host range inside the plugin's declared range.
2. `pnpm plugin upgrade <id>` (no `--apply`) prints a `Dependencies` block.
3. `pnpm --filter @<slug>/web exec vitest run --project config tests/config/plugin-lib.test.ts tests/config/plugin-skills.test.ts` passes.
