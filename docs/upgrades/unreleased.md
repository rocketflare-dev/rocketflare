---
version: unreleased
previous: 0.27.0
date: null
breaking: false
migrations: []
areas: [plugins, scripts, ci, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

The analytics plugin is opt-in: a fresh clone of the kit installs no plugin, and `/rf-plugin add analytics` adds dashboards, cubes and fact tables when an app wants them.

- `.rocketflare.json` `defaultPlugins` and `launch.kit.json` `plugins.defaults` are `[]`. The bootstrap's `6/10 plugins` step reports `no defaultPlugins declared — nothing to install`; the mechanism stays for an app's own fresh clones.
- The kit's own CI still installs analytics on every pull request, from the kit-only `.github/ci-plugins.json` (`scripts/default-plugins.mjs --ci`); `kit:release` checks that list as it checks `defaultPlugins`.
- `CLAUDE.md`, `SETUP.md`, `README.md`, `docs/CONCEPTS.md` §8/§16, `docs/DEPLOY.md`, `/rf-setup` and `/rf-plugin` describe analytics as opt-in and name the command.

## How to apply

1. Nothing to remove: an app with analytics installed keeps it, and `pnpm plugin upgrade analytics` still upgrades it.
2. To stop your app's fresh clones installing analytics, set `defaultPlugins` to `[]` in `.rocketflare.json` and `plugins.defaults` to `[]` in `launch.kit.json`. To keep it, change neither.
3. Take the kit's wording for the docs listed under "What changed" for any you have not edited.

## Conflicts to expect

- `.rocketflare.json` `defaultPlugins` → emptied in the kit → keep your own list; it is the app's choice.

## Verify

1. On a fresh clone of the kit, `pnpm bootstrap` prints `no defaultPlugins declared — nothing to install` at `6/10 plugins`, and `/rf-plugin add analytics` installs it.
2. `pnpm gate` passes.
