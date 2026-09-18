# /rf-plugin — reference

What `pnpm plugin` reads, what it refuses, and what each command proves. The design and its
reasons are `docs/CONCEPTS.md` §16; the seam is `apps/web/src/plugins/CLAUDE.md`. This file is for
looking things up mid-run.

## Exit codes (`pnpm plugin --help` is authoritative)

| Code | Meaning | What it usually is |
|---|---|---|
| 0 | ok | a plan printed, or an apply that landed |
| 1 | error | anything the script names and stops on |
| 2 | usage | a missing or unknown argument |
| 3 | unreachable with no cached mirror | a bad repo URL, or offline with nothing under `.upgrade/plugins/` — `--no-fetch` reuses the cache |
| 4 | applied with rejects (`upgrade`) | work remains; the version stamp is deliberately withheld until the `*.rej` files are gone |
| 5 | no `rocketflare-plugin.json` at the source | the path or repo is not a plugin |
| 6 | a requirement is unmet | `requires.kit` / `requires.surfaces` / `requires.plugins`. **Nothing is written** |
| 7 | the target path exists | most often "plugin '<id>' is already installed — `pnpm plugin upgrade <id>` moves it forward" |

## The manifest — `rocketflare-plugin.json`

At the **root of the plugin repository**, and copied into the host as
`apps/web/src/plugins/<id>/plugin.json`, which is the surface's **anchor**: presence is `existsSync`
on it, so deleting the directory IS uninstalling and there is no bookkeeping to drift. The kit's own
reference plugin is the worked example — `apps/web/src/plugins/example-feature/plugin.json`:

```json
{
  "id": "example-feature",
  "label": "Example feature",
  "version": "0.1.0",
  "repo": "https://github.com/rocketflare-dev/rocketflare.git",
  "subdir": "",
  "anchor": "apps/web/src/plugins/example-feature/plugin.json",
  "paths": [
    "apps/web/src/plugins/example-feature/**",
    "packages/shared/src/plugins/example-feature/**",
    "apps/cli/src/plugins/example-feature/**"
  ],
  "registries": [
    "apps/web/src/plugins/server.ts",
    "apps/web/src/plugins/ui.ts",
    "apps/web/src/plugins/schema.ts",
    "packages/shared/src/plugins/index.ts",
    "apps/cli/src/plugins/index.ts"
  ],
  "requires": { "kit": ">=0.5.0 <1.0.0", "surfaces": [], "plugins": [] },
  "dependencies": { "apps/web": {}, "packages/shared": {}, "apps/cli": {} },
  "bindings": [],
  "crons": [],
  "apiPrefixes": [],
  "vars": [],
  "workerExports": [],
  "schema": { "tables": ["example_notes"], "rlsExcluded": [] },
  "migrations": ["example_notes, tenant-scoped, RLS policy"]
}
```

Field notes, in the order they bite:

- **`id`** matches `^[a-z][a-z0-9-]*$`, never contains the kit's name (the rename translator would
  rewrite it), and is never `index` / `server` / `ui` / `schema` / `types` — those are barrel
  filenames. It is the namespace for everything: tables `<id>_*`, job types `<id>.verb`, query-key
  roots `<id>:…`, the API prefix `/api/<id>`, the CLI command, feature/prompt/agent keys, AG-UI
  CUSTOM events `<id>.`.
- **`repo` is required** and `subdir` optional — a plugin you cannot fetch again cannot be upgraded.
  `repo` equal to the kit's own repository with an empty `subdir` means **vendored**: `upgrade`
  defers to `pnpm kit:upgrade` and `requires.kit` is not checked at all, because the same release
  cut both.
- **`registries`** are the six host barrels, listed so `pnpm kit:upgrade` can flag a kit change to
  one of them as `touches-plugin-registry` — the kit CAN move ground under a plugin.
- **`dependencies`** are installed into the HOST's packages (`pnpm --dir apps/web add …`). A plugin
  ships no `package.json` of its own into a host.
- **`bindings[]`** is `{ type, binding, name?, consumer?, className?, storage? }`, and `type` is one
  of **five**: `kv`, `queue`, `r2`, `workflow`, `durable_object`. Anything else (`d1`, `vectorize`,
  `hyperdrive`…) is refused at INSTALL, naming the type, rather than surfacing as a 503 after a
  deploy that silently skipped it. `binding` is what the code reads off `Cloudflare.Env` and is
  identical in both environments; `name` is the account-scoped half. Resource names come out as
  `<app>-<id>-<name>[-staging]`, and `<APP>_<ID>_<NAME>[_STAGING]` for KV, mirroring the kit's own
  `<APP>_RATE_LIMIT[_STAGING]`.
  - The first three are **created** by `cf-provision.sh`; `workflow` and `durable_object` are
    **declared only** — `wrangler deploy` registers both from the block.
  - A `workflow` or `durable_object` must declare `className`, the class its `worker-exports.ts`
    re-exports. A `durable_object` must ALSO declare `storage` (`"sqlite"` or `"none"`), which
    picks `new_sqlite_classes` over `new_classes` and **cannot be changed afterwards** — which is
    why it is required rather than defaulted — and it declares no `name` at all, because it has no
    account-scoped resource.
- **`vars[]`** is `{ key, example?, secret? }`. `secret: true` is a Worker secret
  (`.dev.vars.example` + `pnpm provision secrets <env>`); anything else is a `[vars]` key written
  into BOTH tomls, because the parity test compares the keys.
- **`workerExports`** are the Durable Object / Workflow class names the plugin's
  `apps/web/src/plugins/<id>/worker-exports.ts` re-exports. **Nobody adds a line by hand**: that
  file is the sixth barrel's half, `plugin add` writes the barrel line, and `plugin check` fails if
  the file does not export every name declared here. Cloudflare resolves `class_name` against the
  named exports of `src/worker.ts` and nowhere else, which is the whole reason the barrel exists.
- **`schema.tables`** drives both the "generate a migration" step and the `check` below;
  `schema.rlsExcluded` is the plugin's half of `RLS_EXCLUDED_TABLES`, with a reason, for a table
  that has no `tenant_id`.
- **`migrations[]`** carries *descriptions*, never file names. A plugin ships no migration, ever.

## How `add` classifies each file of the source repo

The rule it enforces: **a plugin writes only inside its own four roots**, so an install stays
reversible by deleting a directory.

| Role | Which paths | What happens |
|---|---|---|
| `copy` | `apps/web/src/plugins/<id>/`, `packages/shared/src/plugins/<id>/`, `apps/cli/src/plugins/<id>/`, `docs/plugins/<id>/` | copied and translated through the same `applyReplacements()` the rename used |
| `note` | `docs/upgrades/*` | copied to `docs/plugins/<id>/upgrades/` — the release chain `plugin upgrade` walks |
| `fragment` | `migrations/**` | **never copied**; printed as a `pnpm db:generate --custom` step |
| `meta` | `rocketflare-plugin.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `SECURITY.md` | read, not copied |
| `repo-only` | `.github/`, `.git/`, `node_modules/`, `.claude/`, `package.json`, `pnpm-lock.yaml`, `biome.json`, the dotfiles | the plugin repository's own; never copied |
| `refused` | anything else | the install stops. A plugin that edits `api/index.ts` on the way in is an install nobody can reverse |

## What `check` verifies

One `✖` line per failure and exit 1 on any; silence plus `✔ n plugin(s) check out` otherwise. Per
installed plugin:

- the **anchor** file exists — "the surface says installed, the tree says no";
- **`requires`** still holds: the kit version is inside `requires.kit`, every required surface is
  present, every required plugin is installed (skipped entirely for a vendored plugin);
- for each of the six barrels, the **line and the half agree both ways** — a barrel that names a
  plugin half that is not on disk, and a half on disk that no barrel names;
- no **`*.rej`** anywhere under its directories ("an upgrade left work behind");
- the **anchor's `version` matches the surface's** `source.version`;
- when it declares tables, **some migration tag names `plugin-<id>`** — otherwise the tables were
  never generated, which is the most common thing to have skipped;
- when it declares `workerExports`, its `worker-exports.ts` exists and **exports every name** —
  a class in the file but not the manifest is invisible to provisioning, and a name in the manifest
  but not the file is a binding pointed at nothing, which makes `wrangler deploy` refuse the script.

`pnpm plugin check --json` prints the same audit as data: `{ ok, plugins, failures, notes }`, where
a failure carries the remedial step and its `kind`.

## Where an install is recorded

A `kind: 'plugin'` **surface** carrying `source: { repo, subdir, version, commit }`, `installedAt`,
`requires` and `history[]` — so §13's upgrade machinery covers it for free. Two files:

- **`.rocketflare.json`** — an app, committed, so the team and CI see it.
- **`.rocketflare.local.json`** — the git-ignored **sidecar**, used with `--local` and always inside
  the kit itself (`app === null`). A plugin wired into a kit checkout is an authoring convenience,
  not part of what the kit ships; committing it would push wiring for files a copy does not have
  into every copy made from that commit. `pnpm plugin list` marks a sidecar install `(local)`.

Readers see the merged view and should not care which file a surface came from; only a writer
chooses, and `readManifest()` (`scripts/lib/manifest.mjs`) is the one kit-vs-app predicate.

## `defaultPlugins`

`.rocketflare.json` carries a top-level `defaultPlugins` array — the plugins a **fresh clone**
installs before the app is first run. `scripts/bootstrap.mjs`'s `plugins` step reads it, skips every
id already installed, runs `pnpm plugin add <repo> --apply` for the rest, then `pnpm db:generate`
and `pnpm db:migrate` once. `pnpm bootstrap --no-plugins` skips the step. It is `[]` in the kit
today — `analytics`, extracted in 0.6.0 — so the step installs it and
passes.

## Two things nothing else will catch

- **Migrations are the host's, always.** Each `meta/NNNN_snapshot.json` carries the whole cumulative
  schema, so importing a foreign one teaches drizzle a current state that has never heard of this
  app's tables — and the *next* `pnpm db:generate` emits `DROP TABLE` for real data. Silent,
  delayed, destructive.
- **Expand and contract, never rename.** drizzle-kit's rename prompt has no non-interactive answer,
  so a plugin release that renames a column is a release nobody can apply unattended. Add, migrate,
  backfill, remove in a later version.
