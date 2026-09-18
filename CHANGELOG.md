# Changelog

Releases of the kit. Each one links to its porting note in [`docs/upgrades/`](docs/upgrades/) —
the note is the instruction set `pnpm kit:upgrade` and the `/rf-upgrade` skill follow to bring a
copy of the kit forward without recreating anything its owner deleted.

If you are running a copy: `pnpm kit:upgrade` tells you which of these you are missing.

## 0.8.0 — 2026-09-18

**Plugin compatibility is OBSERVED rather than declared**: a plugin states one `minKit` floor and the symbols it `uses`, which the kit checks against a ledger it emits — and porting notes become instructions rather than essays.
[Porting note](docs/upgrades/0.8.0.md).

## 0.7.0 — 2026-09-18

**The plugin contract becomes injected context with a version of its own, and deleting a tenant now purges the R2 objects and plugin state the FK cascade cannot reach.** (D31; `docs/CONCEPTS.md` §16.)
[Porting note](docs/upgrades/0.7.0.md).

## 0.6.1 — 2026-09-17

**0.6.0's gate was red for anyone with a default plugin installed, and this is the fix:** the wrangler parity test demanded tomls that `pnpm plugin add` deliberately never writes.
[Porting note](docs/upgrades/0.6.1.md).

## 0.6.0 — 2026-09-17

Analytics left the kit: it is `rocketflare-plugin-analytics` 1.0.0 now, a separate repository installed by `pnpm plugin add` and listed in `.rocketflare.json` `defaultPlugins`, so a fresh clone still gets dashboards (D31; `docs/CONCEPTS.md` §8 is a pointer, §16 the decision record).
[Porting note](docs/upgrades/0.6.0.md).

## 0.5.0 — 2026-09-17

**The kit gained the seam a plugin plugs into (D31): five barrels, closed registries reopened as `CORE_X`, `pnpm plugin` as the lifecycle, and the demo feature re-shipped as the reference plugin — an app with no plugins behaves as before.**
[Porting note](docs/upgrades/0.5.0.md).

## 0.4.0 — 2026-09-16

**An agent run can now stop and ask a person, resume on their answer, and be watched live on a page of its own** (issues #17 and #7) — four schema changes and one new `[vars]` key.
[Porting note](docs/upgrades/0.4.0.md).

## 0.3.0 — 2026-09-15

Feature flags have a source (D30): `FEATURES_ENABLED` in `[vars]` decides whether a surface ships in a deployment at all, and a global admin drives the per-organisation rollout from `/admin/feature-flags` with no redeploy.
[Porting note](docs/upgrades/0.3.0.md).

## 0.2.0 — 2026-09-14

**Breaking, with three migrations.** Groups and per-row visibility for documents and dashboards, AG-UI as the wire protocol for chat and agent runs, a chat inspector with per-turn model attribution, a document viewer, and `run_worker_first` covering every API prefix.
[Porting note](docs/upgrades/0.2.0.md).

## 0.1.0 — 2026-09-11

The first release: the whole kit — `docs/CONCEPTS.md` §§1–12 — and the §13 upgrade path that lets a detached, renamed copy absorb every release after it.
[Porting note](docs/upgrades/0.1.0.md).
