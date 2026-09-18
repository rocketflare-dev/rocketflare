---
name: rf-upgrade
description: Port later Rocketflare kit releases into this app — fetches the kit, translates its diff into your names, skips everything belonging to parts you deleted, and walks the manual decisions. Use when someone asks to upgrade Rocketflare, pull in kit improvements, or check what is new in the kit.
argument-hint: "[--to <version>]"
---

# /rf-upgrade — bring the kit's later work into this app

This app was copied from the kit and detached, so there is no upstream to merge. What there is:
`.rocketflare.json` (where the copy came from, and which replaceable surfaces it still has) and
`docs/upgrades/X.Y.Z.md` (what each release did and how to port it). `pnpm kit:upgrade` turns those
into a translated, filtered patch. You apply it, resolve the rejects, and make the calls it
deliberately refuses to make.

**The rule that matters most:** a surface this app deleted is never recreated. The script drops
those files before you see them. If you find yourself typing out a file the plan called
`skipped-surface-absent`, stop — you are about to break someone's app.

## 1. Check the ground

```
git status --short && node -e "const m=require('./.rocketflare.json');console.log(m.kit.name,m.kit.version,m.kit.commit??'(no commit)')"
pnpm plugin list
```

Expect a clean tree, a kit name, version and commit, and either `No plugins installed.` or one line
per installed plugin. **Say which plugins are installed before you plan** — a plugin has its own
repository and its own release chain, the kit diff never touches a byte one owns, and each is a
separate `pnpm plugin upgrade` AFTER this (step 6). A dirty tree: ask them to commit or stash —
the upgrade should be one reviewable diff. **No `.rocketflare.json`:** this copy predates the
upgrade path. Find the commit it started from and stamp it, then continue:

```
git log --format=%B -1 $(git rev-list --max-parents=0 HEAD)   # look for a `Kit commit:` trailer
pnpm kit:upgrade --adopt <commit-or-tag>
```

No trailer either? Ask which kit version they copied and use that tag. Do not guess.

## 2. Plan

```
pnpm kit:upgrade $ARGUMENTS
```

Expect six `✔ n/6` lines and a report. Read `.upgrade/work/<version>/plan.md`. Then tell them, in
three or four lines: which versions they are crossing, what each release note says it did, how many
files apply cleanly, and what has been skipped **and why**. A large `skipped-locally-deleted` or
`skipped-surface-absent` count is the normal, healthy case for an app that followed
`docs/ADAPTING.md` §2 — say so rather than reporting it as a problem.

Two plugin things can appear here — one a class, one an annotation — and neither is a problem to
route around:

- **`skipped-plugin-owned`** (a class) — files an installed plugin owns. The script drops them because the
  plugin's own repository is what moves them, so the count is health, exactly like the other skips.
  The report names the plugins and says to run `pnpm plugin upgrade <id>` after this.
- **`touches-plugin-registry`** (an annotation on an otherwise ordinary `modified` file, listed as
  `<path> — <plugin ids>`) — the kit changed a file an installed plugin also writes a line into. The six barrels are shared, so the kit CAN move ground under a plugin. **Apply the kit
  change, then check the plugin's line survived it** (`pnpm plugin check` is the fastest proof).

And one hard stop: **exit 6 — an installed plugin does not support the target kit version.** Its
`requires.kit` range excludes it, and nothing is written. (A **vendored** plugin — `source.repo` is
this kit's own repository — is exempt: the same release cut both, so its range describes the kit it
shipped inside rather than a compatibility claim.) Do not reach for `--force` first. Put the
three honest answers to the user and let them choose:

1. **stay** on this kit version until the plugin ships a release that supports the next one;
2. **`pnpm plugin remove <id>`** first — it takes that plugin's tables with it, so `--archive` is
   the conversation to have before, not after;
3. **`pnpm kit:upgrade --force`** with eyes open — the plugin is then running against a kit its
   author never tested it on, and whatever breaks is yours to fix.

If more than one release is in range, ask whether to go all the way or stop at one. Going one
release at a time, committing each, is easier to review and easier to abandon.

## 3. Apply, one release at a time

```
pnpm kit:upgrade --to <version> --apply
```

Exit 0 means everything landed. **Exit 4 means some hunks rejected** — that is work remaining, not
a failure, and the script deliberately does NOT stamp the new version until it is finished. For each
`*.rej` beside a file: read the reject, read the file, apply the intent by hand, delete the `.rej`.
A reject means the adopter's copy has diverged there; their version usually wins on anything they
changed on purpose.

Then the manual rows the report lists. `porting.md` beside this file has the per-area detail:
migrations, the wrangler tomls, `.dev.vars.example`, `package.json`, registries. **Read it before
touching any of them** — each has a way to get it wrong that is silent.

## 4. Migrations, if the report named any

Never copy the kit's SQL. The schema change is already in the patch:

```
pnpm db:generate          # writes YOUR migration, at YOUR index
pnpm db:migrate
```

Then diff your generated file against `.upgrade/work/<version>/reference/apps/web/migrations/` and
hand-port anything drizzle cannot derive from schema: data backfills, `CREATE EXTENSION`, triggers,
`ALTER … USING`. The reason is in `porting.md` and it is the sharpest trap here.

## 5. The gate

```
pnpm install && pnpm types && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Expect exit 0. Then commit — one commit per kit release, message `Upgrade to kit <version>`, so the
next upgrade can be read against it.

## 6. Then upgrade each plugin — separately, and after the kit

A plugin is not part of this diff and never was. Once the kit's release is committed and green,
hand off to **`/rf-plugin`** (or do it directly) once per installed plugin:

```
pnpm plugin upgrade <id>            # the plan — read it, as with the kit
pnpm plugin upgrade <id> --apply
```

Three things carry over from this skill unchanged: **exit 4 means rejects remain**, and the script
deliberately withholds the new version stamp until they are resolved; **a migration is never
copied** — `pnpm db:generate --name plugin-<id>-<version>` writes yours; and **a vendored plugin**
(one whose `source.repo` is the kit's own repository) answers *"upgrade it with `pnpm kit:upgrade`"*
and does nothing, because the kit release you just applied is what moved it. Two things that are
new: the plugin's `requires` is **refreshed** from the manifest at the version being installed
rather than frozen at first install (and checked BEFORE the patch applies), and any `coreEdits` it
declares are **re-applied**, with edits the new release no longer declares reverted.

Finish with `pnpm plugin check`, and **read its `warn:` lines rather than only its exit code**. A
plugin that declares no `requires.pluginApi` — which is every plugin released before that field
existed — is warned rather than failed on the newer rules, so a clean exit on one of those says
less than it looks. `requires.pluginApi` is the version of the plugin CONTRACT
(`docs/plugin-api.md`), a whole number, and is a different question from `requires.kit`: a kit
release may move the kit without moving the surface a plugin compiles against, which is exactly why
the two are not one field. If a kit upgrade raised `PLUGIN_API.current`, the plugins that declare
the old number still install — only a rise in `minSupported` stops them, and the release note says
so when that happens.

## 7. Hand back

End the turn with `AskUserQuestion`, not a paragraph — the same as `/rf-adapt` does. The choices
after an upgrade are: **run it** (`pnpm dev`), **upgrade the plugins** (step 6, via `/rf-plugin`),
**do the next release** if more are in range, **review the diff** together, or **stop**.

## Rules

- **Never recreate a file under an absent surface.** Not by hand, not "for completeness", not
  because a test references it.
- **Never copy a kit migration**, and never touch `apps/web/migrations/meta/`.
- **Never write a resource id into a wrangler toml.** A new binding goes in with its
  `<PLACEHOLDER>`; `pnpm provision cloudflare <env>` fills it.
- **Never apply the kit's deletions** without asking — the adopter may have built on that file.
- **Never hand-write a file a plugin owns**, and never resolve a `touches-plugin-registry` row by
  deleting the plugin's barrel line. `pnpm plugin` owns those six files.
- **Never `--force` past exit 6 without the user saying so**, in those words. It runs a plugin
  against a kit version its author never tested it on.
- **Never squash the releases into one commit.** The per-release commit is what makes the next
  upgrade legible.
- Do not edit `.rocketflare.json` by hand. The script writes it, last, only when the apply is clean.
- `rm -rf .upgrade` is always safe — it is a cache.
