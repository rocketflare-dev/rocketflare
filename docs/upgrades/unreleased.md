---
version: unreleased
previous: 0.30.0
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

Plugins can ship tenant-less platform knowledge that is always embedded, stream a scoped chat, add header items and palette registries, install Claude Code hooks and seed developer-owned host files.

- Platform documents: `documents` and `chunks` may hold rows with `tenant_id` NULL — knowledge about the app itself (a plugin's user guide), readable by every tenant through a SELECT-only `platformReadable()` policy and written only by the owner connection. A CHECK requires `source` and `externalId` on such a row; `documents_platform_source_external_uq` makes `(source, externalId)` unique among them.
- `@/plugins/api` gains `ingestPlatformDocument(ctx, { source, externalId, title, text })` and `prunePlatformDocuments(ctx, { source, keepExternalIds })`, accepted only on a `JobCtx` or `CronCtx` and only for a source namespaced with an installed plugin's id. Ingest embeds synchronously with the new `resolvePlatformEmbeddings(cfg, env)` (`EMBEDDINGS_API_KEY`, else the `[ai]` binding), writes nothing and throws `PlatformEmbeddingsError` (503 `platform_embeddings_not_configured`) without one, and is a no-op for unchanged text.
- `JobCtx` and `CronCtx` carry `kind: 'job'` / `kind: 'cron'`, set by `jobCtx()` / `cronCtx()`. A hand-built JobCtx or CronCtx in a test must add it.
- `searchKnowledge(ctx, { query, limit, sources?, platformSources?, signal? })` on `@/plugins/api` returns `{ hits, semantic }` for any context carrying a scope, falling back to keyword search without an embedder. `fuseByRank`, `anyTermTsquery` and `candidatePoolSize` are exported from `@/plugins/api`.
- `searchChunks` takes optional `sources` and `platformSources`. Platform chunks are ranked against a query vector from the platform embedder; when the tenant's model differs, the query is embedded once per model and each corpus gets its own dense leg before RRF. Without the new parameters, results are unchanged.
- `ServerPlugin.knowledgeSources?(scope)` names platform sources that the kit's `search_knowledge` tool, used by chat and agents, also searches. Platform passages are marked `platform: true`. Document lists, the viewer, `/search`, `get_document` and `list_documents` stay tenant-only.
- A plugin manifest may declare `"claudeHooks": { "<Event>": [{ "command", "matcher"?, "timeout"? }] }`. `pnpm plugin add` merges them into `.claude/settings.json` (creating it if absent), `upgrade` replaces them and `remove` takes out exactly them. A command may only be `node "$CLAUDE_PROJECT_DIR/.claude/skills/<dir>/<script>"` over a script in one of the plugin's declared skills, and the plugin's entries are found again by that skill directory. `plugin check` fails a declared hook missing from the file, an undeclared one in the plugin's namespace, and a missing script.
- A plugin manifest may declare `"hostFiles": [{ "path", "from" }]`: a file or directory seeded into `docs/<id>/`, `apps/web/public/<id>/` or `apps/web/src/host/<id>/` only where absent. `upgrade` never touches them (it seeds only an entry the release adds), `remove` leaves them and lists them. The surface records them in a new `hostFiles` field, outside `paths`.
- A plugin may import `@/host/<its own id>/…`; another id's host directory fails `tests/config/plugins.test.ts`.
- `streamChat(c, options)` from `@/plugins/api` streams one AG-UI chat turn for a plugin route: the plugin's registered prompt (`promptKey`), its own tools built on the stream's database client, the kit's resolve seam, streaming loop, encoder, tracing and `recordUsage` under the plugin's `feature` label. No chat provider is the JSON 503 `ai_not_configured` before any frame. `emit(name, value)` (in the tool context and in `onFinish`) sends a CUSTOM event, refused with `RUN_ERROR` `invalid_custom_event` unless it is named `<plugin id>.…`; `kit.` is never allowed.
- The tool half of the AG-UI chat stream moved from `chat-turn.ts` into `aguiToolEvents` in `apps/web/src/api/services/ai/agui.ts`, shared by the kit's chat and `streamChat`; the kit's chat events are unchanged.
- `useNavigationEntries()` from `@/plugins/api/ui` returns every destination the reader may open — the composed side nav, the settings tabs as `/settings?tab=<id>` and the Home quick links — each filtered by `useNavGuard`, as `{ id, label, to, group, icon?, keywords?, source }`. The core settings tabs are now data in `apps/web/src/ui/pages/settings/tabs.ts`, which `SettingsLayout` renders.
- `UiPlugin.extensions` is the browser's cross-plugin registry, the twin of `ServerPlugin.extensions`; `uiExtensions(key)` and `uiExtensionSources(key)` from `@/plugins/api/ui` read it.
- `listAgents()` from `@/plugins/api` returns every registered agent as `{ key, title, description }`, the catalogue `GET /api/agents` serves.
- `promptOwner(key)` in `apps/web/src/api/services/prompts.ts` names the installed plugin that registered a prompt.
- `UiPlugin.header` adds items to the top bar (`PluginHeaderItem`: `id`, a lazy `Component`, `guard`, `order`, `placement: 'center' | 'end'`). `App.tsx` renders them with `PluginHeaderSlot` in `Layout`'s `headerCenter` and ahead of the kit's `headerEnd` widgets, each behind its guard and inside its own `Suspense` and error boundary. `headerItemIssues` fails the gate on a duplicate id or an unknown placement.
- `@testkit/integration` exports `scriptPlatformChat(env, turns)`, which scripts the `AI` binding stub's chat answers so a plugin test drives the real resolve seam with no `vi.mock`, plus `aguiFrames`, `aguiTypes` and `customEvents`.
- `fuseByRank`, `fuseDenseLegs`, `anyTermTsquery`, `candidatePoolSize`, `RRF_K` and `LEXICAL_MAX_TERMS` live in the leaf `apps/web/src/api/services/ai/fusion.ts` (still re-exported from `retrieval.ts`), and `searchKnowledge` loads `retrieval.ts` at call time, so `@/plugins/api` never reaches the plugin barrel ahead of `createRouter`; `tests/config/plugin-api-load-order.test.ts` holds that order.

## How to apply

1. Port platform documents: `platformTenantRef` in `apps/web/src/db/schema/_helpers.ts`, `platformReadable` in `apps/web/src/db/schema/rls.ts`, the nullable `tenantId`, the CHECK, the partial unique index and the policy in `apps/web/src/db/schema/documents.ts` and `chunks.ts`. Run `pnpm db:generate --name kit-platform-knowledge`, read the SQL and run `pnpm db:migrate`.
2. Port `apps/web/src/api/services/ai/platform-documents.ts`, `resolvePlatformEmbeddings` in `resolve.ts`, and the new `searchChunks` / `searchKnowledgeChunks` / `fuseDenseLegs` in `retrieval.ts`. Port the `tenantId` parameters added to `grantDocumentGroups`, `indexOrEnqueue` and `upsertExternal` in `ingest.ts`, and `documentTenantId`. Code of your own reading `DocumentRow.tenantId` now gets `string | null`; use `documentTenantId(row)` where a tenant row is expected.
3. Port `kind` on `JobCtx` / `CronCtx` in `apps/web/src/plugins/api/jobs.ts`, the platform functions and `searchKnowledge` in `knowledge.ts`, the re-exports in `ai.ts` and `index.ts`, `knowledgeSources` in `apps/web/src/plugins/types.ts`, and `pluginKnowledgeSources` plus the `platformSources` option in `apps/web/src/api/services/agents/tools/`.
4. Update `rls-coverage.test.ts` to pass the platform read policies (`tests/api/rls-coverage.test.ts`).
5. Port the `claudeHooks` and `hostFiles` handling in `scripts/plugin.mjs` and `scripts/lib/plugin-lib.mjs` (with `plugin-lib.d.mts` and the `hostFiles` field in `upgrade-lib.d.mts`), the `@/host/<id>` rule in `apps/web/tests/helpers/plugins.ts`, and `apps/web/tests/config/plugin-host-seams.test.ts`.
6. Port `apps/web/src/plugins/api/chat.ts` and its exports in `apps/web/src/plugins/api/index.ts`, `aguiToolEvents` in `apps/web/src/api/services/ai/agui.ts` (then replace the inline tool callbacks in `apps/web/src/api/services/ai/chat-turn.ts` with it, if you have not changed them), and `promptOwner` in `apps/web/src/api/services/prompts.ts`.
7. Port `PluginHeaderItem`, `PluginHeaderPlacement` and `UiPlugin.header` in `apps/web/src/plugins/types.ts` with their re-exports in `apps/web/src/plugins/api/index.ts` and `apps/web/src/plugins/api/ui-wiring.ts`, add `apps/web/src/ui/components/PluginHeaderSlot.tsx`, and pass `<PluginHeaderSlot plugins={uiPlugins} placement="center" />` as `headerCenter` and `<PluginHeaderSlot plugins={uiPlugins} placement="end" />` first inside `headerEnd` in `ShellRoutes` in `apps/web/src/ui/App.tsx`. An app already using `headerCenter` keeps its own element and places the slot beside it.
8. Port `scriptPlatformChat` into `apps/web/tests/helpers/ai.ts`, its re-exports in `apps/web/tests/kit/integration.ts`, and `headerItemIssues` into `apps/web/tests/helpers/plugins.ts` with its case in `apps/web/tests/config/plugins.test.ts`.
9. Add `apps/web/src/ui/pages/settings/tabs.ts` and render `CORE_SETTINGS_TABS` in `apps/web/src/ui/pages/settings/SettingsLayout.tsx` (keep your own tabs: add them to the list and to its `CONTENT` map). Export `CORE_NAVIGATION` and `isNavGroup` from `apps/web/src/ui/components/SideNav.tsx` and `CORE_QUICK_LINKS` from `apps/web/src/ui/pages/Home.tsx`, add `apps/web/src/ui/hooks/useNavigationEntries.ts` and `apps/web/src/ui/lib/plugin-extensions.ts`, add `extensions` to `UiPlugin` in `apps/web/src/plugins/types.ts`, and re-export the new names from `apps/web/src/plugins/api/ui.ts`. Port `apps/web/tests/ui/navigation-entries.test.tsx`.
10. Add `AgentSummary` and `listAgents` to `apps/web/src/plugins/api/ai.ts` and export both from `apps/web/src/plugins/api/index.ts`. Port `apps/web/tests/config/plugin-list-agents.test.ts`.
11. Run `node scripts/plugin-api-doc.mjs` to regenerate `docs/plugin-api.md`.

## Conflicts to expect

- `docs/plugin-api.md` → generated → regenerate, never merge by hand.
- `apps/web/src/ui/App.tsx` → `headerCenter` and the first child of `headerEnd` in `ShellRoutes` → keep your own header elements and add the two slots.

## Verify

1. `pnpm gate` passes.
2. `node scripts/plugin-api-doc.mjs --check` exits 0.
3. `pnpm web test:api` runs `tests/api/platform-knowledge.test.ts` green: both tenants read a platform document, neither writes one, and no tenant document view lists it.
4. `pnpm web test:config` passes, `tests/config/plugin-host-seams.test.ts` included.
5. `pnpm web test:api` passes `tests/api/plugin-stream-chat.test.ts`, and `pnpm web test:ui` passes `tests/ui/plugin-header.test.tsx` and `tests/ui/navigation-entries.test.tsx`.
6. `pnpm web test:config` passes `tests/config/plugin-api-load-order.test.ts` and `pnpm web test:ui` passes `tests/ui/navigation-entries.test.tsx`.
