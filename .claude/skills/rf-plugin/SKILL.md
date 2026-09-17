---
name: rf-plugin
description: Install, upgrade, remove and audit Rocketflare plugins — a plugin is a git repository copied into this app, not an npm package. Use when someone asks to add a plugin, pull in a plugin's later releases, uninstall one, check the installed set, or author a plugin of their own.
argument-hint: "[add <repo|path> | upgrade <id> | remove <id> | list | check]"
---

# /rf-plugin — the capabilities this app installs

A plugin is a **git repository copied into this app**, exactly like the kit itself: never an npm
package, never a build artefact. Its code lands as ordinary source under three roots
(`apps/web/src/plugins/<id>/`, `packages/shared/src/plugins/<id>/`, `apps/cli/src/plugins/<id>/`),
translated into this app's own vocabulary on the way in, and it reaches the host through five
barrel files and nothing else. `docs/CONCEPTS.md` §16 is the design; `apps/web/src/plugins/CLAUDE.md`
is the seam; `reference.md` beside this file is the manifest shape, the exit codes and what each
command verifies.

**The rule that matters most:** installing a plugin gives it full Worker and database access, so it
is as trusting as merging a pull request. Every command prints a plan and stops. **You show the
plan to the user and get an explicit yes before you ever type `--apply`.** Never chain the two.

`$ARGUMENTS` is the command and its target. With none, run step 4 (`list` + `check`) and ask what
they want to do.

## 1. Check the ground

```
git status --short && pnpm plugin list && pnpm plugin check
```

Expect a clean tree, one line per installed plugin (`id  version  repo  installedAt`, `(local)` for
a sidecar install), and either `✔ n plugin(s) check out: …` or `No plugins installed.`

A dirty tree: ask them to commit or stash. `add` and `upgrade` refuse one (`--allow-dirty` exists
and is for people who know why they are using it) because the install should be one reviewable diff.

## 2. `add` — read the plan, then ask

```
pnpm plugin add <repo|path>[@ref] [--subdir <dir>]
```

A **repo URL** is mirrored under `.upgrade/plugins/` (`--no-fetch` reuses the cache offline); a
**local path** is read directly, which is the authoring loop (step 6). Expect a plan with these
blocks and **"Nothing written. Read the plan, then re-run with --apply to install."** at the end:

- `Plugin` / `Source` / `Host` / `Names` — what, from where, into which manifest file, and whether
  the names are being translated into this app's vocabulary or copied in kit vocabulary.
- `Requirements` — three `✔` lines (`kit <version> satisfies <range>`, `surfaces`, `plugins`) or one
  `✖` per unmet requirement. **Any `✖` is exit 6 and nothing is written** — report it and stop.
- `Files (n)` — a count per root, plus `(not copied) migrations/` for any install fragment.
- `Barrel lines` — the exact line each of the five barrels gains.
- `Dependencies` — what will be installed into which package.
- **`Then, by hand — nothing below is done for you`** — the numbered steps in step 3's table.
- `Verify` — the plugin's own note, if it ships one.

Summarise it in three or four lines — what the plugin is, what it adds, what tables it wants, which
by-hand rows apply — then **ask** (`AskUserQuestion`): install it, or stop. On yes:

```
pnpm plugin add <repo|path>[@ref] --apply
```

Expect `✔ n file(s) copied and translated`, `✔ n barrel line(s) written`, `✔ surface '<id>'
recorded in .rocketflare.json`. Then do step 3 — **the app does not typecheck or run until the
tables exist.**

## 3. The by-hand rows the plan printed

The script refuses these deliberately. Each one appears in the plan only when the plugin declares
it; work through the ones that did, in the order printed.

| What | How | Expect | What you change |
|---|---|---|---|
| **The migration** (`schema.tables` declared) | `pnpm db:generate --name plugin-<id>-<version>`, **read the SQL**, then `pnpm db:migrate` | `CREATE TABLE` for each declared table, at YOUR migration index, in YOUR journal | Nothing by hand. Never copy a migration from the plugin repo — a foreign snapshot teaches drizzle a current state that never heard of your tables, and your next `db:generate` drops them |
| **An install fragment** (`migrations/` in the repo) | `pnpm db:generate --custom --name plugin-<id>-install`, then paste the named file into it | an empty custom migration to fill | The data half only (backfills, extensions, triggers) — DDL still comes from the schema |
| **Bindings, crons, route prefixes, non-secret `[vars]`** | `pnpm provision cloudflare <env>` per environment | `plugins: <id> → <BINDING>=<app>-<id>-<name>[-staging]`, then `<toml>: plugin declarations written` for BOTH tomls | Nothing by hand. You never type a resource id into a toml and never edit one while a phase runs (`/rf-provision`) |
| **A `vars` entry marked `secret`** | add `KEY=` to `apps/web/.dev.vars.example` **and** `apps/web/.dev.vars`, then `pnpm provision secrets <env>` | the key listed by `wrangler secret list` for that environment | The two files by hand. A secret is never a `[vars]` key — not even in staging |
| **`workerExports`** (a Durable Object or Workflow class) | add `export { <Class> } from './plugins/<id>/…'` to `apps/web/src/worker.ts` | `pnpm typecheck` green, the class named in both tomls' `[[durable_objects]]`/`[[workflows]]` after provisioning | That one export line. `api/index.ts` exports the Hono app only — the classes live in `worker.ts` |
| **The gate** | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` | exit 0 | Nothing. A failure here is the install, not the kit — read it before committing |

Then commit: one commit, message `Install plugin <id>@<version>`, so the next upgrade reads against it.

## 4. `list` and `check` — the audit

```
pnpm plugin list
pnpm plugin check
```

`check` exits 1 with one `✖` line per failure and says what is wrong, not how to fix it. The
failures it can report, and what each means, are in `reference.md`. The common one:
`<id>: declares tables (…) and no migration names it` — step 3's first row was never done.

## 5. `upgrade` and `remove`

**Upgrade** ports the plugin's *own* later releases, by exactly the machinery `pnpm kit:upgrade`
uses on the kit:

```
pnpm plugin upgrade <id> [--to <ref>]        # the plan
pnpm plugin upgrade <id> [--to <ref>] --apply
```

Exit 4 means hunks rejected — **work remaining, not a failure**, and the script deliberately does
not stamp the new version until the `*.rej` files are gone. A **vendored** plugin (its `source.repo`
is this kit's own repository with no subdirectory — `example-feature` is one) answers *"upgrade it
with `pnpm kit:upgrade`"* and does nothing: the kit release that moves it forward is the one that
moves it.

**Remove** is the mirror, and it takes the data with it:

```
pnpm plugin remove <id>                       # the plan: directories, barrel lines, tables
pnpm plugin remove <id> --archive --apply     # --archive first copies each table into schema `archive`
pnpm db:generate --name plugin-<id>-remove    # → DROP TABLE …; read it, then pnpm db:migrate
```

Ask about `--archive` **before** applying — after the drop it is not a choice any more. The plan
also prints what to deprovision by hand: provisioning creates a plugin's Cloudflare resources but
never deletes one, and `pnpm remove` on a dependency is printed rather than run.

## 6. Authoring a plugin

The loop is a local path plus the sidecar:

```
pnpm plugin add ../rocketflare-plugin-<id> --local --apply   # read directly, recorded in .rocketflare.local.json
# edit it in place; the host's own `pnpm test` runs its tests
pnpm plugin export <id> <dir>                                 # copy it back out as a repository
```

`--local` records the install in the **git-ignored `.rocketflare.local.json` sidecar** rather than
in `.rocketflare.json`, and is implied inside the kit itself — a plugin wired into a kit checkout is
an authoring convenience, and committing it would push that wiring into every copy made from the
commit. `export` writes the three trees plus a regenerated `rocketflare-plugin.json`; `git init &&
git add -A && git commit` makes it a plugin repository.

Cutting a plugin release: there is **no `pnpm plugin:release`**. In the plugin's own repository run
`node scripts/release.mjs X.Y.Z` — the same script the kit uses, which detects a
`rocketflare-plugin.json` with no `.rocketflare.json` and stamps that manifest's `version` (and a
`package.json` if the repo has one) instead of the kit's. Copy the script in from the kit if the
plugin repo does not carry it yet. It folds `docs/upgrades/unreleased.md` into
`docs/upgrades/X.Y.Z.md` and prepends the `CHANGELOG.md` section — the same four headings and
`previous` chain `pnpm plugin upgrade` walks, which is what makes the release portable at all.

Everything the plugin keys carries its id: tables `<id>_*`, job types `<id>.verb`, the API prefix
`/api/<id>`, query-key roots `<id>:…`, the CLI command `<id>`, feature/prompt/agent keys, and AG-UI
CUSTOM events under `<id>.`.

## 7. Hand back

End the turn with `AskUserQuestion`, not a paragraph. After an install: **run it** (`pnpm dev` and
open the plugin's page), **provision its resources** (`/rf-provision`, if it declared bindings —
they type that one themselves), **install another**, or **stop**.

## Rules

- **Read the printed plan, show it, and get a human yes before `--apply`.** A plugin has full Worker
  and database access; this stop is the only review there is.
- **Never copy a plugin's migration**, and never touch `apps/web/migrations/meta/`. The host
  generates its own once the schema barrel line exists.
- **Never edit `.rocketflare.json`, `.rocketflare.local.json` or any of the five barrels by hand.**
  The script writes them, and `pnpm plugin check` is what proves the two halves agree.
- **Never write a resource id into a wrangler toml.** A declared binding is `pnpm provision
  cloudflare <env>`'s job, per environment, into both files.
- **Never `kit.` for a plugin's AG-UI CUSTOM events** — that namespace is the kit's, and a
  third-party client is entitled to ignore it. Use `<id>.`.
- **Expand and contract; never rename.** Add a column or a table, migrate, then remove the old one
  in a later release — drizzle-kit's rename prompt has no non-interactive answer.
- A plugin writes only inside its own roots. A file outside them is a refusal, not a warning: an
  install has to stay reversible by deleting a directory.
- `rm -rf .upgrade` is always safe — it is a cache.
