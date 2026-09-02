---
name: setup
description: First run of this kit on this machine — checks the toolchain, starts Postgres, migrates, seeds demo data, and gets you signed in
argument-hint: "[--offline] [--no-demo]"
---

# First run

You are driving `scripts/bootstrap.sh` for someone who may never have run this kit. It does
SETUP.md Part 1 end to end and is **idempotent** — re-running after a fix is always safe.

## Constraints on you (Claude)

- You may reach this skill from a plain "help me set up this project" — the user need not
  have typed `/setup`. Before the first command, say in one sentence what the script will do
  to their machine (start a Postgres container, write `apps/web/.dev.vars`, seed a demo
  database) and that it is idempotent. Then run it; don't wait for permission you already have.
- Your Bash tool has **no TTY** and a **2-minute default timeout**. Always run the bootstrap with a
  10-minute timeout (`timeout: 600000`) — `pnpm install` alone can take minutes on a cold machine.
- Never start or stop the user's dev stack with raw `kill`/`docker` commands; the script and
  `pnpm dev:stop` / `pnpm dev:status` own that.
- Show the user the script's output as you go. Every step prints a `✔` line; the last line is the
  verification line. Do not summarise a failure away — quote it.

## 0. Is this a copy, or the kit itself?

The kit is a template, not an upstream (`docs/ADAPTING.md` §0). A copy that still carries the kit's
history will fight a repository that keeps evolving, so the first run is the moment to detach — but
detaching is **destructive and cannot be undone**, so never do it unasked.

```
git log --oneline | head -3 && git log --oneline | wc -l && git remote -v
```

Offer the detach ONLY when all of these hold, and say which one you saw:

- there is more than one commit, and the first commit is **not** `Start from Rocketflare`
  (`git log --reverse --oneline | head -1`) — the one-liner installer already detaches, so a copy
  made that way needs nothing;
- `origin` points at the kit's own repository.

Then **ask before running it** (`AskUserQuestion`), and say plainly what is lost: every commit,
irreversibly, replaced by one of their own. Two cases you must name in the question, because the
signature is identical for both:

- **They copied the kit** → detaching is right, and is what `docs/ADAPTING.md` §0 tells them to do.
- **This IS the kit** (they are working on Rocketflare itself, or a fork they intend to pull from)
  → say no. Deleting the history of the kit's own checkout is the one truly unrecoverable thing in
  this skill.

On yes, record the commit first so the copy remembers where it came from — that id is the only way
to diff against the kit later:

```
KIT_COMMIT=$(git rev-parse --short HEAD)
rm -rf .git && git init -q && git add -A
git commit -q -m "Start from Rocketflare" -m "Kit commit: $KIT_COMMIT"
```

Then tell them to add their own `origin`. On no, or on any doubt, carry on to step 1 unchanged —
setup works either way, and they can detach later by hand.

## 1. Run it

```
bash scripts/bootstrap.sh --no-dev $ARGUMENTS
```

`--no-dev` means the script does NOT start the servers (you will, in step 3). `--offline` skips
the Cloudflare login / Workers AI probe; `--no-demo` runs plain `pnpm seed` (tenant, users and key, but no populated workspace).

## 2. Read the exit code

| Exit | Meaning | What you do |
|---|---|---|
| 0 | every step passed | go to step 3 |
| 1 | a step failed | show the tail of the output, fix the cause, re-run the same command (idempotent) |
| 2 | usage error | check `$ARGUMENTS` against the hint above and re-run |
| 3 | a prerequisite is missing | install it, then re-run: Node 24 via `nvm install` (reads `.nvmrc`) or `fnm use`; pnpm via `corepack enable`; Docker via Docker Desktop, or `brew install colima docker && colima start` on macOS, or Docker Engine + the `docker` group on Linux |
| 4 | a dev port is held by another checkout | the DATABASE port is chosen automatically (`scripts/dev-db.mjs` takes the next free one), so this is :3000/:3001: run `pnpm dev:status` and `pnpm dev:db:status`, show the user the other path/pid, and let THEM decide — never kill another checkout's processes |
| 5 | Cloudflare login required | see below |

**Exit 5 — Cloudflare login.** Explain in one sentence: *the kit's zero-key chat and agents run on
Workers AI, which `wrangler dev` proxies through a logged-in Cloudflare account (a free one is
enough), and every call is billed to that account (10 000 free neurons a day).* Then ask: log in,
or stay offline?

- Log in: tell the user to run `pnpm web exec wrangler login` **in their own terminal** (the
  browser OAuth callback must outlive a tool call, so you cannot run it), wait for them to confirm,
  then re-run the bootstrap with `--online`.
- Stay offline: re-run with `--offline`. Chat/agents answer 503 until a key or tenant provider
  exists (SETUP.md 2.5); everything else works.

## 3. After success — start the app and sign in

1. Start the dev stack in the background (`run_in_background: true`):
   ```
   pnpm dev
   ```
2. Poll until the API answers, at most 90 seconds:
   ```
   curl -s localhost:3001/api/health
   ```
   You should see `{"status":"ok",…}`. If nothing after 90 s, run `pnpm dev:status` and show it.
3. Open the dev sign-in for the demo owner (macOS `open`, Linux `xdg-open`):
   ```
   open "http://localhost:3000/login?as=owner@example.test"
   ```
4. Report what is true now, in **at most six lines** — where the app is (the two URLs), who they
   are signed in as (**owner@example.test**; also `admin@` and `member@example.test`, and the
   global admin `admin@rocketflare.local`), the port Postgres landed on if it was not 5432, and
   any note the script printed (an orphaned volume, `--offline`). Do not restate the nine ✔ lines
   they just watched, and **do not echo the seeded API key** — it was printed once by the seed and
   is in their scrollback; say that `pnpm cli login` mints another whenever they want one.

## 4. Then ask what they want to do next — do not guess

A first run ends with the person looking at a working app and no idea what the next move is, so
**end the turn with `AskUserQuestion`**, not with a paragraph of suggestions and not with an
open "want me to do anything else?". Offer these, in this order, with the first as the default:

| Option | What you do when it is chosen |
|---|---|
| **Show me around** | Walk the seeded app: **Chat** (streams a reply — Workers AI needs the `wrangler login`, else a key), **Agents** (`summarize-text`, watch the timeline fill), **Knowledge → Search** (the demo documents are indexed), **Analytics** (the seeded Organisation Overview). Drive it with them; one screen at a time |
| **Check it really works** | `pnpm test:db:up && pnpm test` (ephemeral Postgres on :5433), then the SETUP.md 1.6 analytics check `pnpm web db:refresh-facts && pnpm web db:check-facts` |
| **Make it mine** | `/adapt <slug>` — the rename (package scope, Worker, database, CLI, theme). Ask for the slug if they have not said one |
| **Deploy it** | `/provision` — **user-invoked only**: tell them to type it, and that it needs the three accounts (Cloudflare on Workers Paid, Neon, Resend) and `pnpm provision tokens` in their own terminal first |

Leave the dev stack running unless they ask you to stop it (`pnpm dev:stop`). If they pick
something not on the list, just do that — the list is a starting point, not a gate.

## What each ✔ line means

Lines read `✔ n/9 <name> <what it verified>` (a failure is `✖ n/9 <name> <message>` plus a
`fix:` hint). `bash scripts/bootstrap.sh` first prints its own `✔ os / git / docker / node / pnpm`
prerequisite lines, then hands over to `scripts/bootstrap.mjs` for the nine steps:

| Step | Name | What it proved |
|---|---|---|
| 1 | `toolchain` | Node 24, pnpm 10, Docker daemon and `docker compose` reachable |
| 2 | `install` | `pnpm install` done; `wrangler` resolves in `apps/web` |
| 3 | `secrets` | `apps/web/.dev.vars` exists with `DATABASE_URL`, `OAUTH_ENCRYPTION_KEY` (generated, git-ignored) |
| 4 | `database` | this checkout's Postgres container is up and healthy on the port it chose (5432 unless taken; the step says so and writes it to `.dev.vars`) |
| 5 | `migrate` | role → migrations → grants applied; the pgvector extension is installed |
| 6 | `seed` | demo tenant, owner/admin/member users, one API key (printed once), plus the populated demo workspace unless `--no-demo` |
| 7 | `cloudflare` | wrangler is logged in (Workers AI available) — or `--offline` was chosen |
| 8 | `cli` | `pnpm cli whoami` with the seeded key — deferred/skipped with `--no-dev` (needs the server) |
| 9 | `run` | `pnpm dev` started and `/api/health` answered — skipped with `--no-dev` (you do it in step 3) |

With `--no-dev` the script stops after step 7 and prints the three things to run next (`pnpm
dev`, the login URL, `pnpm cli login`). If a line reads `✖`, the exit code table above says what
to do. The script's own output is authoritative; when it and this table disagree, trust the script.
