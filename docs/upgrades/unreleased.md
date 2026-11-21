---
version: unreleased
previous: 0.41.1
date: null
breaking: false
migrations: []
areas: [api, config, docs, shared, ui]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

A second batch of field-report fixes: a WSL-aware `bootstrap.sh`, seed credentials labelled as local demo values, one shared dev-account list with relabelable roles, and four plugin-seam gaps (`apiKeyId`, guarded settings tabs, `hooks.seed`, `seed --feature`).

- `bash scripts/bootstrap.sh` knows WSL2 (`scripts/lib/prereqs.sh`). Run as root in WSL, it prints the `adduser` and `wsl -d <distro> -u <name>` steps. With `docker` missing inside WSL, it says to turn on Docker Desktop's WSL integration, then quit and restart Docker Desktop. With no fnm or nvm, it prints the documented nvm install. A `node`, `corepack`, `pnpm` or `docker` that resolves under `/mnt/<drive>/` (Windows' PATH leaking in) is ignored. pnpm is installed with the active Node's own corepack if it ships one, else with its `npm` (Node 26 ships no corepack). `SETUP.md` has a "Windows (WSL2) — before you start" block.
- `pnpm seed` labels its credentials as local demo values. The API key prints on one line labelled `api key:` with a "local demo key … safe to discard" note under it. The invite URL prints as a `local demo link (this machine only)`. `extractSeedKey` (`scripts/lib/bootstrap-lib.mjs`) reads the labelled line and still accepts the old banner.
- The seeded dev accounts are now one list: `DEV_ACCOUNTS` in `apps/web/src/ui/lib/dev-accounts.ts` (`{ email, name, role, isGlobalAdmin? }`). `scripts/seed.ts` reads it, and so do the login page's quick-login buttons and its `?as=` allow-list (now case-insensitive). `--demo` finds the admin and member accounts by role, not by position.
- Roles reach the screen through `roleLabel(role)` / `ROLE_LABELS` in `@rocketflare/shared/tenants` instead of the raw value styled with CSS `capitalize`. This covers `RoleBadge`, the role pickers (invite, People, approve request), the user menu, Home and the pending-invitations banner. Visible text is now `Owner` / `Admin` / `Member` / `Support`.
- Plugin seam: `RequestCtx.apiKeyId` (on `PluginAuth`) is the id of the API key a Bearer request came in on, `null` for a session, and never the secret (`apiKeyIdOf(auth)` in `api/auth/api-key-session.ts`). `makeRequestCtx` accepts `apiKeyId`.
- Plugin seam: a `settingsTabs` tab can carry a `guard` (`PluginSettingsTab`, exported from `@/plugins/api` and `@/plugins/api/ui-wiring`). `SettingsLayout` and `navigationEntries` check it with `useNavGuard`, so `{ feature: 'x' }` hides the tab in an organisation without the flag.
- Plugin seam: `ServerPlugin.hooks.seed` runs on every `pnpm seed`, with or without `--demo`, before the demo data. `PluginSeedContext` (and `SeedCtx`, where it is optional) gains `setFeature(key, enabled = true, tenantId = seeded tenant)`, which writes a per-organisation override (an unknown key throws). `pnpm seed --feature <key>[=on|off][@<tenant-slug>]` (repeatable) writes the same override after the hooks and the demo (`apps/web/scripts/lib/seed-features.ts`). Rationale: `docs/CONCEPTS.md` §16 "Hooks".

## How to apply

1. Take `scripts/bootstrap.sh` and the new `scripts/lib/prereqs.sh` together; the script sources the library.
2. Take `extractSeedKey` in `scripts/lib/bootstrap-lib.mjs` and the verify wording in `stepSeed` in `scripts/bootstrap.mjs`.
3. Add `apps/web/src/ui/lib/dev-accounts.ts` and move your accounts into its `DEV_ACCOUNTS`. If you added accounts to `Login.tsx` or `seed.ts`, merge them in with a `name` and a `role`. Then take `Login.tsx`'s use of `isDevAccount` / `devAccountLabel`, and the `SEED_USERS` / `SEED_OWNER` / `GLOBAL_ADMIN` derivation at the top of `apps/web/scripts/seed.ts`.
4. Take `ROLE_LABELS` / `roleLabel` in `packages/shared/src/tenants.ts` and every `roleLabel(...)` call site in `apps/web/src/ui`. If you relabelled roles by hand anywhere, move the words into `ROLE_LABELS`. A UI test of yours that matches a lowercase role (`getByText('owner')`) now has to match `'Owner'`.
5. Take `apiKeyId` in `apps/web/src/plugins/api/auth.ts` and `apps/web/src/plugins/api/http.ts`, `apiKeyIdOf` in `apps/web/src/api/auth/api-key-session.ts`, and the `apiKeyId` option in `apps/web/tests/kit/unit.ts`.
6. Take `PluginSettingsTab` in `apps/web/src/plugins/types.ts`, its exports from `apps/web/src/plugins/api/index.ts` and `apps/web/src/plugins/api/ui-wiring.ts`, and the tab filter in `apps/web/src/ui/pages/settings/SettingsLayout.tsx` and `apps/web/src/ui/hooks/useNavigationEntries.ts`.
7. Add `apps/web/scripts/lib/seed-features.ts`. Take `hooks.seed` and `setFeature` in `apps/web/src/plugins/types.ts` and `apps/web/src/plugins/api/db.ts`, then the `runPluginSeedHooks` / `applySeedFeatures` calls and `pluginSeedContext` in `apps/web/scripts/seed.ts`.

## Conflicts to expect

- `apps/web/scripts/seed.ts` → the account constants, the key and invite lines and the plugin hook loop changed → keep your own seed blocks; take the constants, the labelled lines and `runPluginSeedHooks`.
- `apps/web/src/ui/pages/Login.tsx` → `DEV_ACCOUNTS` moved out → keep your accounts in `apps/web/src/ui/lib/dev-accounts.ts`.
- `scripts/bootstrap.sh` → the OS, root, docker, node and pnpm checks changed → keep any check you added and take the kit's version of the rest.

## Verify

1. `bash scripts/bootstrap.sh --help` prints `✔ os`, `✔ git`, `✔ docker`, `✔ node` and `✔ pnpm` before the usage text.
2. On a fresh dev database, `pnpm seed` prints `api key: …` with the local-demo note under it, and `pnpm seed --feature knowledge-facts` ends with `feature knowledge-facts … on for acme`.
3. `/login` in development shows quick-login buttons named from `ROLE_LABELS`, and Settings → People shows `Owner`, not `owner`.
4. `pnpm gate` passes.
