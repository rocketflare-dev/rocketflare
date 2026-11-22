---
version: unreleased
previous: 0.43.0
date: null
breaking: false
migrations: []
areas: []
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Plugins gain Home cards, a framing opt-in for one response and exact-path upload caps up to 50 MiB, and the plugin UI kit no longer imports the Home page.

- `UiPlugin.homeCards` (`{ id, Component, guard?, order? }[]`) is Home's "what needs doing" section, above the quick links, rendered by the new `ui/components/PluginHomeCards.tsx`: ordered by `order`, plugin id, card id, each behind its guard, `Suspense` and error boundary (`docs/CONCEPTS.md` §16).
- `RequestCtx.embeddable(contentType)` lets a plugin route opt one response into `SAMEORIGIN` / `frame-ancestors 'self'` — the flag `/api/files/:id` sets — for an `EMBEDDABLE_MIME_TYPES` type only; it answers whether it applied.
- `ServerPlugin.uploadLimits` (`{ '/api/<id>/upload': bytes }`) gives an exact path a non-JSON body cap above `uploadPaths`' 10 MB, up to `MAX_PLUGIN_UPLOAD_LIMIT_BYTES` (50 MiB, clamped), checked first in `apiBodyLimit`; `uploadLimitIssues` (`tests/helpers/plugins.ts`) refuses a bad one.
- `QuickLink` and `CORE_QUICK_LINKS` moved from `ui/pages/Home.tsx` to the leaf `ui/pages/home-links.ts`, so `useNavigationEntries` and `@/plugins/api/ui` no longer pull the Home page into `apps/evals`' typecheck (#178); `tests/config/plugin-ui-kit-graph.test.ts` holds it.
- `makeRequestCtx` (`@testkit/unit`) implements `embeddable` and records the answer on `framed`.

## How to apply

1. Add `apps/web/src/ui/pages/home-links.ts` with `QuickLink` and `CORE_QUICK_LINKS`, keeping your own Home links in that list, and delete both from `apps/web/src/ui/pages/Home.tsx`, which imports them from `./home-links`.
2. Point the `CORE_QUICK_LINKS` import in `apps/web/src/ui/hooks/useNavigationEntries.ts`, and the `QuickLink` imports in `apps/web/src/plugins/types.ts` and `apps/web/src/plugins/api/ui-wiring.ts`, at `ui/pages/home-links` instead of `ui/pages/Home`.
3. Add `apps/web/src/ui/components/PluginHomeCards.tsx`, add `PluginHomeCard` and `UiPlugin.homeCards` to `apps/web/src/plugins/types.ts`, export `PluginHomeCard` from `apps/web/src/plugins/api/index.ts` and `apps/web/src/plugins/api/ui-wiring.ts`, and render `<PluginHomeCards plugins={uiPlugins} />` above the quick links in `Home.tsx`.
4. Add `embeddable(contentType)` to `RequestCtx` and to `requestCtx` in `apps/web/src/plugins/api/http.ts`, and to `makeRequestCtx` in `apps/web/tests/kit/unit.ts` (with the `framed` getter).
5. Add `MAX_PLUGIN_UPLOAD_LIMIT_BYTES`, `UploadLimit`, `pluginUploadLimits` and `apiBodyLimit`'s third parameter to `apps/web/src/api/middleware/body-limit.ts`, add `ServerPlugin.uploadLimits` to `apps/web/src/plugins/types.ts`, and pass `pluginUploadLimits(serverPlugins)` as the third argument of `apiBodyLimit` in `apps/web/src/api/index.ts`.
6. Add `uploadLimitIssues` to `apps/web/tests/helpers/plugins.ts` and port its case in `apps/web/tests/config/plugins.test.ts`, the "plugin upload limits" block in `apps/web/tests/config/public-mounts.test.ts`, the `embeddable` block in `apps/web/tests/api/plugin-request-ctx.test.ts`, `apps/web/tests/ui/plugin-home-cards.test.tsx` and `apps/web/tests/config/plugin-ui-kit-graph.test.ts`.
7. If you carried a local `homeCards`, `embeddable()` or upload-cap seam of your own, move its plugins onto these and delete the local version.

## Conflicts to expect

- `apps/web/src/ui/pages/Home.tsx` → the quick links moved out and the cards section came in → keep your own sections and links (the links in `home-links.ts`).
- `apps/web/src/plugins/types.ts` → two new fields and one new interface → keep both sides.

## Verify

1. `pnpm typecheck` passes, `apps/evals` included.
2. `pnpm test config apps/web/tests/config/plugin-ui-kit-graph.test.ts apps/web/tests/config/public-mounts.test.ts apps/web/tests/config/plugins.test.ts` passes.
3. `pnpm test ui apps/web/tests/ui/plugin-home-cards.test.tsx` passes.
4. `pnpm test api apps/web/tests/api/plugin-request-ctx.test.ts` passes.
