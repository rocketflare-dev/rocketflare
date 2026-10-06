# Changelog

Releases of the kit. Each one links to its porting note in [`docs/upgrades/`](docs/upgrades/) —
the note is the instruction set `pnpm kit:upgrade` and the `/rf-upgrade` skill follow to bring a
copy of the kit forward without recreating anything its owner deleted.

If you are running a copy: `pnpm kit:upgrade` tells you which of these you are missing.

## 0.17.5 — 2026-10-06

A dropped Neon WebSocket connection now rejects its query instead of crashing the process, and `db-roles` waits for the database before its first statement, so a gate branch's first connection is retried like the migrator's.
[Porting note](docs/upgrades/0.17.5.md).

## 0.17.4 — 2026-10-06

The bootstrap gets cheaper inside a coding sandbox: `--offline` no longer runs `wrangler whoami`, `--no-install` skips step 2, `ROCKETFLARE_BOOTSTRAP_SKIP` leaves out named steps and `ROCKETFLARE_ALLOW_ROOT=1` lifts the root refusal. `pnpm install` stops downloading cloudflared; `pnpm dev:tunnel` installs it the first time it needs it.
[Porting note](docs/upgrades/0.17.4.md).

## 0.17.3 — 2026-10-06

A slow machine can raise every test time limit: `TEST_LATENCY_FACTOR` scales the vitest test, hook and teardown limits up, never down, so a coding sandbox running one test by hand stops timing out at 5 s.
[Porting note](docs/upgrades/0.17.3.md).

## 0.17.2 — 2026-10-06

CI waits for one runner, not two: the Launch attestation lookup becomes `Gate`'s first step. A failed bundle attach no longer turns a live staging deploy red, old bundle drafts are pruned, and `plugin upgrade` removes only packages a plugin added.
[Porting note](docs/upgrades/0.17.2.md).

## 0.17.1 — 2026-10-05

Plugin dependencies stay in step: `plugin add` keeps declared ranges, `plugin check` accepts narrower ones, `plugin upgrade --apply` installs, re-ranges and removes them; and `kit:upgrade` prints porting-note paths that exist in the copy.
[Porting note](docs/upgrades/0.17.1.md).

## 0.17.0 — 2026-10-05

CI and deploy stop repeating work on an already-gated tree: `ci.yml` can reuse Launch's `launch/gate` attestation, a version-only release bump rides its parent's green CI, and production deploys staging's verified bundle instead of rebuilding.
[Porting note](docs/upgrades/0.17.0.md).

## 0.16.3 — 2026-10-05

`pnpm kit:upgrade` and the rename now write `.rocketflare.json` in Biome's layout, so a copy's own `pnpm lint` passes on the stamped file instead of failing on the arrays `JSON.stringify` spread over several lines.
[Porting note](docs/upgrades/0.16.3.md).

## 0.16.2 — 2026-10-04

A copy now numbers its own releases: `scripts/rename.mjs` restarts the root `package.json` version at `0.1.0` and empties `CHANGELOG.md`, so an app no longer carries on from the kit's version; the kit version stays in `.rocketflare.json`.
[Porting note](docs/upgrades/0.16.2.md).

## 0.16.1 — 2026-10-04

With `AUTH_OIDC_ONLY=true` the login page no longer redirects to the issuer on its own: it shows one "Continue with <label>" button, so signing in through SSO (Launch, Okta, Keycloak…) is always a click.
[Porting note](docs/upgrades/0.16.1.md).

## 0.16.0 — 2026-09-30

`pnpm gate` is now the one definition of an app's checks — lint, typecheck, test, build — run before every commit, as a copy's single CI job and by Launch's ship gate, with the driver seam proved under both drivers.
[Porting note](docs/upgrades/0.16.0.md).

## 0.15.8 — 2026-09-29

The kit's own tests now live in `apps/web/tests/kit-only/`, which the rename deletes and the upgrade never ports, so a copy's gate no longer fails on the kit's version chain.
[Porting note](docs/upgrades/0.15.8.md).

## 0.15.7 — 2026-09-29

`pnpm test:ephemeral` runs the test suite with no Docker against a throwaway Neon gate branch, which `safetyCheck()` accepts only when the caller names the branch and binds it to the URL's endpoint.
[Porting note](docs/upgrades/0.15.7.md).

## 0.15.6 — 2026-09-28

Opening a magic link no longer spends its token: `GET /auth/magic-link/verify` redirects to a new `/magic-link/confirm` page whose "Sign in" button posts the token, so mail scanners (Safe Links, Mimecast) cannot break sign-in.
[Porting note](docs/upgrades/0.15.6.md).

## 0.15.5 — 2026-09-28

`db:migrate:ci` now works as a least-privilege owner without CREATEDB: the role phase switches the app role's CREATEDB and CREATEROLE off only when they are on, which Postgres 16+ otherwise refuses.
[Porting note](docs/upgrades/0.15.5.md).

## 0.15.4 — 2026-09-28

An app's staging and production deploys check wrangler parity with the parity test alone, so the depth-1 deploy checkout no longer fails the whole config project on tests that read git history.
[Porting note](docs/upgrades/0.15.4.md).

## 0.15.3 — 2026-09-28

A copy's CI no longer re-runs its gate with default plugins (which failed on every copy with plugins installed), deploys skip the gate for an already-green commit, and the neon test run stops timing out.
[Porting note](docs/upgrades/0.15.3.md).

## 0.15.2 — 2026-09-28

Renaming now keeps `rocketflare-dev/` references upstream, names the test Compose project per app, and gives a hyphenated slug the `<snake>_` API-key prefix and a green gate, which a new CI job proves on every pull request.
[Porting note](docs/upgrades/0.15.2.md).

## 0.15.1 — 2026-09-28

A rename to a hyphenated slug no longer breaks the evals script: the kit never uses its own name as a code identifier, and a config test enforces it.
[Porting note](docs/upgrades/0.15.1.md).

## 0.15.0 — 2026-09-27

The kit now runs on two database drivers, chosen per deployment by `DATABASE_DRIVER`: the Neon serverless driver (a fresh copy's default, no Hyperdrive) or postgres.js through Hyperdrive (any Postgres, and what an existing copy keeps).
[Porting note](docs/upgrades/0.15.0.md).

## 0.14.0 — 2026-09-27

Five opt-in capabilities, all off by default: sign-in with any OIDC issuer, deploying through an external deployer so CI holds no Cloudflare token, configurable dev ports, `pnpm bootstrap --db-url` against an existing database with no Docker, and a `db-roles` fix so migrations and deploys work as Neon's owner role.
[Porting note](docs/upgrades/0.14.0.md).

## 0.13.0 — 2026-09-27

Plugins can ship agent skills: a plugin declares `"skills"`, keeps them at `skills/<dir>/`, and `pnpm plugin add` installs each at `.claude/skills/<dir>/`, where `upgrade` replaces and `remove` deletes it.
[Porting note](docs/upgrades/0.13.0.md).

## 0.12.0 — 2026-09-26

The plugin surface gains the seams a connector needs: unauthenticated public mounts under `/api/hooks/<id>`, signed round-trip state, feature checks off-request, and idempotent knowledge ingest keyed by an external id.
[Porting note](docs/upgrades/0.12.0.md).

## 0.11.0 — 2026-09-26

Developer-run evals for chat and agents: `pnpm eval` runs vitest-evals suites against the real code in-process, with baselines and `--compare`, and thumbs on answers feed `rocketflare evals promote`.
[Porting note](docs/upgrades/0.11.0.md).

## 0.10.1 — 2026-09-25

A copy of the kit now hears about newer kit releases on its own: a Claude Code `SessionStart` hook tells the person once per session, with each release's summary and a pointer to `/rf-upgrade`.
[Porting note](docs/upgrades/0.10.1.md).

## 0.10.0 — 2026-09-25

AI tracing now exports vendor-neutral OTLP spans with GenAI conventions — nested model, tool, retrieval and embeddings spans — to Langfuse, Phoenix or any backend, and records them locally for `rocketflare traces`.
[Porting note](docs/upgrades/0.10.0.md).

## 0.9.0 — 2026-09-18

A plugin's `agentTools` may now be async and answer per tenant, and `@/plugins/api` exports `sealSecret`/`openSecret` so a plugin can store a tenant's credential encrypted.
[Porting note](docs/upgrades/0.9.0.md).

## 0.8.1 — 2026-09-18

Agent context now loads on demand: rules scope by `paths:` and `CLAUDE.md` names its docs rather than `@`-importing them, cutting roughly 100k tokens from every session start.
[Porting note](docs/upgrades/0.8.1.md).

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
