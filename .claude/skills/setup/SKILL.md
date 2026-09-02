---
name: setup
description: First run of this kit on this machine — checks the toolchain, starts Postgres, migrates, seeds demo data, and gets you signed in
disable-model-invocation: true
argument-hint: "[--offline] [--no-demo]"
---

# First run

You are driving `scripts/bootstrap.sh` for someone who may never have run this kit. It does
SETUP.md Part 1 end to end and is **idempotent** — re-running after a fix is always safe.

## Constraints on you (Claude)

- Your Bash tool has **no TTY** and a **2-minute default timeout**. Always run the bootstrap with a
  10-minute timeout (`timeout: 600000`) — `pnpm install` alone can take minutes on a cold machine.
- Never start or stop the user's dev stack with raw `kill`/`docker` commands; the script and
  `pnpm dev:stop` / `pnpm dev:status` own that.
- Show the user the script's output as you go. Every step prints a `✔` line; the last line is the
  verification line. Do not summarise a failure away — quote it.

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
| 4 | another checkout holds a port or container | run `pnpm dev:status`, show the user the other path/pid it reports, and let THEM decide — never kill another checkout's processes |
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
4. Tell the user: they are signed in as **owner@example.test** (the demo tenant's owner; also
   `admin@` and `member@example.test`, and the global admin `admin@rocketflare.local`). Suggest
   what to try — **Chat** (streams a reply; needs Workers AI login or a key), **Agents**
   (run `summarize-text`, watch the timeline fill), **Knowledge** (paste or upload a document,
   then **Search** it), **Analytics** (the seeded Organisation Overview dashboard).
5. Offer the two follow-ups, do not run them unasked:
   - the test suite: `pnpm test:db:up && pnpm test` (ephemeral Postgres on :5433)
   - the SETUP.md 1.6 analytics check: `pnpm web db:refresh-facts && pnpm web db:check-facts`

## What each ✔ line means

Lines read `✔ n/9 <name> <what it verified>` (a failure is `✖ n/9 <name> <message>` plus a
`fix:` hint). `bash scripts/bootstrap.sh` first prints its own `✔ os / git / docker / node / pnpm`
prerequisite lines, then hands over to `scripts/bootstrap.mjs` for the nine steps:

| Step | Name | What it proved |
|---|---|---|
| 1 | `toolchain` | Node 24, pnpm 10, Docker daemon and `docker compose` reachable |
| 2 | `install` | `pnpm install` done; `wrangler` resolves in `apps/web` |
| 3 | `secrets` | `apps/web/.dev.vars` exists with `DATABASE_URL`, `OAUTH_ENCRYPTION_KEY` (generated, git-ignored) |
| 4 | `database` | the dev Postgres container is up and healthy on :5432 |
| 5 | `migrate` | role → migrations → grants applied; the pgvector extension is installed |
| 6 | `seed` | demo tenant, owner/admin/member users, one API key (printed once), plus the populated demo workspace unless `--no-demo` |
| 7 | `cloudflare` | wrangler is logged in (Workers AI available) — or `--offline` was chosen |
| 8 | `cli` | `pnpm cli whoami` with the seeded key — deferred/skipped with `--no-dev` (needs the server) |
| 9 | `run` | `pnpm dev` started and `/api/health` answered — skipped with `--no-dev` (you do it in step 3) |

With `--no-dev` the script stops after step 7 and prints the three things to run next (`pnpm
dev`, the login URL, `pnpm cli login`). If a line reads `✖`, the exit code table above says what
to do. The script's own output is authoritative; when it and this table disagree, trust the script.
