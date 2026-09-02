---
name: adapt
description: Rename a fresh copy of the kit to your app (package scope, worker, database, CLI, themes, domain), then walk the rows that need a human
argument-hint: "<slug> [\"Display Name\"] [--domain example.com] [--colour #hex]"
---

# Adapt — rename the kit to your app

`docs/ADAPTING.md` §1 is a 20-row find/replace table. `scripts/rename.mjs` does the mechanical
rows in one pass and reports the six that need a person; `checklist.md` beside this file walks
those six. You drive both. Every step ends with what the user should see.

Arguments: `$ARGUMENTS` — the slug is required (`my-app`: lowercase, digits, hyphens); the display
name, `--domain` and `--colour` are optional. No slug → ask for one before doing anything.

## 1. Confirm this is a fresh copy on a clean tree

```
git status --short
git log --oneline | head -3
```

Expect: no output from `git status --short`, and a first commit like `Start from Rocketflare`
(`docs/ADAPTING.md` §0). If the tree is dirty, stop and ask the user to commit or stash — the
rename must be one reviewable diff. If the history is the kit's own (many commits, no "Start from"
line), say so: they are renaming the kit itself, not a copy. Proceed only if they confirm.

Also check for a running dev database: `docker ps --format '{{.Names}}' | grep -- -postgres`.
If the kit's container is up, tell the user to run `pnpm dev:db:down` **now** — after the rename
the compose file names a different container and this one can only be removed by hand
(the rename's row (b) explains why).

## 2. Dry run — show the table, ask before writing

```
node scripts/rename.mjs --dry-run $ARGUMENTS
```

Expect exit 0, a table of `file → replacements per token class` ending in a `TOTAL` row, then the
six careful rows (a)–(f) and a "nothing written" line. Show the user the header line (the derived
`slug · snake · UPPER · domain`), the TOTAL row, and the careful rows. Confirm the derived names
are what they want — the display name and domain in particular — then ask: **apply?**

Exit 2 is a usage problem (bad slug, missing value): show the message and fix the arguments.

## 3. Apply

```
node scripts/rename.mjs $ARGUMENTS
```

Use a 10-minute timeout: the script runs `pnpm install` (relinks `@<slug>/*`, rewrites the
lockfile) and `pnpm lint:fix` (the new name re-wraps some lines) at the end. Expect `wrote N
files.`, the install and biome output, then the verify line. If `pnpm install` fails (offline),
re-run with `--skip-install` and tell the user to run `pnpm install && pnpm lint:fix` later.

## 4. Walk the checklist

Open `checklist.md` (this directory) and go through rows (a)–(f) **one at a time**, in order.
For each: say what to check, run the "how to check" command, show the result, and either confirm
"nothing to do" or make the change the row describes — with the user's yes for anything that is a
design choice (colour, logo, domain). Rows (a), (c), (d) are usually already done by the script;
(b) is a database decision; (e) and (f) are the user's brand.

## 5. Verify

```
pnpm types && pnpm lint && pnpm typecheck && pnpm test
```

`pnpm test` needs the test database: `pnpm test:db:up` first. Expect every step green, including
`tests/config/wrangler-parity.test.ts` (staging suffixes) and `tests/ui/contrast.test.ts` (if the
colour changed). A failing `typecheck` almost always means an `@<old-scope>/shared` import the
pass could not see — `grep -rn "@rocketflare/" apps packages --include=*.ts --include=*.tsx`
should be empty.

Then `git diff --stat` and commit: `git commit -am "Rename to <slug>"`.

## 6. Hand back

Tell the user:

- `docs/ADAPTING.md` §1 still describes the rename in the kit's terms — update its status line to
  say the rename is done (date, slug), or delete the table.
- `docs/ADAPTING.md` §2 (delete the example agents, dashboard, prompts) is for **when they have
  real ones** — not now.

Then **end the turn with `AskUserQuestion`** rather than a paragraph — the same as `/setup` does.
The choices after a rename are: **run it** (`/setup`, or `SETUP.md` Part 1 by hand), **deploy it**
(`/provision` — they type it themselves), **walk the six careful rows** (`checklist.md` beside this
file), or **stop here**.
