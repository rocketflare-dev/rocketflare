---
name: rf-preflight
description: Diagnose a broken local dev environment (node, pnpm, .dev.vars, Postgres, wrangler login, ports) without changing anything
---

# Preflight — read-only diagnosis

Use this when `pnpm dev`, `pnpm db:migrate`, `pnpm test` or the app itself is misbehaving on a
laptop and nobody knows why. **This skill changes nothing.** It runs a handful of read-only commands, maps
every failure line to its fix, and then *tells* the user what the fix does before anyone runs it.

## 1. Run the three checks

```
pnpm preflight
pnpm dev:status
pnpm plugin list && pnpm plugin check
```

`pnpm preflight` (= `node scripts/bootstrap.mjs --check`) runs four of the bootstrap's ten
steps read-only — `1/10 toolchain`, `3/10 secrets`, `4/10 database`, `8/10 cloudflare` — printing
`✔ n/10 <name> <what it verified>` or `✖ n/10 <name> <message>` plus a `fix:` hint, then one
informational `· tracing …` line (D32 — the local `ai_spans` store is always on; the line says
where spans are EXPORTED, or `local only`, and never prints a key or header; it can never fail
preflight — `/rf-traces` explains the backends), then the `— pnpm dev:status —` block, and ends with `✔ preflight ok` or `✖ preflight: <failed names>`.
`pnpm dev:status` on its own prints this repo's running dev processes and whoever holds
:3000 / :3001 (another checkout is *reported*, never touched) — run it again if the first block
scrolled away.

`pnpm plugin list` names every installed plugin (`id  version  repo  installedAt`, and `(local)`
for one recorded in the git-ignored `.rocketflare.local.json` sidecar rather than in
`.rocketflare.json`); `pnpm plugin check` audits them and **exits 1 with one `✖` line per failure**.
Two things to know before you report it:

- **A failing `check` is a finding, not a crash.** Report it as its own row — quote the `✖` line,
  say what it means from the table below, and carry on with the rest of the diagnosis. A plugin
  whose tables were never generated does not stop `pnpm dev`; it makes one page 500.
- **Inside the kit itself** (`.rocketflare.json` has `app: null`) every plugin install is recorded
  in the **sidecar**, which is git-ignored on purpose: a plugin wired into a kit checkout is an
  authoring convenience, and committing it would push wiring for files a copy does not have into
  every copy made from that commit. So `(local)` there is correct, and a colleague not seeing that
  plugin is the design, not a broken install.

Show every output to the user verbatim, then apply the table. The `✖` message and its `fix:`
hint are authoritative; the table below adds what each fix *does*.

## 2. Failure line → fix

| Failure line says | What is wrong | The fix (say what it does, then let the user choose) |
|---|---|---|
| node missing / not v24 | wrong Node | `nvm install` (reads `.nvmrc`) or `fnm use` — installs/activates Node 24 for this shell |
| pnpm missing / not 10.x | corepack is off | `corepack enable` — makes the `pnpm` version in root `package.json` `packageManager` available |
| docker daemon not reachable | Docker is not running | start Docker Desktop, or `colima start` (macOS), or `sudo systemctl start docker` (Linux) — starts the daemon; nothing in the repo changes |
| `apps/web/.dev.vars` missing | first run never completed | `cp apps/web/.dev.vars.example apps/web/.dev.vars`, then fill `OAUTH_ENCRYPTION_KEY` with `openssl rand -hex 32` (SETUP.md 1.3); or `/rf-setup` which does this for you |
| `OAUTH_ENCRYPTION_KEY` empty or shorter than 32 chars | the one required secret is blank | as above — generate a 64-hex value; **never** reuse a value from another environment |
| dev Postgres not running / unhealthy | the container is stopped | `pnpm dev:db:up` — starts this checkout's container on the port in `DATABASE_URL`, or the next free one (data persists in the named volume); `pnpm dev:db:status` lists every dev database on the machine |
| database unreachable with the container up | `DATABASE_URL` in `.dev.vars` disagrees with the compose file | compare `DATABASE_URL` to `POSTGRES_DB/USER/PASSWORD` in `apps/web/docker-compose.dev.yml`; fix `.dev.vars` (a renamed kit is the usual cause — `docs/ADAPTING.md` §1) |
| migrations pending / `rocketflare_app` role missing | schema behind the code | `pnpm db:migrate` — role → migrations → grants, idempotent (SETUP.md 1.4) |
| wrangler not logged in | Workers AI (chat, agents, embeddings, document conversion) will not answer | `pnpm web exec wrangler login` in the user's own terminal (browser OAuth) — or accept it and run offline: chat/agents 503 until a key or tenant provider exists (SETUP.md 2.5) |
| port :3000 / :3001 held by this repo | a previous `pnpm dev` is still alive | `pnpm dev:stop` — kills only this checkout's dev tree, supervisor first, looping until quiet |
| port held by another path / pid | a different checkout or app | show the path from `pnpm dev:status`; the user stops it there — **never kill it from here** |
| container name already in use | a second copy of the kit on this machine uses the same `container_name` | rename one copy (`docs/ADAPTING.md` §1 row `rocketflare-dev-postgres`) or stop the other's container |
| test Postgres (:5433) down | only matters for `pnpm test` | `pnpm test:db:up` — starts the ephemeral test container |
| `plugin check`: `<id>: declares tables (…) and no migration names it` | the plugin is wired in but its schema was never generated | `pnpm db:generate --name plugin-<id>-<version>`, **read the SQL**, then `pnpm db:migrate` — writes the app's own migration at its own index; never copy one from a plugin repo |
| `plugin check`: `<id>: anchor … is missing` | the surface says installed, the tree says no — usually a directory deleted by hand | `pnpm plugin remove <id> --apply` to finish the uninstall properly, or restore the directory with `pnpm plugin add` (`/rf-plugin`) |
| `plugin check`: a barrel `has no line for it` / `names it, but … is not there` | the six barrels and the plugin's directories disagree | `/rf-plugin` — `pnpm plugin add`/`remove` writes those lines; never hand-edit a barrel to make the check pass |
| `plugin check`: `<id>: …*.rej — an upgrade left work behind` | a `pnpm plugin upgrade` rejected hunks (exit 4) | resolve each `.rej` by hand and delete it, then re-run `pnpm plugin upgrade <id> --apply` — the version stamp is deliberately withheld until it is clean |
| `plugin check`: `the surface says X, … says Y` | the recorded version and the installed manifest disagree | usually a half-finished upgrade — same fix as the row above |
| `plugin check`: a `requires` line | the kit or another plugin moved out from under it | `pnpm plugin upgrade <id>` for a newer release of it, or stay on the kit version it supports (`/rf-upgrade` explains exit 6) |

## 3. Rules

- Read-only means read-only: do not run any fix from the table without first stating the row,
  the command, and what it changes, and getting a yes.
- Quote the failing line exactly; the user may search for it in SETUP.md.
- If every line is `✔` and the app still misbehaves, the problem is not the environment — look at
  the wrangler console (`pnpm dev` output) and `curl -s localhost:3001/api/health` next.
- Never fix a plugin finding by editing `.rocketflare.json`, the sidecar or one of the five
  barrels. `pnpm plugin` writes those, and `check` comparing them to the tree is the whole point of
  it — hand-editing makes the check agree with a lie.
