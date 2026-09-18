---
version: unreleased
previous: 0.7.0
date: null
breaking: false
migrations: []
areas: []
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

### A plugin release stamps its anchor

A plugin carries its version twice — in `rocketflare-plugin.json`, the release manifest read from
its own repository, and in the ANCHOR (`apps/web/src/plugins/<id>/plugin.json`), which is the file
copied into a host and therefore the one `pnpm plugin check` compares against the recorded surface.
`release.mjs` only ever stamped the manifest.

While each plugin was its own repository the anchor was kept in step BY HAND, and nothing said so.
Moving the first-party plugins into a monorepo dropped that habit, and the next release shipped an
anchor a version behind: every install then reported `plugin.json says <old>, and the surface says
<new>` and exited 1. That is a failure rather than a warning, so it took the host's whole gate down
— for a release whose code was correct.

`releaseContext` now adds each manifest's declared `anchor` to the files a plugin release stamps.
The kit's own branch is untouched: a vendored plugin sits at its own version, not the kit's.

_Nothing yet. Add an entry here in the same pull request as the change — see `README.md` beside this
file for the fields and for what "How to apply" has to say._

## How to apply

## Conflicts to expect

## Verify
