---
version: unreleased
previous: 0.42.0
date: null
breaking: false
migrations: []
areas: []
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

A copy's gate no longer runs the kit's tooling tests, which now live in the kit-only project, and
`pnpm plugin` runs the host's Biome directly instead of through `pnpm exec`.

- The tests of `scripts/**` and the rf-security runner moved from `apps/web/tests/config/` to `apps/web/tests/kit-only/` (rationale: `docs/CONCEPTS.md` §13, "Kit-only files").
- The toml snapshots moved with `patch-toml.test.ts`, from `apps/web/tests/config/fixtures/` to `apps/web/tests/kit-only/fixtures/`.
- `scripts/plugin.mjs` runs `node_modules/.bin/biome`, and skips formatting with a warning when the host has none.
- `tsc` is TypeScript 7.0.2, the native compiler: the web typecheck drops from ~14 s to ~3 s and needs no 4 GB heap; code that parses TypeScript imports `typescript6` (`npm:typescript@6.0.3`).
- The `ui` tests share one module registry per worker; a file that mocks a module or a global runs in the new `ui-isolated` project, chosen by the same heuristic the api marker uses, so no file needs marking. The kit's ui tests drop from ~21 s to ~8 s.

## How to apply

1. Delete these files from `apps/web/tests/config/`: `plugin-catalogue`, `plugin-host-seams`, `plugin-lib`, `plugin-path-containment`, `plugin-skills`, `repo-paths`, `surface`, `upgrade-apply`, `upgrade-continue`, `upgrade-lib`, `upgrade-note-paths`, `manifest-lib`, `update-check-lib`, `json-format`, `bundle`, `bundle-lib`, `deployer`, `release-version-only`, `gate-verified`, `gate`, `bootstrap-lib`, `prereqs-sh`, `cloudflared`, `dev-ai`, `dev-ports`, `dev-wrangler-launch`, `tunnel-dev`, `design-docs`, `provision-email`, `provision-neon`, `provision-redact`, `provision-tokens`, `provision-zone`, `patch-toml` and `plugin-resources`, each with the `.test.ts` suffix. Keep any of them you changed for your own tooling.
2. Delete the directories `apps/web/tests/config/rf-security/` and `apps/web/tests/config/fixtures/`.
3. Apply the kit diff for `scripts/plugin.mjs`.
4. Apply the kit diff for `.claude/rules/testing.md` (the "Kit-only tests" paragraph).
5. Set `"typescript": "^7.0.2"` in the root, `apps/web`, `apps/cli`, `apps/evals` and `packages/shared` `package.json`, and add `"typescript6": "npm:typescript@6.0.3"` to the root and `apps/web` devDependencies.
6. In `apps/web/package.json`, set the `typecheck` script to `pnpm types && tsc --noEmit`.
7. Remove `baseUrl` from `apps/web/tsconfig.json` and `apps/evals/tsconfig.json`, and prefix each of their `paths` targets with `./` (`"@/*": ["./src/*"]`).
8. Change `import ts from 'typescript'` to `import ts from 'typescript6'` in `apps/web/tests/config/{driver-conformance,driver-results,shared-imports,unscoped-allowlist}.test.ts` and `scripts/plugin-api-doc.mjs`, and `require('typescript')` to `require('typescript6')` in `scripts/lib/surface.mjs`. Do the same in any file of your own that imports `typescript` for its API.
9. Run `pnpm install`.
10. Apply the kit diff for `apps/web/vitest.config.ts` (`uiTestFiles`, `uiProject`, the `ui` and `ui-isolated` projects), `apps/web/tests/helpers/isolation.ts` (`uiNeedsIsolation`, `testFiles`), `apps/web/tests/ui/setup.ts` (the singleton resets and `vi.unstubAllGlobals()`) and `scripts/lib/test-plan.mjs`.
11. In `apps/web/package.json`, add `--project ui-isolated` after `--project ui` in the `test:isolated` and `test:ui` scripts.
12. If your app has a module-level store of its own (a `zustand` `create`, a singleton client), reset it in the `afterEach` of `apps/web/tests/ui/setup.ts`.

## Conflicts to expect

- `apps/web/tests/config/<file>.test.ts` → moved to the kit-only project, which a copy does not carry → delete your copy unless you changed it.
- `apps/web/tsconfig.json` → `baseUrl` removed and `paths` made `./`-relative → keep your own extra `paths` entries, each `./`-prefixed.
- `apps/web/package.json` `test:isolated` → your copy has no `--project kit-only` (the rename removed it) → keep your line and add only `--project ui-isolated`.
- `apps/web/tests/ui/setup.ts` → keep your own setup lines and add the resets.

## Verify

1. `pnpm --filter @<slug>/web exec dotenv -e .env.test -- vitest run --project config` passes.
2. `ls apps/web/tests/config/rf-security` fails: the directory is gone.
3. `pnpm typecheck` passes and `pnpm exec tsc --version` prints `Version 7.0.2`.
4. `pnpm web test:ui` passes, and `pnpm --filter @<slug>/web exec dotenv -e .env.test -- vitest run --project ui --project ui-isolated --sequence.shuffle.files` passes too.
