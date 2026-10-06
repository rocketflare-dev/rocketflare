---
version: unreleased
previous: 0.17.3
date: null
breaking: false
migrations: []
areas: [config, docs, scripts]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

The bootstrap gets cheaper inside a coding sandbox: `--offline` no longer runs `wrangler whoami`, `--no-install` skips step 2, `ROCKETFLARE_BOOTSTRAP_SKIP` leaves out named steps and `ROCKETFLARE_ALLOW_ROOT=1` lifts the root refusal. `pnpm install` stops downloading cloudflared; `pnpm dev:tunnel` installs it the first time it needs it.

- `scripts/bootstrap.mjs`: step 8 under `--offline` comments `[ai]` out without asking wrangler anything; its line reads `[ai] off (--offline; wrangler login not checked)`. The tomls end up exactly as before.
- `scripts/bootstrap.mjs`: `--no-install` skips `pnpm install` and only checks `apps/web/node_modules/.bin/wrangler` exists (exit 3 if not).
- `scripts/bootstrap.mjs`: `ROCKETFLARE_BOOTSTRAP_SKIP=<comma list>` of `toolchain,install,secrets,database,migrate,plugins,seed,cloudflare` prints `skipped (ROCKETFLARE_BOOTSTRAP_SKIP)` for each; an unknown name is exit 2. Not read by `--check`.
- `scripts/bootstrap.mjs` and `scripts/bootstrap.sh`: `ROCKETFLARE_ALLOW_ROOT=1` lets either run as uid 0.
- `scripts/lib/bootstrap-lib.mjs` (+ `.d.mts`): `BOOTSTRAP_SKIPPABLE_STEPS`, `parseBootstrapSkip`; `parseBootstrapArgs` returns `skip` and `allowRoot`.
- `pnpm-workspace.yaml`: `cloudflared` moves from `onlyBuiltDependencies` to `ignoredBuiltDependencies`. Its postinstall downloaded the latest release (~38 MB) on every install. It is ignored rather than just unlisted, so pnpm doesn't print "Ignored build scripts".
- `apps/web/scripts/cfld.mjs` (new) + `apps/web/scripts/lib/cloudflared.mjs` (+ `.d.mts`): `dev:tunnel` and the new `cfld` script run cfld through this wrapper. When there is no `CFLD_CLOUDFLARED`/`CLOUDFLARED_BIN`, no `cloudflared` on PATH and no managed binary, it runs the package's own `bin install <version>` once, then starts cfld. The version is pinned to `2026.9.3`; `CLOUDFLARED_VERSION` overrides it.
- `apps/web/package.json`: `"dev:tunnel": "node scripts/cfld.mjs -- node scripts/tunnel-dev.mjs"`, plus `"cfld": "node scripts/cfld.mjs"` (so `pnpm web cfld setup` replaces `pnpm web exec cfld setup`).
- Docs: `SETUP.md` Part 1 (1.10 for the tunnel), `docs/CONCEPTS.md` §3 and §4, `.claude/skills/rf-setup/SKILL.md`. Tests: `apps/web/tests/config/bootstrap-lib.test.ts`, `apps/web/tests/config/cloudflared.test.ts`.

## How to apply

1. Take `scripts/lib/bootstrap-lib.mjs`, `scripts/lib/bootstrap-lib.d.mts` and `apps/web/tests/config/bootstrap-lib.test.ts` from the kit diff; port any flag the app added to `parseBootstrapArgs` into the new version.
2. Take `scripts/bootstrap.mjs` from the kit diff; when the app changed its steps, keep those and port four hunks: the `--offline` early return at the top of `stepCloudflare`, the `skipped` branch of `stepInstall`, the `maybe(...)` wrapper in `bootstrap()`, and `opts.allowRoot` in the root check.
3. In `scripts/bootstrap.sh`, let the root check pass when `ROCKETFLARE_ALLOW_ROOT` is `1`.
4. In `pnpm-workspace.yaml`, remove `cloudflared` from `onlyBuiltDependencies` and add it under `ignoredBuiltDependencies`. Keep any other entries the app added. The lockfile does not change.
5. Take `apps/web/scripts/cfld.mjs`, `apps/web/scripts/lib/cloudflared.mjs`, `apps/web/scripts/lib/cloudflared.d.mts` and `apps/web/tests/config/cloudflared.test.ts`. In `apps/web/package.json`, point `dev:tunnel` at `node scripts/cfld.mjs -- <whatever the app runs after cfld's -->` and add `"cfld": "node scripts/cfld.mjs"`.
6. Replace `pnpm web exec cfld` with `pnpm web cfld` in the app's own docs.
7. Run `pnpm install`. A managed binary that an earlier install already downloaded stays where it is and is reused. A fresh `node_modules` no longer has one, so the next `pnpm dev:tunnel` downloads it unless `cloudflared` is on PATH.

## Conflicts to expect

- `apps/web/package.json` `dev:tunnel` → if the app changed what cfld runs, keep its command and only replace the leading `cfld` with `node scripts/cfld.mjs`.
- `scripts/bootstrap.mjs` → the step calls in `bootstrap()` go through `maybe(n, name, fn)` → keep the app's own steps and wrap each of steps 1–8 the same way.

## Verify

1. `pnpm --filter @<slug>/web exec vitest run --project config tests/config/bootstrap-lib.test.ts` passes.
2. `ROCKETFLARE_BOOTSTRAP_SKIP=nope node scripts/bootstrap.mjs --no-dev` exits 2 with "unknown step nope".
3. `ROCKETFLARE_BOOTSTRAP_SKIP=toolchain,secrets,database,migrate,plugins,seed,cloudflare node scripts/bootstrap.mjs --no-install --no-dev` exits 0 and every line from 1/10 to 8/10 says `skipped`.
4. `pnpm --filter @<slug>/web exec vitest run --project config tests/config/cloudflared.test.ts` passes, and a fresh `pnpm install` leaves no `node_modules/.pnpm/cloudflared@*/node_modules/cloudflared/bin/`.
5. With no `cloudflared` on PATH, the first `pnpm web cfld doctor` prints `[cfld] cloudflared not found — installing 2026.9.3 …` and then `✔ cloudflared: cloudflared version 2026.9.3`. A second run doesn't install anything.
