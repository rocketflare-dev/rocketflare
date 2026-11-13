---
version: unreleased
previous: 0.36.0
date: null
breaking: false
migrations: []
areas: [api, tooling, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

0.36.0 copies could not deploy: the public-sites cache made a random id at module load, which Cloudflare refuses; it is now made on first use, a test loads the Worker to catch it, and upgrades finish cleanly after rejects.

- `apps/web/src/api/middleware/public-sites.ts`: the development boot id is made on first use; `crypto.randomUUID()` at module scope failed every deploy with Cloudflare error 10021.
- New `apps/web/tests/config/global-scope.test.ts`: loads `src/worker.ts` (every installed plugin included) with random values, timers and `fetch` made to throw, as the upload does.
- `pnpm kit:upgrade --continue`: after an `--apply` that left rejects, records the version, commit and history once every `*.rej` is resolved.
- `pnpm plugin upgrade <id> --continue`: the same finish for a plugin; it never re-patches.
- `pnpm plugin upgrade` formats every file it added or patched (translation to a longer app name pushed lines past the limit), and `add`/`upgrade` warn when a core edit's lines were partly in the file already.
- The 0.36.0 note's step 7 names a `version_metadata` entry in `wrangler-parity.test.ts` that the release does not contain; skip it.

## How to apply

1. In `apps/web/src/api/middleware/public-sites.ts`, replace `const DEV_BOOT_ID = crypto.randomUUID()` with `let devBootId: string | undefined`, and in `deploymentOf` return `devBootId ??= crypto.randomUUID()` (as two statements) under `APP_ENV === 'development'`.
2. Copy `apps/web/tests/config/global-scope.test.ts` from the release.
3. Port `scripts/upgrade.mjs` (`--continue`, `stampUpgrade`, `continueUpgrade`), `scripts/plugin.mjs` (`--continue`, `formatWritten` over what an upgrade wrote, `partialCoreEdits` warnings) and `scripts/lib/plugin-lib.mjs` (`partialCoreEdits`) from the release.
4. Copy `apps/web/tests/config/upgrade-continue.test.ts`, and port the new cases in `apps/web/tests/config/plugin-host-seams.test.ts` and `apps/web/tests/config/plugin-lib.test.ts` from the release.
5. Port the `--continue` paragraphs in `.claude/skills/rf-upgrade/SKILL.md` and `.claude/skills/rf-plugin/SKILL.md`, and the global-scope rule in `.claude/rules/cloudflare.md`.

## Conflicts to expect

- `apps/web/src/api/middleware/public-sites.ts` → the boot id is made on first use → keep the release's lines; a copy that fixed it already keeps its own.
- `scripts/upgrade.mjs` → the stamp moved into `stampUpgrade` → take the release's file and re-apply your own edits.

## Verify

1. `pnpm gate` passes.
2. `pnpm run deploy` (or `pnpm provision deploy production`) uploads without `Disallowed operation called within global scope`.
3. `pnpm kit:upgrade --help` and `pnpm plugin --help` list `--continue`.
