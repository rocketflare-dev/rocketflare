---
version: unreleased
previous: 0.41.1
date: null
breaking: false
migrations: []
areas: [config, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

`pnpm plugin list --available` lists every published plugin, read live from the plugin repositories at their newest tag, and `/rf-plugin add` and `/rf-how-do-i` now start from it.

- `scripts/plugin.mjs` gains `list --available [--json]`: one line per plugin (id, version, installed here or not, description), read through the same mirror `add` uses with the fetch made mandatory; unreachable is one `error:` line and exit 3, never a cached list ([CONCEPTS §16](../CONCEPTS.md#16-plugins)).
- Commercial plugins (`rocketflare-dev/rocketflare-commercial-plugins`) appear under their own heading with a `licence:` line only when the person's git credentials can read that repository; otherwise nothing is printed about them.
- `scripts/lib/plugin-lib.mjs` gains `PLUGIN_CATALOGUES`, `catalogueEntries`, `catalogueReads`, `readmeLede`, `licenceTerms`, `renderCatalogue` and `catalogueJson`; `scripts/lib/git-lib.mjs` `ensureMirror` gains `fresh` and `quiet` options and a mirror gains `prefetch(ref, paths)`.
- `/rf-plugin add` with no id shows the catalogue instead of asking for a repository; `/rf-how-do-i` §0 first asks "does a plugin already do this?".
- `SETUP.md` §2.7 no longer pins a plugin release in its example (no `@ref` reads the newest tag), and SETUP, CONCEPTS §8/§16 and `/rf-setup` point at `pnpm plugin list --available` and https://rocketflare.dev/plugins.

## How to apply

1. Port `scripts/plugin.mjs`, `scripts/lib/plugin-lib.mjs`, `scripts/lib/plugin-lib.d.mts`, `scripts/lib/git-lib.mjs` and `scripts/lib/git-lib.d.mts` from the release; none of them holds app-specific code.
2. Copy `apps/web/tests/config/plugin-catalogue.test.ts` into the app; it runs in the `config` project against local fixture repositories and needs no network.
3. Port the text changes to `.claude/skills/rf-plugin/SKILL.md`, `.claude/skills/rf-plugin/reference.md`, `.claude/skills/rf-how-do-i/SKILL.md` §0 and `.claude/skills/rf-setup/SKILL.md`, keeping any wording the app has changed in those files.
4. Port the `SETUP.md` §1.4b and §2.7 and `docs/CONCEPTS.md` §8 and §16 text if the app still carries those sections.

## Conflicts to expect

- `.claude/skills/rf-how-do-i/SKILL.md` → §0 gains a new first question above "app, or plugin?" → keep the app's own §0 text below the new question.
- `SETUP.md` §2.7 → the analytics example lost its `@3.8.2` pin → keep the app's own example if it was rewritten.

## Verify

1. `pnpm plugin list --available` exits 0 and prints `Plugins (github.com/rocketflare-dev/rocketflare-plugins at <tag>)` followed by one line per plugin, `analytics` among them.
2. `pnpm plugin list --available --json` prints one JSON document whose `catalogues[0].plugins` carries `id`, `version`, `description` and `installed` for each plugin.
3. `pnpm web exec vitest run --project config tests/config/plugin-catalogue.test.ts` passes.
