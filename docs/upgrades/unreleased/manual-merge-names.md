---
breaking: false
migrations: []
areas: [scripts, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

The 3-way starting point `kit:upgrade` writes for a file that is yours to decide (`.upgrade/work/<v>/merged/`) no longer names the app as the kit in `launch.kit.json`, and no longer carries a kit-website link the apply just repaired.

- `launch.kit.json` goes through `renameKitManifest` in the upgrade as in the rename: its `kit` block (`id`, `name`, `description`) stays the kit's. The merge used to translate it, so taking the starting point recorded the app as the kit it came from.
- The copy's side of that merge has its kit-website links put back first (`kitSiteRepairs`), as the tree's are. A `README.md` starting point used to bring back `<app domain>/install.sh`.

## How to apply

- Take `scripts/upgrade.mjs` as it is.
- If you took a `merged/launch.kit.json` from an earlier upgrade, check that its `kit` block reads `"id": "rocketflare"` and `"name": "Rocketflare"`, and put them back if it names your app.

## Conflicts to expect

None.

## Verify

- `grep -n '"name"' launch.kit.json` shows `Rocketflare` in the `kit` block.
- `pnpm gate` passes.
