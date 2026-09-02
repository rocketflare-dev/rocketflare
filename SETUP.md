# SETUP — step-by-step walkthrough

Everything needed to take this kit from a fresh copy to a configured, deployed app. Work through
the parts in order; **every step ends with a verification line — do not move on until it passes.**

**This file is instructions, not design.** What the kit does and why is in
[`docs/CONCEPTS.md`](docs/CONCEPTS.md); the Cloudflare topology is in [`docs/DEPLOY.md`](docs/DEPLOY.md);
code conventions are in `.claude/rules/`. If this is a freshly copied kit, do
[`docs/ADAPTING.md`](docs/ADAPTING.md) §1 (renames) before Part 1.

**Where commands run.** The repo is a pnpm workspace (`apps/web`, `apps/cli`, `packages/shared`).
**Every command below runs from the repository root** unless it says otherwise: the root
`package.json` delegates to the packages (`pnpm dev` → web, `pnpm cli …` → the CLI via `tsx`,
`pnpm web <script>` → any `apps/web` script). `wrangler` and `cfld` are devDependencies of
`apps/web`, so they are run as `pnpm web exec wrangler …` (shorthand for
`pnpm --filter @rocketflare/web exec wrangler …`) — `pnpm exec wrangler` at the root does not exist.

Legend: `[ready]` works out of the box · `[config]` needs your configuration

**Fix missing prerequisites proactively rather than reporting them.** If Node is missing or too
old, install 24 (`nvm install` reads `.nvmrc`, or `fnm use`, or the system package manager). If
pnpm is missing, `corepack enable` (it reads `packageManager` from the root `package.json`). If
Docker is unavailable on macOS, `brew install colima docker && colima start`; on Linux install Docker
Engine and add your user to the `docker` group. Confirm the tool works, then carry on.

---

## Part 1 — First run (local) `[ready]`

> **The short way.** `bash scripts/bootstrap.sh` (or `/setup` in Claude Code; `pnpm bootstrap` once
> Node and pnpm exist) does 1.1–1.7 in one go — nine steps, one `✔ n/9 <name> <what it verified>`
> line each, a `✖` line plus a `fix:` hint on the first failure — and ends with the browser open at
> `http://localhost:3000/login?as=owner@example.test`. macOS or Linux (Windows: WSL2). Re-runnable on
> a half-done machine: it inspects before it acts and never overwrites a value you wrote. Flags:
> `--offline` (no Cloudflare account: comments the `[ai]` block out of both tomls), `--online`
> (restore it), `--no-demo` (plain `pnpm seed`), `--no-dev` (stop after step 7 and print what to run
> next), `--share-db` (accept a Postgres container started from another checkout), `--no-open`,
> `--as <email>`, `--yes`, `--verbose`; `--check` is `pnpm preflight`.
> Exit codes: `0` ok · `1` a step failed · `2` usage · `3` prerequisite missing · `4` port/container
> held by (or a database shared with) another checkout · `5` Cloudflare login required
> (`node scripts/bootstrap.mjs --help`).
> The numbered steps below are what it runs — for doing it by hand, or for debugging one step.

### 1.1 Toolchain
```bash
node -v            # v24.x — from .nvmrc
corepack enable && pnpm -v   # 10.x — from package.json packageManager
docker info >/dev/null && echo docker-ok
```
Verify: three lines — `v24.*`, `10.*`, `docker-ok`. `pnpm preflight` is the same check as one
read-only command (toolchain, `.dev.vars`, Postgres, Cloudflare login, `pnpm dev:status`; exit 3
when anything is missing) — `bash scripts/bootstrap.sh` installs Node through an fnm/nvm that is
already present and pnpm through corepack, and never pipes a URL into a shell.

### 1.2 Dependencies
```bash
pnpm install
```
Verify: exits 0; `ls apps/web/node_modules/.bin/wrangler` exists and `pnpm web exec wrangler --version`
prints a version. `packages/shared` is linked into both apps as TypeScript source — there is nothing
to build for it. (`ls node_modules/.bin` at the root shows only `biome`, `tsc`, `tsx`: that is
expected.)

### 1.3 Local secrets
```bash
cp apps/web/.dev.vars.example apps/web/.dev.vars
openssl rand -hex 32   # → OAUTH_ENCRYPTION_KEY in apps/web/.dev.vars
```
The only secret `.dev.vars` needs is `OAUTH_ENCRYPTION_KEY` (≥ 32 characters); the bootstrap
generates it (`3/9 secrets`), by hand it is the `openssl` line above.
Verify: `grep -c '^[A-Z_]*=.\+' apps/web/.dev.vars` is at least 2 (`DATABASE_URL` and
`OAUTH_ENCRYPTION_KEY` are set). Leave every optional key blank for now — each
feature degrades gracefully (Part 2). `.dev.vars` is git-ignored; never paste other environments'
credentials into it, not even as comments.

### 1.4 Database
```bash
pnpm dev:db:up        # pgvector/pgvector:pg17 on :5432 (apps/web/docker-compose.dev.yml)
pnpm web db:check     # apps/web/scripts/test-db-connection.ts
pnpm db:migrate       # db-roles --phase=role → migrations → db-roles --phase=grants
```
Verify: `db:check` prints the server version; `db:migrate` ends with the applied migration count and
no `role "rocketflare_app" does not exist` error. Docker Compose names the project after the directory
(`web`), so a SECOND checkout of the kit does not collide on the pinned `container_name` — it quietly
attaches to the first one's database; `pnpm bootstrap` reads the container's compose label and stops
(exit 4, or asks on a terminal) unless you pass `--share-db`. Why three steps: a policy's `TO rocketflare_app` needs the role
before migrations; the `REVOKE`s need the tables after. With `APP_DATABASE_URL` unset the role is
created `NOLOGIN` and RLS stays inert ([`docs/RLS.md`](docs/RLS.md)).

### 1.5 Seed
```bash
pnpm seed             # idempotent: demo tenant, owner/admin/member users, one API key
pnpm seed --demo      # the same, plus a populated workspace (what the bootstrap runs; or SEED_DEMO=1)
```
`pnpm seed` creates the tenant `Acme` (`acme`), `owner@` / `admin@` / `member@example.test`, a
pending invitation for `invited@example.test`, the global admin `admin@rocketflare.local` and one API
key. `--demo` additionally fills that workspace with a logistics company in use (the tenant is
renamed `Acme Logistics` in `multi` mode) — more members, two
sibling tenants, two weeks of activity, conversations, an indexed knowledge base, finished agent
runs (`summarize-text`, `research-topic`), an AI usage ledger and rebuilt fact tables — so every
page has something to show. Every demo row has a fixed id and is inserted `onConflictDoNothing`, so
re-running adds nothing; the chunk vectors are deterministic stand-ins (`embeddingModel:
'seed:deterministic'`), so a seeded passage is found by the lexical half of the hybrid search, not
the dense half. Local database only — it is a `tsx` script over `DATABASE_URL`.
Verify: the output lists the seeded emails and prints the API key **once** (on the first run only;
later runs say it already exists); with `--demo` it ends with a "Workspace `acme` now holds" table.
`pnpm db:studio` shows the rows.

### 1.6 Run it
```bash
pnpm dev              # apps/web: wrangler dev :3001 + vite :3000 (strict ports; a preflight
                      # clears this repo's leftovers and names any other port holder)
# pnpm dev:stop       # kill this repo's dev tree (parent first, loops until quiet)
# pnpm dev:status     # what is running here + who holds :3000/:3001
```

> **Cloudflare login and the AI binding.** `wrangler dev` runs everything locally EXCEPT the Workers AI
> binding (`[ai]` in `apps/web/wrangler.toml`), which always calls Cloudflare — so the first `pnpm dev`
> on a machine that has never run `pnpm web exec wrangler login` will ask you to log in (a free account
> is enough). To stay fully offline, comment out the `[ai]` block in BOTH tomls (the parity test keeps
> them in sync): `pnpm bootstrap --offline` does exactly that, and `pnpm bootstrap --online` restores
> it. Chat then needs a key or a tenant provider (§2.5) and embeddings resolve to `EMBEDDINGS_API_KEY`
> or report "not configured". After toggling, `pnpm typecheck` regenerates
> `apps/web/worker-configuration.d.ts` without `AI` — restore the block (`--online`) before
> committing so CI's typegen diff stays clean.

Verify: both processes report ready; `curl -s localhost:3001/api/health` returns `{"status":"ok",…}`;
http://localhost:3000 renders the shell. Sign in: enter the seeded owner email, copy the magic-link
URL from the **wrangler dev console** (no `RESEND_API_KEY` → links are logged, not sent), open it,
land on Home. Shortcut (dev only): `http://localhost:3000/login?as=owner@example.test` signs in
through `/auth/dev-login` on load — honoured only when the server reports `devLogin`
(`APP_ENV=development`) and for the four seeded accounts, so an arbitrary address does nothing.

**Analytics check** (D19, still in 1.6 — same terminal pair):
```bash
pnpm web db:refresh-facts && pnpm web db:check-facts   # rebuild the fact table, then read its freshness
```
Verify: `db:refresh-facts` prints `tenant_activity_daily_facts  tenants=1 rows=…` with no `FAILED`
line and `db:check-facts` prints that table as `fresh` and exits 0 (it exits 1 when a table is
`STALE` — lag > 2× its hourly interval; `wrangler dev` never fires the `15 * * * *` cron by itself,
so a laptop database goes stale two hours after its last rebuild until you run this or
`curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=15+*+*+*+*"`). Then, signed in, open
**Analytics** in the nav: the seeded **Organisation Overview** page renders with live member and
activity numbers (the analytics UI is landing — see `apps/web/src/ui/CLAUDE.md`; by hand,
`curl -b <cookie> localhost:3001/api/analytics/pages` lists one page with `templateKey:
"tenant-overview"`, and an unauthenticated `curl -i localhost:3001/cubejs-api/v1/meta` is a JSON 401,
never HTML). `GET /api/analytics/facts/status` (owner/admin) shows the same freshness as the script.

> **Cookie note.** The session cookie is `__Host-session`, and the `__Host-` prefix *requires* the
> `Secure` flag even in development. Chrome and Firefox treat `http://localhost` as a secure context so
> this just works; Safari has historically been flaky about it. If Safari won't stay signed in locally,
> use the HTTPS tunnel (`pnpm dev:tunnel`, §1.10) or another browser.

### 1.7 CLI first run
The bootstrap already did this once: its `8/9 cli` step ran `pnpm cli whoami` with the seed's
one-time key (first run only — a re-run finds the key exists and skips; not with `--no-dev`, which
`/setup` uses — run `pnpm cli login` yourself then). To use the CLI yourself, with `pnpm dev` still
running, in a second terminal:
```bash
pnpm cli login --server http://localhost:3001   # opens the browser; sign in, pick the tenant
pnpm cli whoami
```

> **Headless / no browser** (CI, agents): skip `pnpm cli login`. Sign in with the dev-login cookie
> (or any session) and hit `GET /auth/cli?redirect_uri=http://127.0.0.1:8765/callback` — the
> `Location` header carries `key=`; export it as `ROCKETFLARE_API_KEY` with `ROCKETFLARE_URL=http://localhost:3001`,
> then `pnpm cli whoami`. In real environments create a tenant API key in Settings → API keys instead.

`login` starts a loopback listener on the first free port in `127.0.0.1:8765–8770` and opens
`/auth/cli?redirect_uri=http://127.0.0.1:<port>/callback`; after login + tenant select the server
mints a tenant API key named `cli:<your hostname>` and redirects back. The key is stored in
`~/.rocketflare/config.json` (mode `0600`) and is never printed in full.
Verify: `whoami` prints your email, the tenant name and a key prefix; `pnpm cli members list --json |
head` prints JSON; `ls -l ~/.rocketflare/config.json` shows `-rw-------`; a wrong key exits `2`. For CI or
scripts, `ROCKETFLARE_API_KEY` + `ROCKETFLARE_URL` in the environment replace the config file (no browser).

### 1.8 Tests
```bash
pnpm test:db:up       # ephemeral Postgres on :5433 (max_connections=300; apps/web/docker-compose.test.yml)
pnpm test             # every package: web api + api-isolated (real DB), ui (jsdom), config (no DB); cli
```
Verify: all projects green — including `tests/api/cubes/cube-isolation.test.ts` (two tenants, every
cube, disjoint rows) and `tests/dashboards/all-templates.test.ts` (`config` project).
`apps/web/tests/config/wrangler-parity.test.ts` passes with the
placeholder ids still in the tomls — the placeholder check only runs with `REQUIRE_PROVISIONED=1`
(Part 3). Single web projects: `pnpm web test:api`, `pnpm web test:ui`, `pnpm web test:config`.

### 1.9 The gate
```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```
Verify: exits 0. This is the pre-commit gate for the whole workspace; `typecheck` regenerates
`apps/web/worker-configuration.d.ts` (commit it if it changed) and `build` produces
`apps/web/dist/{ui,api}` and `apps/cli/dist/cli.js`. Expect `dist/api/worker.js` at ≈ 1265 KiB gzip
(≈ 5.6 MB raw) — drizzle-cube's adapter carries its MCP transport; `docs/DEPLOY.md` "Bundle size" —
and one `@duckdb/node-api` peer warning from `pnpm install`; neither is a problem.

### 1.10 Public URL via tunnel `[ready]` (optional)
For OAuth callbacks, emailed magic links or webhooks against your laptop:
```bash
pnpm web exec cfld setup   # once: picks a Cloudflare zone, stores apps/web/.cfld.json (git-ignored)
pnpm dev:tunnel            # cfld → :3000; apps/web/scripts/tunnel-dev.mjs passes the URL to wrangler as APP_URL
```
Verify: the printed `https://…` host opens the app; `/auth/methods` there reports the same providers
as localhost. `.dev.vars` and the tomls are untouched; plain `pnpm dev` still uses localhost. Add
the tunnel host to each OAuth app's redirect URIs (Part 2) to test those flows. The CLI can log in
through the tunnel too: `pnpm cli login --server https://<tunnel-host>`.

---

## Part 2 — External services `[config]`

None of these block local development. Each states what happens when it is absent. Secrets go in
`apps/web/.dev.vars` locally and `wrangler secret put` when deployed (Part 3); `[vars]` live in
`apps/web/wrangler.toml` and `apps/web/wrangler.staging.toml`.

### 2.1 Email — Resend
1. resend.com → verify your sending domain (SPF/DKIM)
2. Create an API key → `RESEND_API_KEY`
3. `EMAIL_FROM` in `[vars]` (both tomls) and `apps/web/.dev.vars`: a verified sender,
   `App <noreply@mail.example.com>`

Scripted (Part 3): with a full-access `RESEND_API_KEY`, `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` in `apps/web/.provision.env` (or exported), `pnpm provision email create --domain mail.example.com` creates the
Resend domain, writes its DNS records into the Cloudflare zone and sets `EMAIL_FROM` in both tomls;
`pnpm provision email verify <env>` polls verification and mints a per-environment sending key into
the Worker's `RESEND_API_KEY`; `email status` shows which records are present.

Absent: magic links, invitations and admin notifications are logged, never sent. Verify: request a
magic link — it arrives by email.

### 2.2 Google OAuth
1. Google Cloud Console → APIs & Services → OAuth consent screen: External; scopes `openid`,
   `email`, `profile` only. While the screen is in *Testing* only listed test users can sign in —
   **Publish** it to let anyone reach the sign-up gate
2. Credentials → OAuth client ID → Web application. Authorized redirect URIs — Google matches
   exactly, add every origin you use:
   `http://localhost:3000/auth/google/callback`, `https://<tunnel-host>/auth/google/callback`,
   `https://<staging-host>/auth/google/callback`, `https://<app-host>/auth/google/callback`
3. `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`

Absent: the button is hidden (`GET /auth/methods`). Verify: "Continue with Google" round-trips.
An account whose `email_verified` is false is refused — for every provider.

### 2.3 Microsoft OAuth (Entra ID)
1. Azure Portal → App registrations → New; account type "any organizational directory and
   personal accounts" (the kit uses the `common` tenant)
2. Redirect URI (Web): `{APP_URL}/auth/microsoft/callback` for each origin as in 2.2
3. Certificates & secrets → new client secret → `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET`

Absent: button hidden. Verify: round trip. Redirect URIs are always derived from `APP_URL`; there
is no `*_REDIRECT_URI` variable to set.

### 2.4 First admin
`BOOTSTRAP_ADMIN_EMAILS=you@example.com` (comma-separated). Promoted to global admin on the first
**verified** login, logged loudly. Absent: promote by hand once —
`UPDATE users SET is_global_admin = true WHERE email = '…'` — or every sign-up parks on `/pending`
with nobody to approve it (`SIGNUP_MODE=invite_only` default). Verify: `/admin` is reachable.

### 2.5 AI — chat, agents, embeddings
Resolution (`docs/CONCEPTS.md` §9): a per-agent assignment → the tenant's default provider in
Settings → AI → the platform `ANTHROPIC_API_KEY` → **Workers AI through the `AI` binding**. That last
tier means **chat and agents work on a fresh workspace with nothing configured**: Settings → AI shows
chat readiness `Cloudflare Workers AI · llama-3.3-70b-instruct-fp8-fast · platform default`. Read the
cost line before relying on it, then pick any of these:

0. **Zero-key default — Workers AI.** Nothing to do; `wrangler dev` proxies the binding to your
   logged-in Cloudflare account and a deployed Worker uses its own. **Every call is billed to that
   account** (10 000 free neurons a day on any plan, then metered — Llama 3.3 70B fp8-fast is about
   $0.29 / $2.25 per million input / output tokens); the `ai_usage` ledger counts the tokens. The
   floor is the 70B because the AGENTS run on it too and a smaller model handles a multi-turn tool
   loop badly; its context window is 24k, which is what the knowledge tools budget against. To make
   the kit zero-spend instead, comment the `[ai]` block out of BOTH tomls (the parity test keeps them
   in sync) — chat then answers 503 until a key or tenant provider exists. Any tenant can still add
   Workers AI explicitly as a chat provider (no key) to pick another model — cheaper and weaker,
   `@cf/mistralai/mistral-small-3.1-24b-instruct`, or anything else with function calling. Verify: `curl -b <cookie>
   localhost:3001/api/ai/config/readiness` → `"chat":{"ready":true,"source":"platform","provider":"workers_ai"…}`
   and `/chat` streams a reply.
1. **Platform key (optional).** `ANTHROPIC_API_KEY=` in `apps/web/.dev.vars` (deployed:
   `wrangler secret put`, Part 3). Every tenant without its own chat provider then uses it with
   `claude-sonnet-4-5` — it ranks above Workers AI. Verify: Settings → AI (as owner/admin) shows chat
   readiness `Anthropic · claude-sonnet-4-5 · platform default`; `curl -b <cookie>
   localhost:3001/api/ai/config/readiness` → `"chat":{…,"source":"platform","provider":"anthropic"…}`.
2. **Tenant provider (no platform key).** Settings → AI → *Add provider*: scope `chat`, a label (it is
   the upsert key — renaming later means delete + re-add), provider `anthropic` / `anthropic_compatible`
   (Fireworks, Moonshot presets; base URL required) / `openai` / `openai_compatible`, model, API key
   (encrypted with `OAUTH_ENCRYPTION_KEY`, never shown again — the row reports `hasCredential`). The
   first row in a scope becomes the default. Press **Test connection** before saving (a 10-token
   completion; 10 per minute per IP). Verify: the test reports `ok` and a latency; readiness reads
   `tenant`.
3. **Local mock — develop with no key at all.** Run any OpenAI-compatible server (Ollama, vLLM, a
   proxy) and add an `openai_compatible` chat config with its base URL **including `/v1`**
   (e.g. `http://localhost:11434/v1`), the model name it serves, and **any non-empty placeholder as
   the API key** (the adapter refuses an empty key; a local server ignores the bearer). Chat, the
   `summarize-text` agent and the usage table all work against it. Verify: `/chat` streams a reply.

Absent everywhere (no `[ai]` binding, no key, no tenant provider): `/chat` shows "configure AI";
`POST /api/chat/conversations` and the agent's `execute` step answer 503 `ai_not_configured` (the
agent enqueue itself still returns 202 and the run settles `failed`). Thinking is OFF unless a config
enables it with a budget (cost decision).

**Embeddings** (documents / hybrid search, `index: true` on the example agent): the `AI` Workers AI
binding (both tomls, and `wrangler dev` emulates it) is the zero-key default — `@cf/baai/bge-m3`,
1024-dim. Alternatives: an `embeddings`-scope tenant config (`openai`, `openai_compatible`,
`workers_ai`) or `EMBEDDINGS_API_KEY` for platform OpenAI `text-embedding-3-small` (reduced to 1024
dims). Verify: `POST /api/ai/documents/ingest` `{ "title": "t", "text": "hello world" }` → `status:
"indexed"`; `pnpm web db:check` reports the pgvector extension installed. Changing the dimension is a
new table (`docs/ADAPTING.md` §3).

**Document uploads** (Knowledge → Upload file): Markdown/text/CSV/JSON index straight away; PDF,
Word, Excel, OpenDocument, HTML and XML are converted by Workers AI Markdown Conversion on the same
`AI` binding (`wrangler dev` proxies it to Cloudflare, so `wrangler login` is needed; conversion of
documents is free) in the `document.convert` queue job. Verify: upload a small PDF on `/documents`,
watch the row go `Indexing → Indexed` within the 5 s poll (the wrangler terminal logs
`document.convert: indexed`), search a phrase from it, and click the download icon to get the
original back from R2. Without `[ai]` a binary upload answers 503 `conversion_not_configured`.

Agent runs need the `AGENT_RUN_WORKFLOW` binding (declared in both tomls; `wrangler dev` runs
instances locally). Without it `POST /api/agents/runs` is 503 `agent_runs_not_configured`. Verify
(from the Agents page in the nav, or by hand):
`POST /api/agents/runs` `{ "agentKey": "summarize-text", "input": { "text": "<a paragraph>" } }` →
202; `GET /api/agents/runs/<id>` reaches `succeeded` with `output.summary`.

### 2.6 Tracing — Langfuse
1. Langfuse (cloud or self-hosted) → project → API keys → `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY`
   in `apps/web/.dev.vars` (deployed: `wrangler secret put`)
2. Self-hosted only: `LANGFUSE_BASE_URL` — defaults to `https://cloud.langfuse.com` in
   `apps/web/src/config.ts`; to override, add it to `[vars]` in **both** tomls (the parity test requires
   identical `[vars]` keys) or to `.dev.vars`. `LANGFUSE_TRACING_ENVIRONMENT` (defaults to `APP_ENV`)
   tags the traces the same way

Presence of **both** keys is the switch (`tracerFor(cfg)`); with either missing the tracer is the
no-op and nothing changes in behaviour. Traces are batched per request and shipped from `waitUntil`
(fetch, basic auth) — never on the response path. Verify: send a chat message or run the example
agent; a trace named `chat` / `summarize-text` with one `generation` carrying token usage appears in
Langfuse within a minute, tagged with the environment.

### 2.7 Analytics tooling — drizzle-cube CLI / Claude Code plugin (optional)
`cp apps/web/.drizzle-cube.json.example apps/web/.drizzle-cube.json` (git-ignored) and set `apiToken`
to a tenant API key from Settings → API keys (`serverUrl` is your `wrangler dev` origin or a deployed
host). The key is an ordinary Bearer key: every query it makes is scoped to that tenant by the cubes
and it is revoked in the same place. Nothing to deploy; MCP for browser clients additionally needs
`mcp.allowedOrigins` in `routes/cube-api.ts`, which the kit leaves unset.
Verify: the drizzle-cube CLI's `meta` lists `ActivityEvents`, `TenantActivityDaily`, `TenantUsers`,
`Users`.

### 2.8 Rebrand checklist
See [`docs/ADAPTING.md`](docs/ADAPTING.md) §1 — package names (`@rocketflare/*`), worker names, DB names,
CLI bin / config dir / env prefix, themes, logo, `EMAIL_FROM`.

---

## Part 3 — Cloudflare deploy `[config]`

Two environments, two standalone tomls (`apps/web/wrangler.staging.toml`, `apps/web/wrangler.toml`),
one Neon project with a branch per environment, one GitHub Actions release flow. Only `apps/web` is
deployed; the CLI is built by CI but not published (publishing it is an app decision —
[`docs/DEPLOY.md`](docs/DEPLOY.md)). Reference: [`docs/DEPLOY.md`](docs/DEPLOY.md).

**Recommended: `/provision`** in Claude Code, or `pnpm provision all` by hand
(`apps/web/scripts/provision.ts`; `pnpm provision --help` lists every phase and flag). It is REST
over `fetch` plus `wrangler` and `gh` — no vendor CLIs — idempotent (find-or-create), and every
phase ends in one `Verify:` line. The four tokens go in `apps/web/.provision.env` (git-ignored,
mode 0600): run **`pnpm provision tokens`** in your own terminal — it shows where to mint each one,
prompts with hidden input, verifies each against its vendor and writes the file — or copy
`apps/web/.provision.env.example` and fill it in. An exported variable of the same name overrides
the file (that is how CI runs it); never paste a token into a chat, and never put these in
`.dev.vars` (`wrangler dev` would load them into the Worker, and its `RESEND_API_KEY` is the app's
sending key, not this full-access one):

| Variable | Mint at | Scope |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | https://dash.cloudflare.com/profile/api-tokens | Account: Workers Scripts, Workers KV Storage, Queues, Workflows, Durable Objects, Hyperdrive, R2 — Edit; Workers AI, Account Analytics — Read. Zone: DNS — Edit on the zone holding your hosts and the sending domain |
| `CLOUDFLARE_ACCOUNT_ID` | Workers & Pages → Overview (right-hand column / the URL) | the 32-hex account id |
| `NEON_API_KEY` | https://console.neon.tech/app/settings/api-keys | personal or organisation key; creates the project and branches |
| `RESEND_API_KEY` | https://resend.com/api-keys | Full access (creates the domain, mints a `sending_access` key per environment); or `--skip-email` |

Then `gh auth login` and `pnpm web exec wrangler login` in your own terminal (browser steps), and:

```bash
pnpm provision tokens [--skip-email]   # once, in your terminal: hidden prompts → apps/web/.provision.env (0600)
pnpm provision preflight --domain mail.example.com --staging-host workers.dev --production-host app.example.com --admin-email you@example.com
pnpm provision all [--deploy staging|both] [--skip-email] [--rotate]   # 10–20 minutes; stops at the first failed Verify
```

| Phase | Creates / does | Verify line |
|---|---|---|
| `tokens` | (a terminal, not an agent) prompts for the four tokens with hidden input, verifies each, writes `apps/web/.provision.env` (0600) | `tokens ok — set: CLOUDFLARE_API_TOKEN, … → apps/web/.provision.env (0600)` |
| `preflight` | checks tools, tokens (environment, then the file) and accounts; caches the four answers in `apps/web/.provision.json` (git-ignored, non-secret) | `preflight ok — app=… account=… neon=… resend=…` |
| `email create` | Resend domain, its DNS records in the Cloudflare zone, `EMAIL_FROM` in both tomls | `email create ok — domain=… zone=… records=… EMAIL_FROM="…"` |
| `neon` | Neon project (pg 17) + `staging` branch from the default branch, direct hosts, a password per branch | `neon ok — production=<host> staging=<host> (SELECT 1 on both)` |
| `cloudflare <env>` | `cf-provision.sh <env> --apply`: Hyperdrive, KV, Queue, R2; ids patched into the toml | `cloudflare <env> ok — <toml> patched; REQUIRE_PROVISIONED=1 parity test passed for both tomls` (once both are done) |
| `migrate <env>` | `pnpm db:migrate:ci` against that branch; applied count == journal entries | `migrate <env> ok — n/n migrations applied on <host>` |
| `github <env>` | GitHub Environment + `DATABASE_URL`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` secrets (stdin) | `github <env> ok — environment <env> on <repo> has …` |
| `urls` | `APP_URL` + `routes` (custom host) or the `workers.dev` host in both tomls; parity test | `urls ok — staging=… production=…; parity test passed` |
| `deploy <env>` | `pnpm deploy[:staging]`, then `/api/health` and `/api/ready` | `deploy <env> ok — <url>/api/health ok (version …), /api/ready ok, deployments listed` |
| `secrets <env>` | `OAUTH_ENCRYPTION_KEY` (generated) + every optional secret exported or in `apps/web/.provision.env`, over stdin | `secrets <env> ok — wrangler secret list shows n secret(s): …` |
| `email verify <env>` | Resend verification (polls ≤ 10 min), a per-environment sending key into `RESEND_API_KEY` | `email verify <env> ok — domain=… verified, RESEND_API_KEY set, …/auth/methods reports magic link` |
| `all` | every phase in order (`--deploy staging` by default), then a close-out checklist | `all ok — n phases passed; deployed …` |

Close-out: sign in with the admin's magic link — with `SIGNUP_MODE=invite_only` the first login lands
on `/pending`; as the global admin create the first organisation at `/admin` — add OAuth redirect
URIs, commit the two tomls (ids and URLs are not secrets), push, `pnpm cli login --server <APP_URL>`.
Known limits: `.claude/skills/provision/reference.md`. The manual sequence below is the reference for
what each phase does.

### 3.1 Accounts and access
1. Cloudflare account on **Workers Paid** (Hyperdrive, Workflows and `[limits]` need it — Hyperdrive's
   plan availability has changed over time; the Hyperdrive create step reports if the plan refuses
   it) with a zone for your hosts. `pnpm web exec wrangler login`.
   Verify: `pnpm web exec wrangler whoami` prints the account.
2. CI API token (account scope): Workers Scripts, KV, Queues, Workflows, Durable Objects,
   Hyperdrive, R2 — edit; Workers AI, Account Analytics — read; Zone → DNS — edit on your zone.
   Verify: `CLOUDFLARE_API_TOKEN=… pnpm web exec wrangler whoami` succeeds.
3. Neon: one project; branches `production` (main) and `staging` — create `staging` **before** the
   first migration, so each branch is migrated with its own password rather than inheriting a
   migrated main (the database's default owner role is kept on both). Record the **direct** and `-pooler` connection strings for each. Hyperdrive gets
   the direct host; `apps/web/scripts/migrate.ts` strips `-pooler` itself. Never put these strings in
   a file in this repo. Verify: `psql "<direct url>" -c 'select 1'` on both branches.

### 3.2 Provision Cloudflare resources
```bash
NEON_DATABASE_URL='<staging direct url>'    pnpm web provision:cloudflare staging --apply
NEON_DATABASE_URL='<production direct url>' pnpm web provision:cloudflare production --apply
```
`pnpm web provision:cloudflare` runs `apps/web/scripts/cf-provision.sh` with `apps/web` as its
working directory (the script also `cd`s there itself, so `bash apps/web/scripts/cf-provision.sh
staging --apply` from the root works too). It creates (or finds, by name) all four resources: the
Hyperdrive config `<app>-<env>`, the KV namespace `<APP>_RATE_LIMIT[_STAGING]`, the Queue
`<app>-jobs[-staging]` and the R2 bucket `<app>-files[-staging]` (the last two are name-referenced —
nothing to paste). `--apply` writes the Hyperdrive and KV ids into the toml through
`scripts/provision/patch-toml.ts` (byte-preserving; a DIFFERENT existing id is refused unless
`--force`); without it the script prints the ids and a `sed` line to run yourself. The Workflow
(`[[workflows]]` `AGENT_RUN_WORKFLOW`), the Workers AI binding (`[ai]`) and the DO need no create
step — `wrangler deploy` registers them — but the Workflow `name` is account-scoped: staging MUST be
`<app>-agent-run-staging` (`docs/DEPLOY.md`, "Account-scoped names").
Verify: `REQUIRE_PROVISIONED=1 pnpm web test:config` passes — no `<PLACEHOLDER>` left, every
account-scoped staging name ends in `-staging`, ids differ. Commit the tomls (ids are not secrets).

### 3.3 GitHub Environments and secrets
Repository → Settings → Environments → create `staging` and `production`. In **each**:

| Secret | Value |
|---|---|
| `DATABASE_URL` | that branch's Neon connection string (owner role; pooled or direct) |
| `CLOUDFLARE_API_TOKEN` | the token from 3.1 (may be shared) |
| `CLOUDFLARE_ACCOUNT_ID` | account id |

Verify: both environments list three secrets. Optionally add required reviewers to `production` if
your plan supports it; otherwise publishing the Release is the gate (3.6).

### 3.4 First deploy (the worker must exist before secrets can be set)
Actions → **Deploy** → Run workflow → environment `staging` (uses the ref you dispatch from). It
runs CI, the provisioned parity test, migrations against the staging branch, builds the UI and
deploys `wrangler.staging.toml` from inside `apps/web`. Runtime 500s are expected until 3.5.
Verify: the run is green; `pnpm web exec wrangler deployments list -c wrangler.staging.toml` shows it.

### 3.5 Worker secrets
For every non-`[vars]` name in `apps/web/.dev.vars.example` (skip `DATABASE_URL` — deployed envs use
Hyperdrive — and `APP_DATABASE_URL` unless enabling RLS):
```bash
# one per name: OAUTH_ENCRYPTION_KEY RESEND_API_KEY BOOTSTRAP_ADMIN_EMAILS GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
#   MICROSOFT_CLIENT_ID MICROSOFT_CLIENT_SECRET ANTHROPIC_API_KEY EMBEDDINGS_API_KEY LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY
printf '%s' "$OAUTH_ENCRYPTION_KEY" | pnpm web exec wrangler secret put OAUTH_ENCRYPTION_KEY -c wrangler.staging.toml
```
`wrangler secret put NAME` reads the value from stdin when stdin is not a terminal — pipe it with
`printf '%s' "$V"`, never `--body` or an argument, so the value stays out of argv and shell history
(interactively it prompts). `pnpm provision secrets <env>` does exactly this for every name exported
in the shell. Repeat without `-c` for production after its first deploy. Use different keys per
environment. `ANTHROPIC_API_KEY`, `EMBEDDINGS_API_KEY` and the two `LANGFUSE_*` keys are optional
(Part 2.5/2.6): skip them and the features degrade as described there.
Verify: `pnpm web exec wrangler secret list -c wrangler.staging.toml` shows the names;
`curl https://<staging-host>/api/health` returns ok, `curl https://<staging-host>/api/ready` returns
ok (it runs a query through Hyperdrive — a 503 there means Hyperdrive cannot reach Neon: wrong host
or SSL), and `/auth/methods` lists your providers. With `SIGNUP_MODE=invite_only` (the default) the
admin's first login lands on `/pending`; the first organisation is created at `/admin`.
Point the CLI at it: `pnpm cli login --server https://<staging-host>`.

### 3.6 Custom domains
Uncomment `routes = [{ pattern = "<host>", custom_domain = true }]` in each toml (staging host in
the staging file). Wrangler creates the DNS record on the next deploy. Set `[vars] APP_URL` to
`https://<host>` in the same file. Update OAuth redirect URIs (Part 2).
Verify: the host serves the app over HTTPS; the parity test still passes (`routes` may differ).

### 3.7 The release dance (every subsequent deploy)
1. Bump `version` in the **root** `package.json` to `X.Y.Z`, commit. (The `apps/*` versions are
   informational; one tag ships web and cli together.)
2. `git tag X.Y.Z && git push origin X.Y.Z` → **staging** deploys (`deploy.yml`: CI gate → parity
   with `REQUIRE_PROVISIONED=1` → `pnpm db:migrate:ci` on the staging branch →
   `pnpm --filter @rocketflare/web build:ui` → `pnpm --filter @rocketflare/web exec wrangler deploy -c
   wrangler.staging.toml --var RELEASE_VERSION:X.Y.Z`). The job fails if tag ≠ root version.
3. Check staging: `/api/health`, the version in the nav footer, the flow you changed.
4. `gh release create X.Y.Z --title X.Y.Z --generate-notes` → **production** deploys the release's
   tag with `wrangler.toml`. Publishing the Release is the promotion gate.
Verify: production `/auth/session` reports `releaseVersion: "X.Y.Z"`; `pnpm cli status` against it
prints the same version.

### 3.8 Rollback
- Fast: `pnpm web exec wrangler rollback [-c wrangler.staging.toml]` — redeploys the previous Worker
  version (code + bindings; **not** the database).
- Deliberate: re-run Actions → Deploy → `production` from the previous tag, or publish a Release on
  the previous tag again. Migrations are forward-only; write a compensating migration if a schema
  change must be undone.
Verify: `/auth/session` shows the expected version; `pnpm web exec wrangler tail` shows healthy requests.

### 3.9 What the parity test demands, in one place
`apps/web/tests/config/wrangler-parity.test.ts` runs in `pnpm test` (placeholders allowed) and in
`deploy.yml` with `REQUIRE_PROVISIONED=1` (placeholders forbidden). It reads both tomls relative to
`apps/web` (not the process cwd), so it behaves the same from the root and from the package. It
requires: identical binding names and DO `class_name`s, `compatibility_date`/`flags`, `[limits]`,
`[triggers].crons`, `[assets]`, `[[migrations]]` and `[vars]` keys across both files; staging `name`
= production `name` + `-staging`; every Workflow `name`, queue `queue`, R2 `bucket_name` in staging
ends in `-staging` and differs from production; Hyperdrive/KV ids differ. When you add a binding, add
it to both files, run `pnpm types`, and commit `apps/web/worker-configuration.d.ts`.
