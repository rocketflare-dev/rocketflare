---
version: unreleased
previous: 0.13.0
date: null
breaking: false
migrations: []
areas: [docs]
touches_surfaces: []
requires_surfaces: []
manual: true
---

## What changed

The kit's commit-time nudges now actually reach Claude: they answer as JSON `additionalContext`, and a new hook reminds maintainers to update rocketflare.dev on any commit that changes the root version.

- `scripts/changelog-nudge.mjs` printed plain text, which a `PreToolUse` hook sends only to the debug log, so the "no porting note" nudge was never seen. It now writes `hookSpecificOutput.additionalContext` plus a `systemMessage`.
- New `scripts/release-site-nudge.mjs` (+ `scripts/lib/nudge-lib.mjs`): on a `git commit` that changes the root `package.json` version in the kit or the plugins monorepo, it hands Claude the rocketflare-www steps. It is silent in a copy of the kit.
- `.claude/settings.json` registers the new hook beside `changelog-nudge.mjs`.
- For a plugins release the reminder also says to run `npm run sync:plugins` in rocketflare-www, which refreshes the per-plugin pages from each plugin's README.
- `tests/config/nudge-hooks.test.ts` covers the output shape and runs the hook in throwaway repositories.

## How to apply

1. Copy `scripts/changelog-nudge.mjs`, `scripts/release-site-nudge.mjs`, `scripts/lib/nudge-lib.mjs` and `scripts/lib/nudge-lib.d.mts` from the kit, and the test `apps/web/tests/config/nudge-hooks.test.ts`.
2. `.claude/settings.json` is a `manual` file, so add the second `PreToolUse` Bash hook entry by hand: `node "$CLAUDE_PROJECT_DIR/scripts/release-site-nudge.mjs"`, timeout 10. It is silent in an app, so this step is optional for a copy.

## Conflicts to expect

- `.claude/settings.json` → the app may have hooks of its own → keep both sides.

## Verify

1. `pnpm web test:config` passes, including `nudge-hooks.test.ts`.
