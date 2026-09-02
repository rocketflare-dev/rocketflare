---
name: preflight
description: Diagnose a broken local dev environment (node, pnpm, .dev.vars, Postgres, wrangler login, ports) without changing anything
---

# Preflight — read-only diagnosis

Use this when `pnpm dev`, `pnpm db:migrate`, `pnpm test` or the app itself is misbehaving on a
laptop and nobody knows why. **This skill changes nothing.** It runs two read-only commands, maps
every failure line to its fix, and then *tells* the user what the fix does before anyone runs it.

## 1. Run the two checks

```
pnpm preflight
pnpm dev:status
```

`pnpm preflight` (= `node scripts/bootstrap.mjs --check`) runs four of the bootstrap's nine
steps read-only — `1/9 toolchain`, `3/9 secrets`, `4/9 database`, `7/9 cloudflare` — printing
`✔ n/9 <name> <what it verified>` or `✖ n/9 <name> <message>` plus a `fix:` hint, then the
`— pnpm dev:status —` block, and ends with `✔ preflight ok` or `✖ preflight: <failed names>`.
`pnpm dev:status` on its own prints this repo's running dev processes and whoever holds
:3000 / :3001 (another checkout is *reported*, never touched) — run it again if the first block
scrolled away.

Show both outputs to the user verbatim, then apply the table. The `✖` message and its `fix:`
hint are authoritative; the table below adds what each fix *does*.

## 2. Failure line → fix

| Failure line says | What is wrong | The fix (say what it does, then let the user choose) |
|---|---|---|
| node missing / not v24 | wrong Node | `nvm install` (reads `.nvmrc`) or `fnm use` — installs/activates Node 24 for this shell |
| pnpm missing / not 10.x | corepack is off | `corepack enable` — makes the `pnpm` version in root `package.json` `packageManager` available |
| docker daemon not reachable | Docker is not running | start Docker Desktop, or `colima start` (macOS), or `sudo systemctl start docker` (Linux) — starts the daemon; nothing in the repo changes |
| `apps/web/.dev.vars` missing | first run never completed | `cp apps/web/.dev.vars.example apps/web/.dev.vars`, then fill `OAUTH_ENCRYPTION_KEY` with `openssl rand -hex 32` (SETUP.md 1.3); or `/setup` which does this for you |
| `OAUTH_ENCRYPTION_KEY` empty or shorter than 32 chars | the one required secret is blank | as above — generate a 64-hex value; **never** reuse a value from another environment |
| dev Postgres not running / unhealthy | the container is stopped | `pnpm dev:db:up` — starts `docker-compose.dev.yml` on :5432 (data persists in the named volume) |
| database unreachable with the container up | `DATABASE_URL` in `.dev.vars` disagrees with the compose file | compare `DATABASE_URL` to `POSTGRES_DB/USER/PASSWORD` in `apps/web/docker-compose.dev.yml`; fix `.dev.vars` (a renamed kit is the usual cause — `docs/ADAPTING.md` §1) |
| migrations pending / `rocketflare_app` role missing | schema behind the code | `pnpm db:migrate` — role → migrations → grants, idempotent (SETUP.md 1.4) |
| wrangler not logged in | Workers AI (chat, agents, embeddings, document conversion) will not answer | `pnpm web exec wrangler login` in the user's own terminal (browser OAuth) — or accept it and run offline: chat/agents 503 until a key or tenant provider exists (SETUP.md 2.5) |
| port :3000 / :3001 held by this repo | a previous `pnpm dev` is still alive | `pnpm dev:stop` — kills only this checkout's dev tree, supervisor first, looping until quiet |
| port held by another path / pid | a different checkout or app | show the path from `pnpm dev:status`; the user stops it there — **never kill it from here** |
| container name already in use | a second copy of the kit on this machine uses the same `container_name` | rename one copy (`docs/ADAPTING.md` §1 row `rocketflare-dev-postgres`) or stop the other's container |
| test Postgres (:5433) down | only matters for `pnpm test` | `pnpm test:db:up` — starts the ephemeral test container |

## 3. Rules

- Read-only means read-only: do not run any fix from the table without first stating the row,
  the command, and what it changes, and getting a yes.
- Quote the failing line exactly; the user may search for it in SETUP.md.
- If every line is `✔` and the app still misbehaves, the problem is not the environment — look at
  the wrangler console (`pnpm dev` output) and `curl -s localhost:3001/api/health` next.
