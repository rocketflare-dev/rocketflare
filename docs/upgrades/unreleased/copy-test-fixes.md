---
breaking: false
migrations: []
areas: [ui, config, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

The branding test no longer depends on the kit's own logo art, and the `egress` check's warnings now show when a coding agent runs the gate.

- `tests/ui/branding.test.tsx` renders `LogoMark` alone and looks for "an `<svg>`, not the configured `<img>`". It used to find the bundled mark by the kit's art (`viewBox="0 0 512 512"`), so every copy with its own mark failed three tests.
- `docs/upgrades/0.46.1.md` step 4 said a copy that keeps its own mark needs no change. It does: the branding test needs the `LogoMark` wrapper whether or not `APP_LOGO_URL` is set.
- `tests/config/tool-egress.test.ts` writes its `warn:` lines to stderr instead of `console.warn`, which Vitest drops for a passing test under its agent reporter.

## How to apply

- Take `apps/web/tests/ui/branding.test.tsx` and `apps/web/tests/config/tool-egress.test.ts` as they are.
- If your `LogoMark.tsx` is still your own inline mark, wrap it as the kit's does: read `logoUrl` from `useAppInfo()`, render `<img data-brand-logo … onError>` when it is set, and your mark as `BundledMark` otherwise.

## Conflicts to expect

None.

## Verify

- `pnpm test ui tests/ui/branding.test.tsx` passes with your own mark.
- `pnpm test config apps/web/tests/config/tool-egress.test.ts` prints one `warn:` line per tool without `egress`.
- `pnpm gate` passes.
