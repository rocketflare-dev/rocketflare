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
- The `ui` and `config` tests share one module registry per worker, as `api` does. A file that mocks a module or a global runs in the new `ui-isolated` or `config-isolated` project, chosen by the same heuristic as the api marker, so no file needs marking. The kit's ui tests drop from ~21 s to ~8 s. Every shared project sets `isolate: false` in `vitest.config.ts`, and the api and ui setups undo `vi.stubGlobal` after each file.
- `pnpm test <suite…> [file…]` (`api`, `ui`, `config`, `driver`) runs one suite, its shared and isolated projects together. The `apps/web` `test:*` scripts are one-line aliases for it, `test:shared` and `test:isolated` are gone, and no `package.json` names a vitest project any more.
- The local test worker limit rises from 6 to 10 on machines with the cores for it.
- More of the kit's tests leave a copy's gate: `ci-workflows` (the kit's workflow shape and its release-check script), the `plugin check` MCP fixtures, the 0027 migration backfill, and the pins on the kit's exact entity types and job types (`kit-makeup`). Eleven `api` files that open no database run in `config`, now guarded against outbound network like `api`.
- Tests no longer break when an app renames itself or removes chat or documents: the "never the kit's name" checks spell the name so the rename cannot rewrite it (`tests/helpers/kit-name.ts`), and the navigation test pins no removable page.
- `overrideResolveChatForTests` (`@/api/services/ai/resolve`) lets a test hand the code a fake chat client without `vi.mock`, so its file shares the `api` registry; `tests/api-setup.ts` resets it after each file. `chat.test.ts` uses it.
- The UI bundle's chunk checks run after `vite build` (`scripts/check-ui-bundle.mjs`, called by `build:ui`), so they always read the build just made; in the gate they used to skip, because the tests ran before the build.

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
10. Apply the kit diff for `apps/web/vitest.config.ts`, `apps/web/tests/helpers/isolation.ts`, `apps/web/tests/ui/setup.ts`, `apps/web/tests/api-setup.ts`, the new `apps/web/tests/config/shared-setup.ts`, `apps/web/tests/config/kit-manifest.test.ts`, `scripts/test.mjs`, `scripts/lib/test-plan.mjs` and `scripts/lib/test-plan.d.mts`.
11. In `apps/web/package.json`, delete the `test:shared` and `test:isolated` scripts and set `"test": "node ../../scripts/test.mjs web"`, and `test:api`, `test:ui`, `test:config` and `test:driver` each to `node ../../scripts/test.mjs <suite>`.
12. Anything of yours that ran `pnpm web test:shared` or `test:isolated` (a CI step, a script) runs `pnpm web test` or `pnpm test <suite>` instead.
13. Delete `apps/web/tests/config/ci-workflows.test.ts` and `apps/web/tests/api/knowledge-chunk-migration.test.ts`.
14. Move these from `apps/web/tests/api/` to `apps/web/tests/config/`, keeping each name: `ai-client`, `observability`, `agent-loop`, `agent-loop-journal`, `agent-tool-loop-interrupt`, `storage`, `plugin-signed-state`, `validate` and `isolation-contract` (each `.test.ts`), and `security/mcp-cors-paths` and `security/email-link-logging` to `apps/web/tests/config/security/`. Apply the kit diff for `isolation-contract.test.ts` (it reads `../api`).
15. Apply the kit diff for `apps/web/tests/config/{mcp,mcp-plugin-seam,plugins,knowledge-entity-types,ui-bundle}.test.ts`, `apps/web/tests/api/{mcp-server,mcp-oauth-admission,scheduled,scheduled-prune,auth-dev-login,auth-magic-link,agent-run-stream}.test.ts`, `apps/web/tests/ui/{mcp-settings,navigation-entries}.test.tsx`, `.github/workflows/ci.yml` and `deploy.yml` (comments only), and add `apps/web/tests/helpers/kit-name.ts`, `apps/web/tests/config/setup.ts` and `apps/web/scripts/check-ui-bundle.mjs`.
16. In `apps/web/package.json`, set `build:ui` to `vite build && node scripts/check-ui-bundle.mjs`.
17. Apply the kit diff for `apps/web/src/api/services/ai/resolve.ts` and `apps/web/tests/api/chat.test.ts`. A test of yours that mocks `@/api/services/ai/resolve` only to return a fake client can call `overrideResolveChatForTests(async () => ({ … }))` instead and drop its `// @vitest-isolate` line.
18. If your app has a module-level store of its own (a `zustand` `create`, a singleton client), reset it in the `afterEach` of `apps/web/tests/ui/setup.ts`.

## Conflicts to expect

- `apps/web/tests/config/<file>.test.ts` → moved to the kit-only project, which a copy does not carry → delete your copy unless you changed it.
- `apps/web/tsconfig.json` → `baseUrl` removed and `paths` made `./`-relative → keep your own extra `paths` entries, each `./`-prefixed.
- `apps/web/package.json` `test*` scripts → the kit's are now one-line `test.mjs` aliases → take the kit's, and move any project or flag of your own into `SUITES` in `scripts/lib/test-plan.mjs`.
- `apps/web/tests/ui/setup.ts` → keep your own setup lines and add the resets.

## Verify

1. `pnpm --filter @<slug>/web exec dotenv -e .env.test -- vitest run --project config` passes.
2. `ls apps/web/tests/config/rf-security` fails: the directory is gone.
3. `pnpm typecheck` passes and `pnpm exec tsc --version` prints `Version 7.0.2`.
4. `pnpm test ui` and `pnpm test config` pass, and so does `pnpm test ui config --sequence.shuffle.files` (a shared registry that leaks fails in some order).
