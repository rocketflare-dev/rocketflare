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
| 5 | no `rocketflare-plugin.json` at the SOURCE | the path or repo is not a plugin. That is the filename at a plugin REPOSITORY's root; the copy inside a host is `plugin.json` |
| 6 | a requirement is unmet | the `minKit` floor, `requires.surfaces`, `requires.plugins`, or a symbol its `uses` names that this kit's ledger does not carry. **Nothing is written** |
| 7 | the target path exists | most often "plugin '<id>' is already installed — `pnpm plugin upgrade <id>` moves it forward" |

## The manifest — `rocketflare-plugin.json` in the repo, `plugin.json` in the host

**One file, two names, and the distinction is load-bearing when you are reading a diagnostic.**
`rocketflare-plugin.json` is the name at the **root of a plugin repository** — it is what `add`
looks for at the source, and what exit 5 is about. `plugin.json` is the name it is copied in under,
at `apps/web/src/plugins/<id>/plugin.json`, and that copy is the surface's **anchor**: presence is
`existsSync` on it, so deleting the directory IS uninstalling and there is no bookkeeping to drift.
**Every `pnpm plugin check` finding about a manifest names the in-tree `plugin.json`**, because that
is the file to edit; `pnpm plugin export` writes the other name back out. The kit's own reference
plugin is the worked example — `apps/web/src/plugins/example-feature/plugin.json`:

```json
{
  "id": "example-feature",
  "label": "Example feature",
  "version": "0.1.0",
  "repo": "https://github.com/rocketflare-dev/rocketflare.git",
  "subdir": "",
  "anchor": "apps/web/src/plugins/example-feature/plugin.json",
  "minKit": "0.8.0",
  "uses": {
    "@/plugins/api": ["createRouter", "requestCtx", "RequestCtx", "requireFeature", "validate"],
    "@/db/schema/kit": ["tenantIsolation", "tenantRef", "tenants", "timestamps"],
    "@testkit/integration": ["createTestEnv", "request", "setupTestDatabase"]
  },
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
  "requires": { "surfaces": [], "plugins": [] },
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
  filenames. It is the namespace for everything: job types `<id>.verb`, query-key
  roots `<id>:…`, the API prefix `/api/<id>`, the CLI command, feature/prompt/agent keys, AG-UI
  CUSTOM events `<id>.`, and **tables prefixed with the id's first hyphen-separated segment**
  (`example-feature` → `example_*`, `analytics` → `analytics_*`; a longer prefix is welcome, not
  required). That last one is a convention rather than something the tooling derives — nothing
  anywhere turns an id into a table name — so what is enforced is the COLLISION: `check` fails when
  two installed plugins declare the same table name.
- **`minKit`** is a TOP-LEVEL key — a sibling of `id` and `version`, never nested under `requires`,
  which is refused by name. One bare `X.Y.Z`: a FLOOR, no ceiling, no range language (`>=`, `^` and
  a second bound are all errors). It says how old a kit this plugin still works with, which is the
  only half of compatibility a plugin can state honestly.
- **`uses`** is the other half and is **DERIVED, never hand-written**: `{ "<entry>": ["<symbol>"] }`,
  the host symbols this plugin imports, written by `pnpm plugin export` from its own files. The kit
  emits the matching `## Surface ledger` in `docs/plugin-api.md`, and compatibility is the set
  difference — every symbol `uses` names that the ledger does not carry fails the install, naming
  the symbol and the import that replaces it. A hand-written `uses` is a claim rather than a
  measurement, which is the failure mode all of this replaced.
- **`requires.kit` and `requires.pluginApi` are gone**, and a manifest still carrying either fails
  LOUDLY naming the replacement rather than being ignored. Both were predictions about kits that did
  not exist yet, and both went stale (`docs/CONCEPTS.md` §16, decision 5c).
- **`repo` is required** and `subdir` optional — a plugin you cannot fetch again cannot be upgraded.
  `repo` equal to the kit's own repository with an empty `subdir` means **vendored**: `upgrade`
  defers to `pnpm kit:upgrade` and `minKit` is not checked at all, because the same release cut
  both.
- **`anchor`** is the path the manifest is copied to inside a host, and that copy is written by
  `pnpm plugin add` from the source manifest. **Do not hand-edit it**: a plugin's version exists
  once, which is what stops an anchor left behind failing every install of a correct release.
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
- **`schema.tables`** drives the "generate a migration" step, the isolation-test check and the
  cross-plugin collision check below — so a table missing from it is a table nothing verifies;
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

One `✖` line per failure and exit 1 on any; silence plus `✔ n plugin(s) check out` otherwise.
**Every finding is `<file>:<line> <what is wrong> — <the exact change>`** — the line number only
where the complaint is AT a place in a file, never fabricated. Per installed plugin:

- the **anchor** file exists — "the surface says installed, the tree says no" — and **parses**;
- **every manifest field**, naming the field and its legal values: a non-semver `version`, a
  `minKit` that is not a bare `X.Y.Z` or is nested under `requires`, a retired `requires.kit` or
  `requires.pluginApi`, a `requires.plugins` entry written as `"<id>@<range>"`, a `uses` that is not
  a map of arrays, a cron that is not five fields, a `vars` entry with no key, `schema.tables` that
  is not an array, a malformed `coreEdits` entry, and the `bindings[]` rules;
- **`requires` and the floor** still hold: this kit is at or above `minKit` (skipped for a vendored
  plugin, and for one being authored inside the kit itself — there the floor is always one bump
  ahead of `package.json` until `pnpm kit:release` runs), every required surface is present, and
  every required plugin is installed at or above its `minVersion`;
- **the ledger diff** — every symbol the plugin's `uses` names against what this kit's
  `## Surface ledger` provides. This is the compatibility check, and unlike the two version numbers
  it replaced it cannot go stale: `uses` is derived from the plugin's own imports and the ledger is
  generated from the kit's own source. Each finding names the symbol and its replacement import;
- for each of the six barrels, the **line and the half agree both ways** — a barrel that names a
  plugin half that is not on disk, and a half on disk that no barrel names;
- no **`*.rej`** anywhere under its directories ("an upgrade left work behind");
- when it declares tables, **some migration tag names `plugin-<id>`** — otherwise the tables were
  never generated, which is the most common thing to have skipped;
- **every declared dependency is really in the host `package.json`** — `plugin add --apply` runs
  `pnpm --dir <pkg> add`, and until now nothing ever looked again, so an install that failed
  part-way left a plugin whose imports cannot resolve while every other check read as clean;
- **`workerExports` both ways**: its `worker-exports.ts` exists and exports every declared name (a
  name in the manifest but not the file is a binding pointed at nothing, and `wrangler deploy`
  refuses the whole script for it), and it declares every name the file exports (a class the
  manifest does not name is invisible to provisioning, which reads that list to write the binding
  block). A file carrying an `export *` is skipped in both directions — its names cannot be known
  without resolving the module, and guessing teaches an author to distrust the audit;
- when it declares tenant-scoped tables, **a tenant-isolation test exists** under
  `src/plugins/<id>/tests/api/`. This is the kit's one non-negotiable that the kit itself cannot
  write, and it is structural: it proves such a test EXISTS, not that it is right, and the message
  says so. It wants a file that creates a SECOND organisation and names it or the property;
- when it declares a `durable_object` binding, **`hooks.onTenantDeleted` is declared somewhere in
  its tree** — a Durable Object is state the FK cascade cannot reach, so a deleted tenant's DO
  state outlives it, and no other check can see that because its tables are gone;
- **no two installed plugins declare the same table name.** The prefix convention is what keeps
  them apart and nothing derives a table name from an id, so the collision is the checkable half —
  and nothing else in the kit sees it. TS2308 catches a duplicated EXPORT symbol, not a duplicated
  `pgTable('orders', …)`, and past that point drizzle-kit emits DDL for one name twice and a single
  generated `DROP TABLE` takes the other plugin's data. It fails for BOTH plugins and in both tiers
  (neither is excused, and there is no tier to be excused by), because neither plugin is
  non-compliant on its own — the fault is the combination, and the host cannot run it either way.

**No tiers.** Every installed plugin is checked strictly. The two tiers keyed on a declared
`requires.pluginApi` are gone with it, because nothing left is a rule a RELEASED plugin cannot
retroactively satisfy: `uses` is a measurement of the plugin's own code, which anybody holding it
can re-derive with `pnpm plugin export`. `warn:` and `note:` survive for findings that are not
faults in a plugin at all — a plugin declaring no `minKit`, or a vendored one.

`pnpm plugin check --json` prints the same audit as data: `{ ok, plugins, failures, warnings,
notes }`. `failures` and `warnings` are separate lists so `ok` keeps meaning "this exits 0", and
each entry carries `file`, `line`, `problem`, `fix`, `kind` and `assert` as fields.

## Version clashes, at `add` time

`plugin add` compares every declared dependency against the range the host's `package.json` already
has, and against every other installed plugin's declared range. A difference is printed under
**Dependency clashes** and becomes a **human** step, because `pnpm add` would overwrite the
existing range without a word — and `package.json` is `manual` in `.rocketflare.json`, so no kit
upgrade ever reconciles it for anyone afterwards. It warns rather than refusing: a clash is very
often the intended change, and refusing would make an ordinary dependency upgrade impossible
without editing somebody else's manifest.

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
and `pnpm db:migrate` once. `pnpm bootstrap --no-plugins` skips the step. The kit's own list names
`analytics` — extracted into a plugin in 0.6.0 — at a PINNED ref. **`check` no longer compares the
installed version against that pin**: a released kit pins whichever plugin version was current when
it shipped, so the comparison failed every plugin release that had moved past it, by construction,
until a kit shipped pinning the new one — which cannot happen before the plugin is released. In the
kit itself the entry is ordinarily *declared and not installed*, which is exactly the state
`bash scripts/bootstrap.sh` resolves on a fresh clone.

## Two things nothing else will catch

- **Migrations are the host's, always.** Each `meta/NNNN_snapshot.json` carries the whole cumulative
  schema, so importing a foreign one teaches drizzle a current state that has never heard of this
  app's tables — and the *next* `pnpm db:generate` emits `DROP TABLE` for real data. Silent,
  delayed, destructive.
- **Expand and contract, never rename.** drizzle-kit's rename prompt has no non-interactive answer,
  so a plugin release that renames a column is a release nobody can apply unattended. Add, migrate,
  backfill, remove in a later version.
