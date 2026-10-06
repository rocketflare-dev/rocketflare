---
version: unreleased
previous: 0.17.3
date: null
breaking: false
migrations: []
areas: [config, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

The bootstrap gets cheaper inside a coding sandbox: `--offline` no longer runs `wrangler whoami`, `--no-install` skips step 2, `ROCKETFLARE_BOOTSTRAP_SKIP` leaves out named steps and `ROCKETFLARE_ALLOW_ROOT=1` lifts the root refusal.

- `scripts/bootstrap.mjs`: step 8 under `--offline` comments `[ai]` out without asking wrangler anything; its line reads `[ai] off (--offline; wrangler login not checked)`. The tomls end up exactly as before.
- `scripts/bootstrap.mjs`: `--no-install` skips `pnpm install` and only checks `apps/web/node_modules/.bin/wrangler` exists (exit 3 if not).
- `scripts/bootstrap.mjs`: `ROCKETFLARE_BOOTSTRAP_SKIP=<comma list>` of `toolchain,install,secrets,database,migrate,plugins,seed,cloudflare` prints `skipped (ROCKETFLARE_BOOTSTRAP_SKIP)` for each; an unknown name is exit 2. Not read by `--check`.
- `scripts/bootstrap.mjs` and `scripts/bootstrap.sh`: `ROCKETFLARE_ALLOW_ROOT=1` lets either run as uid 0.
- `scripts/lib/bootstrap-lib.mjs` (+ `.d.mts`): `BOOTSTRAP_SKIPPABLE_STEPS`, `parseBootstrapSkip`; `parseBootstrapArgs` returns `skip` and `allowRoot`.
- Docs: `SETUP.md` Part 1, `docs/CONCEPTS.md` §4, `.claude/skills/rf-setup/SKILL.md`. Tests: `apps/web/tests/config/bootstrap-lib.test.ts`.

## How to apply

1. Take `scripts/lib/bootstrap-lib.mjs`, `scripts/lib/bootstrap-lib.d.mts` and `apps/web/tests/config/bootstrap-lib.test.ts` from the kit diff; port any flag the app added to `parseBootstrapArgs` into the new version.
2. Take `scripts/bootstrap.mjs` from the kit diff; when the app changed its steps, keep those and port four hunks: the `--offline` early return at the top of `stepCloudflare`, the `skipped` branch of `stepInstall`, the `maybe(...)` wrapper in `bootstrap()`, and `opts.allowRoot` in the root check.
3. In `scripts/bootstrap.sh`, let the root check pass when `ROCKETFLARE_ALLOW_ROOT` is `1`.

## Conflicts to expect

- `scripts/bootstrap.mjs` → the step calls in `bootstrap()` go through `maybe(n, name, fn)` → keep the app's own steps and wrap each of steps 1–8 the same way.

## Verify

1. `pnpm --filter @<slug>/web exec vitest run --project config tests/config/bootstrap-lib.test.ts` passes.
2. `ROCKETFLARE_BOOTSTRAP_SKIP=nope node scripts/bootstrap.mjs --no-dev` exits 2 with "unknown step nope".
3. `ROCKETFLARE_BOOTSTRAP_SKIP=toolchain,secrets,database,migrate,plugins,seed,cloudflare node scripts/bootstrap.mjs --no-install --no-dev` exits 0 and every line from 1/10 to 8/10 says `skipped`.
