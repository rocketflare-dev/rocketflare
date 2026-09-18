# /rf-upgrade — porting reference

The per-area detail behind step 3 of `SKILL.md`. Each section is a thing `pnpm kit:upgrade`
deliberately refuses to do automatically, and why doing it the obvious way goes wrong quietly.

Release notes themselves read the same way every time: `## What changed` opens with one summary
sentence and then one bullet per change, `## How to apply` is a numbered list of self-contained
steps to work top to bottom, `## Conflicts to expect` is `path → what changed → what to do`, and
`## Verify` is commands. The reasoning behind a change is not in the note — it is linked from
`docs/CONCEPTS.md`.

## Reading the plan

`.upgrade/work/<version>/plan.json` has one entry per changed file. The classes:

| class | what it means | what you do |
|---|---|---|
| `added` | a new kit file, already written and translated | nothing; review it |
| `added-collides` | the kit added a path you already have | compare with `reference/<path>`, merge by hand |
| `modified` | in `apply.patch` | nothing, unless it rejected |
| `deleted` | the kit removed it | decide. It stays unless they say otherwise |
| `skipped-surface-absent` | belongs to a surface this app deleted | **nothing. Ever.** |
| `skipped-locally-deleted` | the adopter deleted this file | nothing |
| `skipped-kit-only` | the kit's own identity: LICENSE, SECURITY.md, install.sh, the rename tool | nothing |
| `skipped-plugin-owned` | a file an installed plugin owns — see below | **nothing here.** `pnpm plugin upgrade <id>`, after this |
| `migration-derived` | `apps/web/migrations/**` | regenerate — see below |
| `manual-toml` / `manual-env` | wrangler tomls, `.dev.vars.example`, `.env.test` | see below |
| `manual` | README, CI workflows, `package.json` | read the diff in `reference/`, apply what they want |
| `binary` | not text | copy by hand if wanted |

Plus one **annotation** that is not a class: a file of any class may also carry
`touchesPluginRegistry: [<plugin ids>]`, and the report lists those under a
`touches-plugin-registry` heading as `<path> — <ids>`.

A high skipped count is health, not damage. `docs/ADAPTING.md` §2 tells every adopter to delete the
example agents, cubes and CLI commands; those deletions are what the skipped counts are made of.

## Plugins — `skipped-plugin-owned`, and the one place the two diffs meet

A plugin (D31, `docs/CONCEPTS.md` §16) is a separate git repository copied into this app, with its
own version, its own release notes and its own upgrade command. So **a kit diff never touches a byte
a plugin owns** — `classifyPath` drops every file under an installed plugin's surface as
`skipped-plugin-owned` and names the plugins in the report. That count is reported rather than
silently dropped because *"the kit changed nothing here"* and *"the kit is not allowed to change
anything here"* are different answers, and only the second one means "go and run
`pnpm plugin upgrade <id>`".

The two diffs meet in exactly one place: **the six barrels**
(`apps/web/src/plugins/{server,ui,schema,worker-exports}.ts`,
`packages/shared/src/plugins/index.ts`, `apps/cli/src/plugins/index.ts`). They are the kit's own
files, so a kit release may change them — but each installed plugin has written one line into each
it uses (`worker-exports.ts` only when it ships a Durable Object or Workflow class), and it names
them in its manifest's `registries[]`. Hence the `touches-plugin-registry` annotation. **Apply the
kit change, then prove the plugin's line survived it**:

```
pnpm plugin check
```

Never resolve one of these by deleting the plugin's line to make the patch apply cleanly: that
silently uninstalls half a plugin — the directories stay, the wiring goes, and the only symptom is
a feature that no longer exists. If the kit's change and the plugin's line genuinely cannot
coexist, that is a plugin release's job, not yours.

**Exit 6 — an installed plugin does not support the target kit version.** Its `requires.kit` range
excludes the version being ported and nothing is written. The three honest answers are: stay on this
kit version, `pnpm plugin remove <id>` first (which takes its tables — decide about `--archive`
BEFORE, not after), or `--force` with eyes open. `--force` runs the plugin against a kit its author
never tested it on.

Migrations follow the same rule as the kit's, for the same reason: a plugin ships none, and the host
runs `pnpm db:generate --name plugin-<id>-<version>`. And a **vendored** plugin — `source.repo`
equal to the kit's own repository with no subdirectory — is upgraded BY this kit upgrade;
`pnpm plugin upgrade` on one says so and does nothing.

## Migrations — the sharpest trap

**Never copy `apps/web/migrations/**`.** Port the schema (the patch already did) and run
`pnpm db:generate`.

Three reasons, worst last:

1. The kit's file index (`0007_…`) collides with the adopter's own sequence.
2. `meta/_journal.json` is one ordered array; a textual patch conflicts every time, and a merge that
   "succeeds" leaves tags that do not match the files on disk.
3. **Each `meta/NNNN_snapshot.json` carries the full cumulative schema.** Drop the kit's in and
   drizzle's notion of current state becomes one that has never heard of the adopter's tables — so
   their *next* `pnpm db:generate` emits `DROP TABLE` for their own data. Silent, delayed,
   destructive.

After `pnpm db:generate`, diff your file against `reference/apps/web/migrations/` and hand-paste
anything drizzle cannot derive from schema: `INSERT`/`UPDATE`/`DELETE` backfills, `CREATE EXTENSION`,
functions, triggers, `ALTER TABLE … USING`. A change to the embedding dimension is never a
regenerate — that is a new table and a re-embed (`docs/ADAPTING.md` §3).

## The wrangler tomls

`apps/web/wrangler.toml` and `wrangler.staging.toml` carry the adopter's real Hyperdrive and KV ids,
a live `routes` line, their `APP_URL`, and an `[ai]` block whose comment state
`pnpm bootstrap --offline` toggles. Never apply a textual patch to them.

Read `reference/apps/web/wrangler*.toml` and carry across **only** what code can observe:
`compatibility_date`, `compatibility_flags`, `[limits]`, `[triggers].crons`, `[[migrations]]`,
binding names and DO `class_name`s — and a **new binding**, which goes in with the kit's
`<PLACEHOLDER>` value, never a real id. That is exactly the shape `pnpm provision cloudflare <env>`
fills, and `wrangler-parity.test.ts` only fails on placeholders under `REQUIRE_PROVISIONED=1`, so
CI stays green in between.

Every edit goes into **both** files or the parity test fails — which is the point of it. Account-
scoped names (`queue`, `bucket_name`, workflow `name`) keep the adopter's prefix and staging keeps
its `-staging` suffix. Verify with `pnpm web test:config`.

## `.dev.vars.example` and `.env.test`

Key-level only: add the new keys with their comment block and a blank value, under the right
heading. Do not apply the diff — those files carry the adopter's own database naming.
`apps/web/src/config.ts` says whether a new key is required or feature-gated; say which in your
summary, because `.dev.vars` itself is git-ignored and they have to add it by hand.

## `package.json`

`manual` on purpose. The root `version` is the **app's** release version — `docs/DEPLOY.md` gates
deploys on `tag == root version` — so porting the kit's bump would break their release flow. Take
the dependency changes, leave the version, then `pnpm install` so the lockfile follows.

## Registries

A kit release that adds an agent, a job type, a cube, a dashboard template or a CLI command also
edits the registry that lists it. Those registry files are ordinary `modified` files, so the patch
carries the entry — but if the adopter pruned that registry, expect a reject there and re-add only
the new entry, not the kit's whole list. The registries each surface names are in
`.rocketflare.json`; `docs/ADAPTING.md` §2 is the same map written for a human.

## What the kit will not send

`LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`,
`docs/ADAPTING.md`, `scripts/install.sh`, the rename toolchain, `pnpm-lock.yaml` and the kit's logo
are the kit's identity, not the app's, and are never ported. Porting a `SECURITY.md` change would
repoint the adopter's disclosure contact at the kit's inbox; porting `install.sh` would leave a
script in their repo that clones the kit over a new directory.

`docs/upgrades/*.md` **is** ported, untranslated, so the app accumulates the same release record —
that is what makes the next upgrade legible to the next agent.
