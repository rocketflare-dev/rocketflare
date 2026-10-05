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

`pnpm plugin add` now writes a plugin's declared dependency range rather than pnpm's `^<resolved>`, and `pnpm plugin check` accepts any host range inside the declared one, so an upstream release no longer fails every plugin install.

- `scripts/lib/plugin-lib.mjs` (+ `.d.mts`): `rangeWithin(have, range)` — a zero-dependency npm range subset test (`^2.3.0` within `^2.2.4`; wider, disjoint, prerelease and exotic ranges are not).
- `missingDependencies` and the host half of `dependencyClashes` use `rangeWithin` instead of string equality.
- `dependenciesToInstall` and `pinDeclaredRanges`: `plugin add --apply` installs only what is unsatisfied, writes the declared range back over `pnpm add`'s output, then runs `pnpm install --no-frozen-lockfile` to re-key the lockfile.
- `scripts/plugin.mjs`: `installDependencies` uses both; the `dependency-range` finding's `fix` names the edit (`pnpm add name@range` would write `^<resolved>` again).
- `apps/web/tests/config/plugin-lib.test.ts`: the drift (a resolved-newer `^2.3.0` host), the subset model, and the install half.
- `.claude/skills/rf-plugin/reference.md`, `docs/CONCEPTS.md` §16: the rule.
- Why: react-grid-layout 2.3.0 (2026-10-05) turned kit CI's "Install the default plugins" step red — `pnpm add react-grid-layout@^2.2.4` saved `^2.3.0`, which the check refused.

## How to apply

1. Take `scripts/plugin.mjs`, `scripts/lib/plugin-lib.mjs` and `scripts/lib/plugin-lib.d.mts` from the kit diff; no app code, schema or toml changes.
2. Leave a `package.json` range a previous `pnpm plugin add` wrote as `^<resolved>` (for example `"react-grid-layout": "^2.3.0"` for the analytics plugin's `^2.2.4`) as it is: `pnpm plugin check` accepts a range inside the declared one.

## Conflicts to expect

None — `scripts/` is kit-owned.

## Verify

1. `pnpm plugin check` passes with no `dependency-range` finding for a host range inside the plugin's declared range.
2. `pnpm --filter @<slug>/web exec vitest run --project config tests/config/plugin-lib.test.ts` passes.
