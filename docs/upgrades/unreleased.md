---
version: unreleased
previous: 0.10.0
date: null
breaking: false
migrations: []
areas: [config, docs]
touches_surfaces: []
requires_surfaces: []
manual: true
---

## What changed

A copy of the kit now hears about newer kit releases on its own: a Claude Code `SessionStart` hook tells the person once per session, with each release's summary and a pointer to `/rf-upgrade`.

- New `scripts/kit-update-check.mjs` (with the pure `scripts/lib/update-check-lib.mjs`): compares `.rocketflare.json` `kit.version` with the newest `X.Y.Z` tag at `kit.repo` via `git ls-remote --tags`. No API, no token.
- The answer is cached for a day in the git-ignored `.claude/kit-update-check.json`, and a failed check for an hour, so an offline session never waits on the 4-second timeout twice in an hour.
- It runs only in a copy (`app` set), only on a fresh `startup`, never in CI, and never with `ROCKETFLARE_UPDATE_CHECK=0`. Every failure is silence and exit 0.
- Summaries are the CHANGELOG's per-release sentence, fetched from the kit at the new tag (GitHub-hosted kits only). Rationale: `docs/CONCEPTS.md` §13.

## How to apply

1. Copy `scripts/kit-update-check.mjs`, `scripts/lib/update-check-lib.mjs` and `scripts/lib/update-check-lib.d.mts` from the kit, plus `apps/web/tests/config/update-check-lib.test.ts`.
2. Add a `SessionStart` entry to `hooks` in `.claude/settings.json` by hand, because the upgrade script treats that file as `manual`: `"SessionStart": [{ "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/scripts/kit-update-check.mjs\"", "timeout": 10 }] }]`.
3. Add `.claude/kit-update-check.json` to `.gitignore`.
4. Keep `kit.repo` in `.rocketflare.json` pointing at the kit repository the copy came from (a fork of the kit works too). The check reads its tags from there.

## Conflicts to expect

- `.claude/settings.json` → gains a `SessionStart` hook beside the existing `PreToolUse` one → merge the two `hooks` keys by hand.

## Verify

1. `pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass.
2. `echo '{"source":"startup"}' | node scripts/kit-update-check.mjs` prints a JSON `additionalContext` naming the newer release while the copy is behind, and prints nothing once it is current.
3. `echo '{"source":"startup"}' | ROCKETFLARE_UPDATE_CHECK=0 node scripts/kit-update-check.mjs` prints nothing.
