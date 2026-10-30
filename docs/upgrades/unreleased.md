---
version: unreleased
previous: 0.23.0
date: null
breaking: false
migrations: []
areas: [api, config, docs]
touches_surfaces: [example-feature, example-agent-summarize-text, example-agent-research-topic, example-agent-triage-research]
requires_surfaces: []
manual: false
---

## What changed

A renamed copy now carries none of the kit's own machinery: its maintainer scripts, hooks, project files and kit-only tests are removed at the rename, and the example plugin's agent tool and welcome note follow its flag.

- `kitOnly` now also lists `scripts/release.mjs`, the two maintainer nudges and `lib/nudge-lib`, `scripts/default-plugins.mjs`, `scripts/install.sh`, `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md`; the rename deletes them ([CONCEPTS §13](../CONCEPTS.md#13-upgrading-a-copy)).
- The rename also drops the `kit:release` script and the two nudge hooks from `.claude/settings.json`, writes the app its own `SECURITY.md`, and removes `retiredSurfaces` from `.rocketflare.json`.
- Kit-only tests moved out of `tests/config/`: `kit-check`, `kit-check-parsers`, `launch-kit-manifest` (now `kit-only/launch-kit-schema`), `gate-string`, the release helpers' blocks of `upgrade-lib`/`manifest-lib`, and the manifest's "classifies every tracked file" check — an app's own new paths no longer fail its gate.
- `tests/config/kit-manifest.test.ts` now also fails a copy whose package.json scripts or Claude Code hooks call a kit-only file.
- `ToolCtx` (the plugin tool context) gains `features()`; `example-feature`'s `list_example_notes` tool is offered only while the organisation has the flag, and its `onTenantCreated` note only when the deployment ships it.
- The example agents are removable without test edits: core tests run on two fixture agents registered through mocked plugin barrels (`apps/web/tests/helpers/fixture-agents.ts`), `tests/api-setup.ts` imports the DB client lazily so a test's `vi.mock` of a barrel takes effect, and each example surface's `paths` now lists its own output view, eval suite, dataset, baseline and UI tests (`triage-research` `requires` `research-topic`).
- `apps/web/src/api/services/ai/kit.ts` is now `agent-loop.ts` (same exports; `tests/api/ai-kit.test.ts` → `agent-loop.test.ts`), and source comments no longer carry design-decision numbers, "Ported from…" provenance or phase history — an app reads the rule, not the kit's past.
- The docs say which rules are the kit repository's alone: porting notes and `pnpm kit:release` (CLAUDE.md, code-quality rules, SETUP §3.7, DEPLOY's version rule). An app releases by bumping its root version and tagging.
- Learned from apps built on the kit: `docs/upgrades/unreleased.md` is `kitOnly` too (copies kept the kit's pending notes and went on writing their own); the rename now reports the licence and a missing `kit.commit` as careful rows; package descriptions no longer call the app a kit; and `upgrade-lib.test.ts`'s ancestry case builds its own two-commit repository instead of reading `HEAD~1`, which a one-commit copy or a shallow CI checkout lacks.

## How to apply

1. Delete the kit-maintainer files the rename now removes, where present: `git rm -q --ignore-unmatch scripts/release.mjs scripts/release.d.mts scripts/changelog-nudge.mjs scripts/release-site-nudge.mjs scripts/lib/nudge-lib.mjs scripts/lib/nudge-lib.d.mts scripts/default-plugins.mjs scripts/install.sh CONTRIBUTING.md CODE_OF_CONDUCT.md`.
2. In the root `package.json`, delete the `kit:release` script.
3. In `.claude/settings.json`, delete the two `PreToolUse` hook entries that run `changelog-nudge.mjs` and `release-site-nudge.mjs` (and the `PreToolUse` key if it is left empty); keep the `SessionStart` `kit-update-check.mjs` entry.
4. Delete any of these that `kit:upgrade` left in `apps/web/tests/config/` (their kit-only replacements are never ported): `kit-check.test.ts`, `kit-check-parsers.test.ts`, `launch-kit-manifest.test.ts`, `gate-string.test.ts`, `fixtures/kit-fixture.mjs`, `fixtures/kit-fixture.d.mts`.
5. In `.rocketflare.json`, add the ten paths from step 1 and `docs/upgrades/unreleased.md` to `kitOnly`, remove `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` and `scripts/install.sh` from `neverPort`, and delete `retiredSurfaces` and `$retiredSurfaces`.
6. `docs/upgrades/unreleased.md` is the kit's pending notes, not yours: if it holds only kit entries, `git rm` it; if your team wrote its own entries there, move them to your `CHANGELOG.md` first. An app writes no porting note.
7. Rewrite `SECURITY.md` as your app's own policy if it still points reporters at the kit's advisories.
8. If your app has its own plugin tool that should go dark with a flag, return `[]` from its `agentTools` when `(await ctx.features()).includes(<flag>)` is false, as `example-feature`'s `exampleAgentTools` does.
9. To delete an example agent: delete its surface's `paths` (`.rocketflare.json`), then its lines in each listed registry — `CORE_AGENTS`, `CORE_AGENT_KEYS`, `CORE_PROMPT_REGISTRY` (and the prompt's default text), `CORE_AGENT_FORMS`, `AGENT_OUTPUTS`, and its demo run in `seed.ts`'s `seedDemo`. Delete `triage-research` with `research-topic`. Removing every kit agent with no plugin agent left is not supported yet (`AgentKey` becomes `never`).
10. If your own code imports `services/ai/kit`, change the import to `services/ai/agent-loop` (an installed plugin imports `@/plugins/api` and needs no change).

## Conflicts to expect

- `.rocketflare.json` → `kitOnly`/`neverPort` lists changed → apply step 5 by hand (the file is never ported).
- `.claude/settings.json`, `package.json` → `manual` → apply steps 2–3 by hand.
- Any file you edited in `apps/web/src`, `apps/cli/src` or `packages/shared/src` → comment-only hunks reject where your edits overlap → keep your code, take the new comment wording or drop it; no behaviour depends on comments.

## Verify

1. `pnpm web test:config` passes, including `kit-manifest.test.ts` › "are called by nothing in this copy".
2. `ls scripts/release.mjs scripts/changelog-nudge.mjs 2>/dev/null` prints nothing.
3. `grep -c nudge .claude/settings.json` prints `0`.
4. `pnpm gate` passes.
