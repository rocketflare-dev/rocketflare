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
```

Expect a clean tree and a kit name, version and commit. A dirty tree: ask them to commit or stash —
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

## 6. Hand back

End the turn with `AskUserQuestion`, not a paragraph — the same as `/rf-adapt` does. The choices
after an upgrade are: **run it** (`pnpm dev`), **do the next release** if more are in range,
**review the diff** together, or **stop**.

## Rules

- **Never recreate a file under an absent surface.** Not by hand, not "for completeness", not
  because a test references it.
- **Never copy a kit migration**, and never touch `apps/web/migrations/meta/`.
- **Never write a resource id into a wrangler toml.** A new binding goes in with its
  `<PLACEHOLDER>`; `pnpm provision cloudflare <env>` fills it.
- **Never apply the kit's deletions** without asking — the adopter may have built on that file.
- **Never squash the releases into one commit.** The per-release commit is what makes the next
  upgrade legible.
- Do not edit `.rocketflare.json` by hand. The script writes it, last, only when the apply is clean.
- `rm -rf .upgrade` is always safe — it is a cache.
