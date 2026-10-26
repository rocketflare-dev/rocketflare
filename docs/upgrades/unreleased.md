---
version: unreleased
previous: 0.23.0
date: null
breaking: false
migrations: []
areas: []
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Kit upgrades now extract and automatically apply comment-only hunks in supported manual configuration files while safely falling back to manual review on mismatches.

- `pnpm kit:upgrade` splits diffs for manual configuration files into hunks and automatically applies comment-only edits in `.toml`, `.dev.vars`, and `.env` files.
- Manual files with only comment changes are classified as `manual-comments` during planning, preserving adopter-specific configuration while applying upstream comments.
- Comment extraction distinguishes TOML comments from `#` characters inside single-line and multiline basic or literal strings, ignoring string contents.
- Unsupported file types and hunks that fail `git apply --check` or contain code edits fall back to manual resolution.

## How to apply

1. Copy `scripts/upgrade.mjs`, `scripts/lib/upgrade-lib.mjs`, and `scripts/lib/upgrade-lib.d.mts` from the kit.
2. Copy `apps/web/tests/config/upgrade-lib.test.ts` from the kit.

## Conflicts to expect

None.

## Verify

1. `pnpm --filter @rocketflare/web exec vitest run --project config tests/config/upgrade-lib.test.ts` passes.
2. `pnpm gate` passes.
