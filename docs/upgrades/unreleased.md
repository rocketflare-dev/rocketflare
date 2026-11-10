---
version: unreleased
previous: 0.29.0
date: null
breaking: false
migrations:
  - "documents.tenant_id and chunks.tenant_id nullable (platform documents), a CHECK and a partial unique index on documents, SELECT-only platform read policies on both"
areas: [api, ui, config, scripts, docs, db]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Plugins can serve whole public hosts through a new `publicSites` seam, with a strict per-site CSP, multi-host provisioning, a `workspace` UI route tier and a tenant resolver; an app with no such plugin sees no routing change.

- `ServerPlugin.publicSites` (`hosts`, `router`, `csp`, `forms`, `cache`) is served by `apps/web/src/api/middleware/public-sites.ts`, after `databaseMiddleware` and before every mount.
- `apps/web/src/api/middleware/security-headers.ts` sends a strict public CSP on a site host; a site's declared sources extend it and inline script stays banned.
- `publicSiteIssues` fails the gate on a duplicate host, a claim on `APP_URL`'s host or an unsafe declared CSP source.
- The manifest field `"publicSites": { "hostsVar": "SITES_HOSTS" }` makes `pnpm provision` write `run_worker_first = ["/*", "!/assets/*", "!/site-assets/*"]`, `not_found_handling = "none"` and one route per declared host in both tomls.
- `pnpm plugin add` applies those two values and keeps the previous lines in marked comments; `pnpm plugin remove` restores them. `pnpm provision urls` writes the app host plus every host in the toml's hosts var and refuses site hosts while the app is on `workers.dev`.
- The ordinary gate no longer requires a plugin's bindings, migration tag or non-secret vars before provisioning, matching crons and prefixes. `REQUIRE_PROVISIONED=1` still demands all of them, so a deploy is stopped as before.
- `publicSites.cache` gains `variant` (one entry per value, such as a negotiated image format) with `variantHeaders` naming the headers it reads. A cacheable request reaches the router without `Cookie`, `Authorization` or `Proxy-Authorization`, and a response whose `Vary` the key does not separate is not stored. `ttlSeconds` may be a function of the pathname. `ServerPlugin.uploadPaths` lets a plugin's file routes skip the 1 MB body cap; each must mount its own limit.
- The brand tokens and DaisyUI themes moved from `apps/web/src/ui/index.css` to `apps/web/src/shared/theme-tokens.css`, so a public-site stylesheet can share them without importing the admin UI. `theme-init.js` sets zod's global `jitless` config before any module runs, so its `new Function` probe no longer raises a CSP violation.
- `ServerPlugin.deploymentFeatures` lets a plugin's config switch on an `environmentGated` flag. `resolveFeatures` is now async and `availableInEnvironment` takes the deployed list.
- `images` is a sixth manifest binding type, declared only and written as the single `[images]` table; a second plugin declaring it is refused.
- The UI shell's inline theme script moved to `apps/web/src/ui/public/assets/theme-init.js`, because the Worker's CSP refuses inline script once navigations reach the Worker.
- `PluginRouteTier` gains `workspace`: a plugin page inside `Layout`, in the shell's route table, with sign-in, a tenant and the route's `guard` enforced as on `shell`. On a workspace route from `lg` up, `SideNav` shows its icon rail whatever `sideNavCollapsed` says, without changing it, and hides the collapse toggle; `<main>` has no padding and the page fills the viewport under the header. `Layout` takes a `workspace` prop, and `App.tsx` computes it from the plugin routes.
- `Breadcrumbs` is extracted from `PageHeader` and exported from `components/shared` and `@/plugins/api/ui`, for a surface with no page title (an editor toolbar).
- `resolveOwnerTenant(db, config, ownerSlug?)` is exported from `@/plugins/api` and returns only an `active` tenant, under both tenancy modes.
- `pnpm dev` and `pnpm dev:api` start `wrangler dev` with `--infer-origin-from-routes=false`, so a provisioned copy's local requests keep their real host instead of taking the toml's first route.
- A plugin declaring `publicSites` also sets `not_found_handling = "none"`, and the SPA catch-all fetches the shell on a 404 for a navigation only, so a missing `/assets/*`, `/site-assets/*` or root file is a 404.
- `pnpm plugin upgrade` rewrites the anchor `plugin.json` from the target manifest, so a later `remove` acts on the release actually installed.
- A manifest may declare `"appOwned"` paths: `upgrade` leaves them alone and `remove` requires `--force-app-owned` to delete files changed or added there.
- `pnpm plugin add`, `upgrade` and `remove` compute both tomls before writing either; a toml with no `run_worker_first` array stops the command with nothing written.
- `pnpm plugin upgrade` refuses a target release whose manifest fails `plugin check`'s manifest rules, or that adds a second `images` binding, before anything is written.
- When `pnpm plugin remove`, or an `upgrade` whose release drops `publicSites`, restores a `run_worker_first` list lacking API prefixes provisioned since, it marks the list `# rocketflare:reprovision` and prints a re-provision step; `pnpm plugin check` fails while a marked list lacks a plugin's prefixes, and `pnpm provision cloudflare <env>` or removing that plugin clears the mark.
- `pnpm plugin remove` treats a symlink under or at an `appOwned` path as one entry, compared by its target, instead of crashing with `EISDIR` or listing the files it points to.
- A public site's scripts and styles load from `<request origin>/site-assets/` in its CSP, so a site page cannot load the admin bundle from `/assets/*`; a declared script source reaching `/assets/` on the same host is refused by `publicSiteIssues` and dropped at runtime.
- `docs/CONCEPTS.md` §1 now says groups grant read only on kit resources and that a plugin may define its own grants; §16 describes the new seams.
- Requests for public-site pages are never rate limited; only a declared form POST is. `publicSites.rateLimit` no longer exists.
- `Strict-Transport-Security` carries `includeSubDomains` only on the app's own host (`APP_URL`), so a public site on an apex domain does not pin its subdomains.
- A public-site page can add CSP sources for itself by setting `PUBLIC_SITE_PAGE_CSP_HEADER` (JSON, `PublicSiteCsp`), exported from `@/plugins/api`. A `formAction` that is a path, such as `/submit`, is pinned to the request's origin.
- The CLI's `ApiClient` gains `getBytes` and `postForm`, for download and multipart routes.
- Platform documents: `documents` and `chunks` may hold rows with `tenant_id` NULL — knowledge about the app itself (a plugin's user guide), readable by every tenant through a SELECT-only `platformReadable()` policy and written only by the owner connection. A CHECK requires `source` and `externalId` on such a row; `documents_platform_source_external_uq` makes `(source, externalId)` unique among them.
- `@/plugins/api` gains `ingestPlatformDocument(ctx, { source, externalId, title, text })` and `prunePlatformDocuments(ctx, { source, keepExternalIds })`, accepted only on a `JobCtx` or `CronCtx` and only for a source namespaced with an installed plugin's id. Ingest embeds synchronously with the new `resolvePlatformEmbeddings(cfg, env)` (`EMBEDDINGS_API_KEY`, else the `[ai]` binding), writes nothing and throws `PlatformEmbeddingsError` (503 `platform_embeddings_not_configured`) without one, and is a no-op for unchanged text.
- `JobCtx` and `CronCtx` carry `kind: 'job'` / `kind: 'cron'`, set by `jobCtx()` / `cronCtx()`. A hand-built JobCtx or CronCtx in a test must add it.
- `searchKnowledge(ctx, { query, limit, sources?, platformSources?, signal? })` on `@/plugins/api` returns `{ hits, semantic }` for any context carrying a scope, falling back to keyword search without an embedder. `fuseByRank`, `anyTermTsquery` and `candidatePoolSize` are exported from `@/plugins/api`.
- `searchChunks` takes optional `sources` and `platformSources`. Platform chunks are ranked against a query vector from the platform embedder; when the tenant's model differs, the query is embedded once per model and each corpus gets its own dense leg before RRF. Without the new parameters, results are unchanged.
- `ServerPlugin.knowledgeSources?(scope)` names platform sources that the kit's `search_knowledge` tool, used by chat and agents, also searches. Platform passages are marked `platform: true`. Document lists, the viewer, `/search`, `get_document` and `list_documents` stay tenant-only.

## How to apply

1. Port `apps/web/src/api/middleware/public-sites.ts`, and call it in `apps/web/src/api/index.ts` after `databaseMiddleware` and before every mount.
2. Port the public CSP branch of `apps/web/src/api/middleware/security-headers.ts`.
3. Port the `publicSites` slot and its types in `apps/web/src/plugins/types.ts`, and their re-exports in `apps/web/src/plugins/api/index.ts`.
4. Add `'workspace'` to `PluginRouteTier` in `apps/web/src/plugins/types.ts`, then port `WorkspaceRoute`, `isWorkspacePath`, the `workspace` prop on `Layout` and the `pluginRoutes('workspace')` line inside `ShellRoutes` in `apps/web/src/ui/App.tsx`, the `workspace` prop in `apps/web/src/ui/components/Layout.tsx`, the `forceCollapsed` prop in `apps/web/src/ui/components/SideNav.tsx`, and `Breadcrumbs` in `apps/web/src/ui/components/shared/PageHeader.tsx` with its two exports.
5. Port `resolveOwnerTenant` into `apps/web/src/api/utils/db/tenant-helpers.ts` and export it from `@/plugins/api` through `apps/web/src/plugins/api/identity.ts`.
6. Port the manifest validator and `pnpm provision` changes for the `publicSites` field and the `images` binding type.
7. Add `--infer-origin-from-routes=false` to the `wrangler dev` command in `dev:api` in `apps/web/package.json` and to the `launch('api', 'wrangler', …)` arguments in `apps/web/scripts/dev-server.mjs`. Wrangler must be 4.156.0 or newer.
8. Port the SPA catch-all in `apps/web/src/api/index.ts`, and the `appOwned` handling, the in-memory toml routing and the target-manifest check in `scripts/plugin.mjs` and `scripts/lib/plugin-lib.mjs`. Port `workerFirstPatterns`, `missingWorkerFirstPatterns`, `markReprovision`, `awaitsReprovision`, `settleReprovision`, `restoreWorkerFirst` and `reprovisionStep` in `scripts/lib/plugin-lib.mjs`, and the `settleReprovision` call in `apps/web/scripts/provision/patch-toml.ts`.
9. In an app with no plugin declaring `publicSites`, leave `run_worker_first`, `not_found_handling` and `routes` unchanged in `apps/web/wrangler.toml` and `apps/web/wrangler.staging.toml`.
10. In an app installing a plugin that declares `publicSites`, put the site's own scripts and styles under `/site-assets/` in the built UI, set the plugin's hosts var in both tomls, run `pnpm provision cloudflare <env>` for each environment, and follow the zone and DNS steps in `docs/DEPLOY.md`.
11. Run `node scripts/plugin-api-doc.mjs` to regenerate `docs/plugin-api.md`.
12. Add `deploymentFeatures?: (config) => readonly string[]` to `ServerPlugin` in `apps/web/src/plugins/types.ts`, then port `apps/web/src/permissions/features.ts`, `apps/web/src/api/services/features.ts` and the two `await`s in `apps/web/src/api/middleware/auth.ts`. Any call of your own to `resolveFeatures` must now `await` it.
13. Move the `@theme` block and both `@plugin "daisyui/theme"` blocks from `apps/web/src/ui/index.css` into `apps/web/src/shared/theme-tokens.css`, and `@import "../shared/theme-tokens.css";` directly after the Tailwind import. Port the matching change in `tests/ui/contrast.test.ts`.
14. Port `getBytes` and `postForm` into `apps/cli/src/api.ts` if a plugin you install uses them.
15. Port platform documents: `platformTenantRef` in `apps/web/src/db/schema/_helpers.ts`, `platformReadable` in `apps/web/src/db/schema/rls.ts`, the nullable `tenantId`, the CHECK, the partial unique index and the policy in `apps/web/src/db/schema/documents.ts` and `chunks.ts`. Run `pnpm db:generate --name kit-platform-knowledge`, read the SQL and run `pnpm db:migrate`.
16. Port `apps/web/src/api/services/ai/platform-documents.ts`, `resolvePlatformEmbeddings` in `resolve.ts`, and the new `searchChunks` / `searchKnowledgeChunks` / `fuseDenseLegs` in `retrieval.ts`. Port the `tenantId` parameters added to `grantDocumentGroups`, `indexOrEnqueue` and `upsertExternal` in `ingest.ts`, and `documentTenantId`. Code of your own reading `DocumentRow.tenantId` now gets `string | null`; use `documentTenantId(row)` where a tenant row is expected.
17. Port `kind` on `JobCtx` / `CronCtx` in `apps/web/src/plugins/api/jobs.ts`, the platform functions and `searchKnowledge` in `knowledge.ts`, the re-exports in `ai.ts` and `index.ts`, `knowledgeSources` in `apps/web/src/plugins/types.ts`, and `pluginKnowledgeSources` plus the `platformSources` option in `apps/web/src/api/services/agents/tools/`.
18. Update `rls-coverage.test.ts` to pass the platform read policies (`tests/api/rls-coverage.test.ts`).

## Conflicts to expect

- `apps/web/src/ui/App.tsx` → one tier branch, one `pluginRoutes` line inside `ShellRoutes` and `isWorkspacePath` added → keep your own routes and add them.
- `apps/web/src/api/index.ts` → one middleware added before the mounts → keep your own order and place it directly after `databaseMiddleware`.
- `apps/web/src/api/middleware/security-headers.ts` → a branch for site hosts → keep your app CSP and add the branch ahead of it.
- `docs/plugin-api.md` → generated → regenerate, never merge by hand.

## Verify

1. `pnpm gate` passes.
2. `node scripts/plugin-api-doc.mjs --check` exits 0.
3. `pnpm web test:api` runs `tests/api/platform-knowledge.test.ts` green: both tenants read a platform document, neither writes one, and no tenant document view lists it.
4. With no plugin declaring `publicSites`, `git diff apps/web/wrangler.toml apps/web/wrangler.staging.toml` shows no change to `run_worker_first` or `routes`.
5. With a plugin serving `www.localhost` under `wrangler dev`, `curl -i http://www.localhost:3001/about` answers from the plugin with the public `Content-Security-Policy`, and `curl -i http://www.localhost:3001/api/me` answers 404.
6. `curl -i http://localhost:3001/api/health` still answers from the app.
