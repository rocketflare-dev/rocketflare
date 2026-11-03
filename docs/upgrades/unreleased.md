---
version: unreleased
previous: 0.24.0
date: null
breaking: true
migrations: []
areas: [cli, ci, config, scripts, docs, ui, shared, api, db]
touches_surfaces: []
requires_surfaces: []
manual: true
---

## What changed

The kit runs on Node 26, React 19, React Router 7, vitest 5, zod 4, AG-UI 1.0, postgres.js 4, CASL 7 and Anthropic API 2026-10-21; every dependency is current; workflows pin Actions by SHA, with timeouts and least-privilege permissions.

- **Version-only upgrades** (no code change): every dependency to the newest release its range allows (`pnpm update -r`, 24 h publish delay), `packageManager` `pnpm@10.34.9`, `jsdom` 30, `@testing-library/jest-dom` 7 (6.10.0 is deprecated; `@testing-library/dom` becomes a peer, which `auto-install-peers` provides), `chalk` 6, `esbuild` 0.28, `@hono/zod-validator` 0.9, a regenerated `worker-configuration.d.ts`, and five Actions majors pinned as `owner/repo@<sha> # vX.Y.Z` (no input the workflows use changed).
- **Node 26 is the kit's runtime**: `.nvmrc`, `engines.node`, `@types/node` 26, `provision.ts`'s check and the docs that named Node 24. The deployed Worker is unaffected (workerd ships its own runtime).
- `apps/cli/src/auth.ts`: the callback server's 404 sends `Connection: close`. A kept-alive socket stayed in `fetch`'s pool after `close()`, so the next server on that port got `ECONNRESET` (deterministic on Node 26's undici 8).
- CI hardening: `persist-credentials: false` on every checkout, `timeout-minutes` on every job, `permissions: contents: read` where nothing writes, no `cache: pnpm` in the deploy jobs (a poisoned cache would reach a deployed bundle), the release tag read through `env:`, gitleaks checked by SHA-256, and `evals.yml`'s suite filter quoted.
- vitest 5 (`apps/web`, `apps/cli`; `apps/evals` stays on 4 for `vitest-evals`): on Node 25+ a stub `localStorage` shadowed jsdom's, and only vitest 5 overrides it. `poolOptions` and `coverage.all` are gone from the config. Behaviour your tests may meet: `clearMocks` defaults to `true`, an unawaited `.resolves`/`.rejects` fails, `-t` matches the `>`-joined full name.
- Biome 2.6: `biome.json` migrated (`"preset": "recommended"`); the new `noComponentHookFactories` is off for tests and suppressed on `schemaForm`'s `Component`, which is created once.
- zod 4 travels with AG-UI 1.0 (`@ag-ui/*` `1.0.3`, exact): AG-UI's validators are zod 4 schemas, imported from `@ag-ui/core/schemas`, with zod as a peer. `zod-to-json-schema` gives way to `z.toJSONSchema`, the protobuf transport now carries `TOOL_CALL_RESULT`, and `JobVariant`/`JobTypeOf` in the plugin API use zod 4's types. Analytics 3.8.1 installs unchanged.
- zod 4 applies a field's `.default()` under `.partial()`, so a PATCH schema built that way overwrites an omitted field. `example-feature`'s `updateExampleNoteRequestSchema` is rebuilt to avoid it; no kit schema had the shape.
- postgres.js 4 (`apps/evals` declares it too, so one `drizzle-orm` resolves): same API on a new pool and protocol, `cloudflare:sockets` on Workers (+~23 KiB gzip). A `Date` sent to a `timestamp`/`date` column without a fixed type now goes as UTC; all 42 kit timestamp columns are `withTimezone: true`.
- CASL 7; `@casl/react` removed (its 7.x drops `createContextualCan`, and the kit never rendered `<Can>`). `IfCan`, `IfCannot` and `usePermissions` are the UI's only gates, and they still deny outside an `AbilityProvider`.
- `@anthropic-ai/sdk` 1.x sends API version `2026-10-21` (migration guide: https://platform.claude.com/docs/en/api/migration-2026-10-21) and is Apache-2.0. The `anthropic` adapter never sends `temperature`, which that version rejects; the other providers still take it, and the evals judge now samples at the default on pre-4.7 Claude models. The key goes as `Authorization: Bearer`, so a proxy reading `X-Api-Key` must change. `anthropic_compatible` vendors also receive the new version.
- dotenv 18 (`apps/evals`) ships its own `dotenv` bin, which displaced `dotenv-cli`'s and broke `dotenv -e .env.test --` scripts, so `apps/web` drops its unused `dotenv`.
- Vite 8 and `@vitejs/plugin-react` 6: Rolldown builds and Oxc minifies (`build.minify: 'esbuild'` dropped). The Vite and vitest configs use `import.meta.dirname` and extensioned imports (Vite 8 warns on both), and `HttpProxy.ProxyServer` (http-proxy-3). `MagicLinkSentCard` moves to `ui/components/`, so `/magic-link/sent` actually splits. Analytics 3.8.1's `@nivo/heatmap` alias line uses `import.meta.dirname` too.
- React 19 and React Router 7. The kit imports `react-router`; `react-router-dom` 7 stays installed because installed plugins still import it until their 4.0.0. Router 7 has no `future` prop, so `App.tsx` and `renderWithProviders` drop it, and `tests/ui/setup.ts` no longer filters Router's future-flag warnings. React 19's types make `useRef<T>(null)` a `RefObject<T | null>` and drop the global `JSX` namespace.
- `defaultPlugins` installs analytics 3.8.1: drizzle-cube 0.12.2, React 19 types, and `GET /api/analytics/facts/status` scoped to the caller's organisation (its own `docs/upgrades/3.8.1.md`).

## How to apply

1. In `apps/cli/src/auth.ts` `handleCallback`, add `Connection: 'close'` to the 404 `res.writeHead(...)` headers. In `apps/cli/tests/login.test.ts`'s test "rejects on ?error= and on missing key/tenant_id, 404s other paths", assert that the `/other` response's `connection` header is `close`.
2. In `.github/workflows/ci.yml`, `deploy.yml` and `evals.yml`, replace each Action that the file uses: `actions/checkout@v4` → `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`, `actions/setup-node@v4` → `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0`, `pnpm/action-setup@v4` → `pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0`, `actions/upload-artifact@v4` → `actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2`, `actions/download-artifact@v4` → `actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2`.
3. Under every `actions/checkout` step in `.github/workflows/`, add `persist-credentials: false` to its `with:` block (create the block where the step has none), unless one of your own later steps pushes with the checkout's token.
4. If your `apps/web/tests/config/ci-workflows.test.ts` still matches `actions/checkout@v4` or `actions/download-artifact@v4` literally, match `actions\/checkout@\S+` and `actions\/download-artifact@\S+` instead.
5. In `.github/workflows/ci.yml`, `deploy.yml` and `evals.yml`, add `timeout-minutes:` under each job's `runs-on:` — the kit uses 15 for `ci.yml`'s `gate`, 5 for `deploy.yml`'s `guard` and `gated`, 20 for `staging` and `production`, 10 for `release-bundle`; size your own jobs from their run history.
6. In `.github/workflows/evals.yml`, add a top-level `permissions:` block with `contents: read`, and change `pnpm eval $SUITE` to `pnpm eval ${SUITE:+"$SUITE"}`.
7. In `.github/workflows/deploy.yml`, delete `cache: pnpm` from the `actions/setup-node` step of the `staging` and `production` jobs. In `production`, give the "Resolve release version" step `env: { EVENT_NAME: ${{ github.event_name }}, RELEASE_TAG: ${{ github.event.release.tag_name }} }` and use `"$EVENT_NAME"` and `"$RELEASE_TAG"` in its script instead of the two `${{ }}` expressions.
8. In `.github/workflows/ci.yml`, replace the gitleaks step's `curl … | tar` with: `shell: bash`, `env: GITLEAKS_SHA256: 9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c`, a `curl -sSfL -o "$RUNNER_TEMP/gitleaks.tar.gz"` download, `echo "$GITLEAKS_SHA256  $RUNNER_TEMP/gitleaks.tar.gz" | sha256sum --check --strict`, then `tar -xzf` of that file. Keep the word `gitleaks` on every script line: `ci-workflows.test.ts` recognises the scan's commands by it.
9. Write `26` to `.nvmrc`, set the root `package.json` `engines.node` to `">=26"` and `"packageManager"` to `"pnpm@10.34.9"`, run `nvm install` (or `fnm use --install-if-missing`), then `pnpm update -r --config.minimum-release-age=1440`. If your own tests assert the `.nvmrc` major (the kit's `tests/config/bootstrap-lib.test.ts` does), expect `26`; in `apps/web/scripts/provision.ts`, change `major < 24` to `major < 26` and its message to `Node 26`.
10. Run these, with your package scope for `<scope>`, then `pnpm install` so every package links the same `drizzle-orm` (the Anthropic SDK brings `@opentelemetry/api`, one of its optional peers, and `--filter` alone leaves `apps/evals` on the old copy); `pnpm-lock.yaml` should then name a single `drizzle-orm@…(postgres@4.0.0)`:
    - `pnpm --filter <scope>/shared add zod@^4.6.7 @casl/ability@^7.1.1` and `pnpm --filter <scope>/shared add @ag-ui/core@1.0.3 --save-exact`
    - `pnpm --filter <scope>/web add zod@^4.6.7 postgres@^4.0.0 @casl/ability@^7.1.1 @anthropic-ai/sdk@^1.3.0 @hono/zod-validator@^0.9.1` and `pnpm --filter <scope>/web add @ag-ui/core@1.0.3 @ag-ui/encoder@1.0.3 @ag-ui/proto@1.0.3 --save-exact`
    - `pnpm --filter <scope>/web add -D vitest@^5.0.5 @vitest/coverage-v8@^5.0.5 @testing-library/jest-dom@^7.0.1 jsdom@^30.1.3 @types/node@^26.6.6 vite@^8.3.5 @vitejs/plugin-react@^6.2.1`
    - `pnpm --filter <scope>/web add react@^19.3.1 react-dom@^19.3.1 react-router@^7.18.5 react-router-dom@^7.18.5` and `pnpm --filter <scope>/web add -D @types/react@^19.3.0 @types/react-dom@^19.3.0`
    - `pnpm --filter <scope>/web remove zod-to-json-schema @casl/react`
    - `pnpm --filter <scope>/cli add zod@^4.6.7 chalk@^6.0.1` and `pnpm --filter <scope>/cli add -D vitest@^5.0.5 esbuild@^0.28.2 @types/node@^26.6.6`
    - `pnpm --filter <scope>/evals add zod@^4.6.7` and `pnpm --filter <scope>/evals add -D postgres@^4.0.0 dotenv@^18.0.9 @types/node@^26.6.6` (leave its vitest on 4)
11. If nothing under `apps/web` imports `dotenv` (`rg -n "from 'dotenv'" apps/web`), run `pnpm --filter <scope>/web remove dotenv`. If something does, keep it on `^17`: from 18 its `dotenv` bin displaces `dotenv-cli`'s.
12. In `apps/web/vitest.config.ts`, replace the `poolOptions: { forks: { maxForks, minForks } }` block with a top-level `maxWorkers: MAX_WORKERS`, and delete `all: true` from `coverage`. Then run your own tests and fix what vitest 5's behaviour changes break: `clearMocks` defaults to `true`, an unawaited `expect(...).resolves`/`.rejects` fails the test, and `-t` matches the `>`-joined full test name.
13. Run `pnpm exec biome migrate --write`. In `biome.json`, add an `overrides` entry for `apps/*/tests/**/*.ts`, `apps/*/tests/**/*.tsx` and `apps/web/src/plugins/*/tests/**` that sets `linter.rules.correctness.noComponentHookFactories` to `"off"`. Where `pnpm lint` still reports it in `src/`, hoist the component out of the function, or, if the factory's result is created once (as `schemaForm`'s is), add a `// biome-ignore lint/correctness/noComponentHookFactories: <why>` line above it.
14. In `packages/shared/src/ai/agui.ts`, import `EventType` and the `Interrupt` type from `@ag-ui/core`, and every `*Schema` from `@ag-ui/core/schemas`. In `apps/web/src/api/services/ai/agui.ts`, set `PROTO_UNSUPPORTED_EVENTS` to `[]`.
15. In `apps/web/src/api/services/ai/agent-loop.ts`, replace `zodToJsonSchema(schema, { target: 'jsonSchema7' })` with `z.toJSONSchema(schema, { target: 'draft-7', io: 'input', unrepresentable: 'any' })`.
16. In `packages/shared/src/plugins/types.ts`, set `JobVariant` to `ZodObject<{ type: ZodTypeAny } & ZodRawShape>` and `JobTypeOf<S>` to `TypeOf<NonNullable<DeclaredBy<S, 'jobs'>>[number]['shape']['type']>`, importing `ZodObject`, `ZodRawShape` and `ZodTypeAny` from `zod`.
17. Search your own schemas for `.partial()` over an object with a `.default(` field (`rg -n '\.partial\(' packages apps`): under zod 4 the default fills an omitted field, so a PATCH overwrites it. Rebuild each such update schema from the create schema's fields with `.unwrap().optional()` on the defaulted ones, as `example-feature`'s `updateExampleNoteRequestSchema` now is.
18. Run `pnpm typecheck`, commit the regenerated `apps/web/worker-configuration.d.ts`, and fix what zod 4 reports in your own code: `z.ZodType<T, z.ZodTypeDef, unknown>` → `z.ZodType<T, unknown>`, give `z.record(v)` a key schema (`z.record(z.string(), v)`), rename `invalid_type_error`/`required_error` to `error`, and narrow `TOOL_CALL_RESULT.content` with `typeof content === 'string'` where you read it as a string.
19. If your own schema has a `timestamp()` or `date()` column without `withTimezone: true`, or a raw `sql` template passes a `Date` where the query does not fix its type (`date_trunc('day', ${d})`), cast it (`${d}::timestamptz`) or read postgres.js's v4 upgrade guide: v4 sends such a `Date` as UTC. If your code calls `sql.array()`, pass the array with a cast (`${ids}::int[]`) — v4 removed it.
20. In `apps/web/src/ui/components/permissions/AbilityContext.tsx`, delete the `createContextualCan` import and the `Can` export and stop exporting `AbilityContext`; drop both names from `components/permissions/index.ts`. Replace each `<Can I="x" a="Y">` in your own pages with `<IfCan action="x" subject="Y">`, `<Can not …>` with `<IfCannot …>`, and a `passThrough` or render-function `<Can>` with `usePermissions().can('x', 'Y')`. If your `AppAbility` checks record instances (`this=`, `field`), keep `@casl/react@^7.1.0` and wrap the tree in its `<AbilityProvider value={ability}>`; its `useAbility()` throws outside that provider.
21. If your code uses `PureAbility` (now `createMongoAbility` / `MongoAbility`), `rulesToQuery` (now `rulesToCondition`) or `getDefaultErrorMessage` (removed), update it. A rule with `{}` conditions now matches like one without conditions, and setting `__caslSubjectType__` by hand throws (use `subject()`).
22. In `apps/web/src/api/services/ai/client.ts`, send `body.temperature` only when `provider === 'anthropic_compatible'` (keep the existing trait and thinking checks), and build both providers' SDK client with `new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseUrl || undefined, fetch: opts.fetch, maxRetries: 2 })`. In `agent-loop.ts` `withRollingCacheBreakpoints`, skip a message whose `role` is `'system'` before spreading it with new `content`.
23. If your own code sends `temperature`, `top_p` or `top_k` to Claude, builds a `document` block into an `assistant` message, or sends `citations` on a `text` block in a `user` message, remove it: each is a 400 on `2026-10-21`. If it relied on a non-default `temperature`, decide whether the default output is acceptable (the migration guide lists the alternatives). If a proxy or gateway in front of the Claude API reads `X-Api-Key`, change it to read `Authorization: Bearer`.
24. If your own Vite config sets `build.rollupOptions`, rename it `build.rolldownOptions`. In `apps/web/vite.config.ts`, delete `minify: 'esbuild'` and type `onProxyError`'s parameter `HttpProxy.ProxyServer`. Replace every `__dirname` with `import.meta.dirname` there and in `apps/web/vitest.config.ts`, `apps/evals/vitest.config.ts` and `apps/evals/vitest.unit.config.ts`, and add `.ts` to `apps/web/vitest.config.ts`'s two `./tests/helpers/` imports.
25. Move `MagicLinkSentCard` from `ui/pages/MagicLinkSent.tsx` to `ui/components/MagicLinkSentCard.tsx` and import it from there in `Login.tsx` and `MagicLinkSent.tsx`.
26. Run `pnpm plugin upgrade analytics --to 3.8.1 --apply` (it needs React 19 and Router 7 from step 10), and if `.rocketflare.json` lists analytics in `defaultPlugins`, set its `ref` to `3.8.1` there and in `launch.kit.json`'s `plugins.defaults`.
27. In every file under `apps/web` that imports `'react-router-dom'`, import `'react-router'` instead, except in the tree of a plugin installed from a repository: its own release changes it.
28. Delete the `future={{ v7_startTransition: true, v7_relativeSplatPath: true }}` prop from the `BrowserRouter` in `ui/App.tsx`, the `MemoryRouter` in `tests/ui/helpers/renderWithProviders.tsx` and any router your own tests render, then delete the `React Router Future Flag Warning` filter from `tests/ui/setup.ts`.
29. Run `pnpm typecheck` and fix what React 19's types report in your own code: give `useRef` an argument (`useRef<T>(null)`), widen a prop that receives it to `RefObject<T | null>`, and write `React.JSX.Element` for a bare `JSX.Element`.

## Conflicts to expect

- `.github/workflows/**` → `manual`; the patch is not applied → follow steps 2, 3 and 5–8 by hand.
- Every `package.json` and `pnpm-lock.yaml` → versions, `engines` and `packageManager` changed → apply steps 9–11 instead of the hunks.
- `.nvmrc` → `24` → `26` → take `26` unless your app deliberately pins another Node.
- `apps/web/worker-configuration.d.ts` → regenerated → take yours and re-run step 18.
- `apps/web/tests/config/ci-workflows.test.ts` → three version assertions loosened → keep your edits and apply step 4.
- `apps/web/vitest.config.ts`, `apps/evals/vitest*.config.ts` → pool, coverage, `__dirname` and imports changed → apply steps 12 and 24 by hand if you edited them.
- `biome.json` → schema migrated and a test override added → apply step 13 by hand if you edited the file.
- `packages/shared/src/ai/agui.ts` → the `@ag-ui/core` import is split in two → apply step 14 by hand if you edited the imports.
- `packages/shared/src/plugins/types.ts` → `JobVariant` and `JobTypeOf` rewritten → take the kit's two declarations from step 16.
- `apps/web/src/ui/components/permissions/{AbilityContext.tsx,index.ts}` → `Can` and the context export removed → apply step 20 by hand if you edited them.
- `apps/web/src/api/services/ai/client.ts` → one Anthropic client constructor, `temperature` compatible-only → apply step 22 by hand if you edited the adapter.
- `apps/web/vite.config.ts` → minify, `__dirname` and the proxy type changed → apply step 24 by hand if you edited the file.
- `.rocketflare.json`, `launch.kit.json` → the analytics `ref` changed → take `3.8.1` as in step 26.
- `apps/web/src/ui/App.tsx`, `tests/ui/helpers/renderWithProviders.tsx`, `tests/ui/setup.ts` and every file importing the router → the import and the `future` prop changed → apply steps 27 and 28 by hand if you edited them.

## Verify

1. `node -v` prints `v26.`, `pnpm -v` prints `10.34.9`, and `pnpm gate` passes with no `(!)` warning.
2. `pnpm --filter <scope>/web list zod postgres @anthropic-ai/sdk vitest vite jsdom react react-router --depth 0` shows `zod@4.`, `postgres@4.`, `@anthropic-ai/sdk@1.`, `vitest@5.`, `vite@8.`, `jsdom@30.`, `react@19.`, `react-router@7.`.
3. `grep -rnE 'uses: [^@]+@v[0-9]' .github/workflows` prints nothing.
4. `grep -c 'persist-credentials: false' .github/workflows/*.yml` matches the number of `actions/checkout` steps in each file, and `rg -c 'timeout-minutes' .github/workflows/{ci,deploy,evals}.yml` counts one per job.
5. `rg -n 'cache: pnpm' .github/workflows/deploy.yml` prints nothing.
6. `pnpm web test:config` passes, including `tests/config/agui-contract.test.ts`'s protobuf round-trip.
7. `pnpm test` passes, including the driver conformance pass under `neon`.
8. `rg -n 'zod-to-json-schema' apps packages` prints nothing, and `rg -n '@casl/react|<Can[ >]' apps packages` prints nothing (unless step 20 kept `@casl/react`).
9. `rg -n -i 'anthropic[-_]version' apps/*/src packages/*/src` prints nothing (no override of the SDK's version).
10. `pnpm --filter <scope>/web exec dotenv -e .env.test -- node -e 'console.log(!!process.env.DATABASE_URL)'` prints `true`.
11. `rg -n 'future=\{\{' apps/web` prints nothing, and `pnpm plugin list` shows analytics at `3.8.1`.
