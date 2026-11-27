---
version: unreleased
previous: 0.46.0
date: null
breaking: false
migrations: []
areas: [api, shared, ui, config, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

The sign-in tagline, panel art, logo and favicon become `[vars]` served by `GET /api/health`, which now also returns `name`; the build writes the page's title and description from `APP_NAME` and `APP_TAGLINE`.

- New optional `[vars]`: `APP_TAGLINE`, `LOGIN_PANEL_ART` (`rocket|type`), `APP_LOGO_URL`, `APP_FAVICON_URL`. Unset means the bundled fallback. Design and known gaps: `docs/CONCEPTS.md` §7.
- `GET /api/health` adds `name` (`APP_NAME`) and, when set, `tagline`, `loginPanelArt`, `logoUrl`, `faviconUrl` (`brandingSchema`, new module `@rocketflare/shared/branding`).
- Fix: the UI showed the compiled `APP_NAME` constant in `hooks/useAppInfo.ts`, never the `[vars]` `APP_NAME`, because `/api/health` did not send it.
- A logo or favicon value must be an `https://` URL or a root-relative path (`/brand/logo.svg`); any other value fails `loadConfig`.
- `LOGIN_PANEL` in `ui/lib/login-panel.ts` is now the fallback only; `AuthCard` reads the art and tagline from `useAppInfo()`.
- `LogoMark` (same signature) renders the configured logo as an `<img>` and falls back to the bundled mark when it is unset or fails to load. New `components/BrandFavicon.tsx`, mounted once in `App.tsx`, swaps the tab icon once the configured one has loaded.
- The configured logo's `<img>` carries `data-brand-logo`, a stable hook for an app's own CSS rule (rounding, a ring, padding, a per-theme filter); the bundled mark does not carry it.
- The Vite build fills `index.html`'s `<title>` from `APP_NAME` and its meta description from `APP_TAGLINE` (the name when there is no tagline), read from `[vars]` in `apps/web/wrangler.toml` (`pageIdentityPlugin` in `apps/web/vite.config.ts`, new `scripts/lib/page-identity.mjs`).
- `scripts/rename.mjs` writes `design.json` `app.tagline` to `APP_TAGLINE` in both wrangler tomls (`applyTagline` in `scripts/lib/rename-lib.mjs` now takes a toml), no longer to `login-panel.ts`.
- `/rf-adapt` row (f) and `/rf-design` describe the tagline, panel art and logo as settings.
- Fix: `scripts/detach.sh` keeps every file the kit tracks. It re-added the tree with `git add -A`, which obeys the person's own global gitignore, so a machine that ignores `.claude` got a first commit with no skills, rules or hooks. It now adds exactly the tracked list, and still adds no ignored file.

## How to apply

1. Add `APP_TAGLINE = "<the app's one-line tagline>"` and `LOGIN_PANEL_ART = "<rocket or type>"` to `[vars]` in BOTH `apps/web/wrangler.toml` and `apps/web/wrangler.staging.toml`, copying the two values from `LOGIN_PANEL` in the app's `apps/web/src/ui/lib/login-panel.ts`.
2. Check that `APP_NAME` in `[vars]` of both tomls is the name the UI should show: the UI now shows that value, where it previously showed the `APP_NAME` constant in `apps/web/src/ui/hooks/useAppInfo.ts`.
3. `apps/web/src/ui/components/shared/LogoMark.tsx` is a `manual` path, so the upgrade does not replace it. To use the logo setting, port the kit's `LogoMark` wrapper (it reads `logoUrl` from `useAppInfo()` and renders an `<img data-brand-logo>` with an `onError` fallback) around the app's own inline mark; an app that keeps its inline mark and sets no `APP_LOGO_URL` needs no change.
4. Optional: to serve the logo as a setting, put the files under `apps/web/src/ui/public/` and set `APP_LOGO_URL` and `APP_FAVICON_URL` in `[vars]` of both tomls to their root-relative paths, or to `https://` URLs.
5. Optional: to style a configured logo (round a JPEG's corners, add a ring, filter it in the dark theme), add a rule such as `[data-brand-logo] { border-radius: 22%; }` to `apps/web/src/shared/theme-tokens.css`, and `[data-theme$="-dark"] [data-brand-logo] { … }` for a dark-theme difference; the rule needs the `data-brand-logo` attribute on the `<img>` in the app's `LogoMark.tsx`, and `pnpm design:docs --adopt-default-look` drops the rule from `theme-tokens.css`, so re-add the rule after running that command.
6. Replace any app import of `LOGIN_PANEL` that decides what a page shows with `useAppInfo()`'s `loginPanelArt` and `tagline`.
7. Check that `apps/web/src/ui/index.html` has a `<title>` element: the build now fails without one.
8. Check that `APP_NAME` and `APP_TAGLINE` in `[vars]` of `apps/web/wrangler.toml` are the title and the one-line description a link preview of the app should show: the build now writes `APP_NAME` into `<title>` and `APP_TAGLINE` into `<meta name="description">`, for a staging deploy too.
9. Run `pnpm typecheck` so `apps/web/worker-configuration.d.ts` is regenerated with the new vars, and commit that file.
10. Run `git ls-files .claude | wc -l` in the app. If it prints 0 while the `.claude/` folder exists on disk, the app was detached on a machine whose global gitignore matches `.claude`: run `git add -f .claude` and commit, so the skills, rules and hooks reach every clone.

## Conflicts to expect

- `apps/web/src/ui/lib/login-panel.ts` → the type is imported from `@rocketflare/shared/branding` and the comment calls the constant a fallback → keep the app's `art` and `tagline` values.
- `apps/web/src/ui/components/AuthCard.tsx` → `LoginPanel` reads `useAppInfo()` instead of `LOGIN_PANEL` → take the kit's lines.
- `apps/web/wrangler.toml`, `apps/web/wrangler.staging.toml` → four branding lines after `APP_NAME`, under a two-line comment → keep the app's values (step 1) and take the kit's comment.
- `apps/web/vite.config.ts` → a `pageIdentityPlugin` function, two imports and `pageIdentityPlugin()` in `plugins` → take the kit's lines and keep any alias or proxy entry an installed plugin added.

## Verify

1. `pnpm test config apps/web/tests/config/env-schema.test.ts` passes.
2. `pnpm test api apps/web/tests/api/health.test.ts` passes.
3. `pnpm test ui apps/web/tests/ui/branding.test.tsx` passes.
4. `curl -s http://localhost:3001/api/health` shows `name`, `tagline` and `loginPanelArt` with the values from `apps/web/.dev.vars` or the toml.
5. After `pnpm web build:ui`, `apps/web/dist/ui/index.html` has `APP_NAME` from `apps/web/wrangler.toml` in `<title>` and `APP_TAGLINE` in `<meta name="description">`.
6. `pnpm test config apps/web/tests/config/ui-shell-identity.test.ts` passes.
7. `pnpm gate` passes.
