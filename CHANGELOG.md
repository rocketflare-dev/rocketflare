# Changelog

Releases of the kit. Each one links to its porting note in [`docs/upgrades/`](docs/upgrades/) —
the note is the instruction set `pnpm kit:upgrade` and the `/rf-upgrade` skill follow to bring a
copy of the kit forward without recreating anything its owner deleted.

If you are running a copy: `pnpm kit:upgrade` tells you which of these you are missing.

## 0.6.0 — 2026-09-17

**Analytics left the kit.** It is `rocketflare-plugin-analytics` 1.0.0 now — a separate repository, installed by `pnpm plugin add`, and listed in `.rocketflare.json` `defaultPlugins` so `bash scripts/bootstrap.sh` still gives a fresh clone dashboards without anybody doing anything (D31 decisions 2, 6 and 7; `docs/CONCEPTS.md` §8 is now a pointer, §16 is the decision record).
[Porting note](docs/upgrades/0.6.0.md).

## 0.5.0 — 2026-09-17

**The kit gained plugins (D31).** A plugin is a git repository copied into an app, never an npm package, wired through five barrels and installed, upgraded, removed and audited with `pnpm plugin` (and `/rf-plugin`); the demo feature became the vendored reference plugin `example-feature`, provisioning creates a plugin's bindings, CI proves the kit against its `defaultPlugins`, and every skill and the bootstrap know about it. An app with no plugins installed behaves exactly as before.
[Porting note](docs/upgrades/0.5.0.md).

## 0.4.0 — 2026-09-16

**An agent run can now stop and ask a person, resume on their answer, and be watched live on a page of its own** (issues #17 and #7).
[Porting note](docs/upgrades/0.4.0.md).

## 0.3.0 — 2026-09-15

Feature flags, in two layers: `FEATURES_ENABLED` in `[vars]` decides whether a surface exists in a
deployment at all — fail-closed, so half-built code can be released to production dark — and a
global admin drives the rollout from `/admin` with a percentage, per-organisation overrides and no
redeploy. Flag keys are code, so adding one needs no migration and a typo is a type error. **A flag
is configuration, not a permission**: every gate reads `auth.features`, never the CASL ability,
because `manage all` and `access all` are wildcards that would hand platform staff an unreleased
surface — the rule comes from an app on this kit that shipped exactly that. A feature ships dark on
every door, including the two with no nav entry: the cube registry and the dashboard templates,
which seed themselves into every organisation on the first page load after a deploy. Not breaking;
one migration. [Porting note](docs/upgrades/0.3.0.md).

## 0.2.0 — 2026-09-14

Groups: an organisation declares group types, and group membership decides who may read a knowledge
document or a dashboard — an explicit `visibility` column, so removing the last group narrows rather
than publishes. Chat and agent runs now speak [AG-UI](https://docs.ag-ui.com) on the wire instead of
a shape only this repo understood, a long thread forgets deliberately rather than overflowing, and
the chat box calls the knowledge tools. A document is readable over HTTP and has a viewer; a chat
thread has an inspector. Workers AI forces tools properly and its zero-key floor is a model that can
run the agents. **Breaking, with three migrations** — read the note before you port any of it.
[Porting note](docs/upgrades/0.2.0.md).

## 0.1.0 — 2026-09-11

The first release: the whole kit, and the upgrade path that lets a copy absorb what comes next.
[Porting note](docs/upgrades/0.1.0.md).
