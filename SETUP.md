# SETUP — step-by-step walkthrough

Everything needed to take this kit from a fresh copy to a configured, deployed app. Work through
the parts in order; **every step ends with a verification line — do not move on until it passes.**

**This file is instructions, not design.** What the kit does and why is in
[`docs/CONCEPTS.md`](docs/CONCEPTS.md); the Cloudflare topology is in [`docs/DEPLOY.md`](docs/DEPLOY.md);
code conventions are in `.claude/rules/`. If this is a freshly copied kit, do
[`docs/ADAPTING.md`](docs/ADAPTING.md) §1 (renames) before Part 1.

Legend: `[ready]` works out of the box · `[config]` needs your configuration

**Fix missing prerequisites proactively rather than reporting them.** If Node is missing or too
old, install 24 (`nvm install` reads `.nvmrc`, or `fnm use`, or the system package manager). If
pnpm is missing, `corepack enable` (it reads `packageManager` from `package.json`). If Docker is
unavailable on macOS, `brew install colima docker && colima start`; on Linux install Docker Engine
and add your user to the `docker` group. Confirm the tool works, then carry on.

---

## Part 1 — First run (local) `[ready]`

### 1.1 Toolchain
```bash
node -v            # v24.x — from .nvmrc
corepack enable && pnpm -v   # 10.x — from package.json packageManager
docker info >/dev/null && echo docker-ok
```
Verify: three lines — `v24.*`, `10.*`, `docker-ok`.

### 1.2 Dependencies
```bash
pnpm install
```
Verify: exits 0; `ls node_modules/.bin/wrangler` exists. (`wrangler` is a devDependency — always run
it as `pnpm exec wrangler`.)

### 1.3 Local secrets
```bash
cp .dev.vars.example .dev.vars
openssl rand -hex 32   # → OAUTH_ENCRYPTION_KEY in .dev.vars
openssl rand -hex 32   # → AUTH_SIGNING_KEY in .dev.vars (a different value)
```
Verify: `grep -c '^[A-Z_]*=.\+' .dev.vars` is at least 3 (`DATABASE_URL`, `OAUTH_ENCRYPTION_KEY`,
`AUTH_SIGNING_KEY` are set). Leave every optional key blank for now — each feature degrades
gracefully (Part 2). `.dev.vars` is git-ignored; never paste other environments' credentials into
it, not even as comments.

### 1.4 Database
```bash
pnpm dev:db:up        # pgvector/pgvector:pg17 on :5432
pnpm db:check         # scripts/test-db-connection.ts
pnpm db:migrate       # db-roles --phase=role → migrations → db-roles --phase=grants
```
Verify: `db:check` prints the server version; `db:migrate` ends with the applied migration count and
no `role "gmgo_app" does not exist` error. Why three steps: a policy's `TO gmgo_app` needs the role
before migrations; the `REVOKE`s need the tables after. With `APP_DATABASE_URL` unset the role is
created `NOLOGIN` and RLS stays inert ([`docs/RLS.md`](docs/RLS.md)).

### 1.5 Seed (Phase 1 onward)
```bash
pnpm seed             # idempotent: demo tenant, owner/admin/member users, one API key
```
Verify: the output lists the seeded emails and prints the API key **once**. `pnpm db:studio` shows
the rows. (Phase 0 skeleton: this script does not exist yet — skip.)

### 1.6 Run it
```bash
pnpm dev              # wrangler dev :3001 + vite :3000
```
Verify: both processes report ready; `curl -s localhost:3001/api/health` returns `{"status":"ok",…}`;
http://localhost:3000 renders the shell. Sign in (Phase 1): enter the seeded owner email, copy the
magic-link URL from the **wrangler dev console** (no `RESEND_API_KEY` → links are logged, not sent),
open it, land on Home.

### 1.7 Tests
```bash
pnpm test:db:up       # ephemeral Postgres on :5433 (max_connections=300)
pnpm test             # api + api-isolated (real DB), ui (jsdom), config (no DB)
```
Verify: all projects green. `tests/config/wrangler-parity.test.ts` passes with the placeholder ids
still in the tomls — the placeholder check only runs with `REQUIRE_PROVISIONED=1` (Part 3).

### 1.8 The gate
```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```
Verify: exits 0. This is the pre-commit gate; `typecheck` regenerates `worker-configuration.d.ts`
(commit it if it changed).

### 1.9 Public URL via tunnel `[ready]` (optional)
For OAuth callbacks, emailed magic links or webhooks against your laptop:
```bash
pnpm exec cfld setup  # once: picks a Cloudflare zone, stores .cfld.json (git-ignored)
pnpm dev:tunnel       # cfld → :3000; scripts/tunnel-dev.mjs passes the URL to wrangler as APP_URL
```
Verify: the printed `https://…` host opens the app; `/auth/methods` there reports the same providers
as localhost. `.dev.vars` and the tomls are untouched; plain `pnpm dev` still uses localhost. Add
the tunnel host to each OAuth app's redirect URIs (Part 2) to test those flows.

---

## Part 2 — External services `[config]`

None of these block local development. Each states what happens when it is absent.

### 2.1 Email — Resend
1. resend.com → verify your sending domain (SPF/DKIM)
2. Create an API key → `RESEND_API_KEY`
3. `EMAIL_FROM` in `[vars]` (both tomls) and `.dev.vars`: a verified sender, `App <noreply@mail.example.com>`

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

### 2.5 AI — Anthropic (Phase 3)
`ANTHROPIC_API_KEY` is the platform default; tenants may override in Settings → AI with their own
encrypted key. Absent: Settings → AI shows "not configured", chat and agents return 503
`ai_not_configured`. Verify: the connection test in Settings → AI passes. Embeddings default to the
`AI` Workers AI binding (no key); `EMBEDDINGS_API_KEY` only for OpenAI-compatible embeddings.

### 2.6 Tracing — Langfuse (Phase 3)
`LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` (+ `LANGFUSE_BASE_URL` in `[vars]` for self-hosted).
Presence of both keys is the switch. Absent: the tracer is a no-op. Verify: run the example agent, a
trace appears within a minute.

### 2.7 Rebrand checklist
See [`docs/ADAPTING.md`](docs/ADAPTING.md) §1 — names, DB names, themes, logo, `EMAIL_FROM`.

---

## Part 3 — Cloudflare deploy `[config]`

Two environments, two standalone tomls (`wrangler.staging.toml`, `wrangler.toml`), one Neon project
with a branch per environment, one GitHub Actions release flow. Reference: [`docs/DEPLOY.md`](docs/DEPLOY.md).

### 3.1 Accounts and access
1. Cloudflare account on **Workers Paid** (Hyperdrive, Workflows and `[limits]` need it) with a zone
   for your hosts. `pnpm exec wrangler login`.
   Verify: `pnpm exec wrangler whoami` prints the account.
2. CI API token (account scope): Workers Scripts, KV, Queues, Workflows, Durable Objects,
   Hyperdrive, R2 — edit; Workers AI, Account Analytics — read; Zone → DNS — edit on your zone.
   Verify: `CLOUDFLARE_API_TOKEN=… pnpm exec wrangler whoami` succeeds.
3. Neon: one project; branches `production` (main) and `staging`; **one role per branch**. Record
   the **direct** and `-pooler` connection strings for each. Hyperdrive gets the direct host;
   `scripts/migrate.ts` strips `-pooler` itself. Never put these strings in a file in this repo.
   Verify: `psql "<direct url>" -c 'select 1'` on both branches.

### 3.2 Provision Cloudflare resources
```bash
NEON_DATABASE_URL='<staging direct url>'    bash scripts/cf-provision.sh staging
NEON_DATABASE_URL='<production direct url>' bash scripts/cf-provision.sh production
```
Creates (or finds) the Hyperdrive config `<app>-<env>` and KV namespace `<APP>_RATE_LIMIT[_STAGING]`
and prints the ids plus a `sed` line per toml. Later phases add Queue (`<app>-jobs[-staging]`) and R2
(`<app>-files[-staging]`) — uncomment those blocks in the script and both tomls together. Workflows
and the DO need no create step, but the Workflow `name` is account-scoped: staging MUST be
`<app>-agent-run-staging`.
Verify: `REQUIRE_PROVISIONED=1 pnpm test:config` passes — no `<PLACEHOLDER>` left, every
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
deploys `wrangler.staging.toml`. Runtime 500s are expected until 3.5.
Verify: the run is green; `pnpm exec wrangler deployments list -c wrangler.staging.toml` shows it.

### 3.5 Worker secrets
For every non-`[vars]` name in `.dev.vars.example` (skip `DATABASE_URL` — deployed envs use
Hyperdrive — and `APP_DATABASE_URL` unless enabling RLS):
```bash
for k in OAUTH_ENCRYPTION_KEY AUTH_SIGNING_KEY RESEND_API_KEY BOOTSTRAP_ADMIN_EMAILS \
         GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET MICROSOFT_CLIENT_ID MICROSOFT_CLIENT_SECRET \
         ANTHROPIC_API_KEY LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY; do
  pnpm exec wrangler secret put "$k" -c wrangler.staging.toml     # prompts; use fresh values per env
done
```
Repeat without `-c` for production after its first deploy. Use different keys per environment.
Verify: `pnpm exec wrangler secret list -c wrangler.staging.toml` shows the names;
`curl https://<staging-host>/api/health` returns ok and `/auth/methods` lists your providers.

### 3.6 Custom domains
Uncomment `routes = [{ pattern = "<host>", custom_domain = true }]` in each toml (staging host in
the staging file). Wrangler creates the DNS record on the next deploy. Set `[vars] APP_URL` to
`https://<host>` in the same file. Update OAuth redirect URIs (Part 2).
Verify: the host serves the app over HTTPS; the parity test still passes (`routes` may differ).

### 3.7 The release dance (every subsequent deploy)
1. Bump `version` in `package.json` to `X.Y.Z`, commit.
2. `git tag X.Y.Z && git push origin X.Y.Z` → **staging** deploys (`deploy.yml`: CI gate → parity
   with `REQUIRE_PROVISIONED=1` → `db:migrate:ci` on the staging branch → `wrangler deploy -c
   wrangler.staging.toml --var RELEASE_VERSION:X.Y.Z`). The job fails if tag ≠ package.json version.
3. Check staging: `/api/health`, the version in the nav footer, the flow you changed.
4. `gh release create X.Y.Z --title X.Y.Z --generate-notes` → **production** deploys the release's
   tag with `wrangler.toml`. Publishing the Release is the promotion gate.
Verify: production `/auth/session` reports `releaseVersion: "X.Y.Z"`.

### 3.8 Rollback
- Fast: `pnpm exec wrangler rollback [-c wrangler.staging.toml]` — redeploys the previous Worker
  version (code + bindings; **not** the database).
- Deliberate: re-run Actions → Deploy → `production` from the previous tag, or publish a Release on
  the previous tag again. Migrations are forward-only; write a compensating migration if a schema
  change must be undone.
Verify: `/auth/session` shows the expected version; `pnpm exec wrangler tail` shows healthy requests.

### 3.9 What the parity test demands, in one place
`tests/config/wrangler-parity.test.ts` runs in `pnpm test` (placeholders allowed) and in
`deploy.yml` with `REQUIRE_PROVISIONED=1` (placeholders forbidden). It requires: identical binding
names and DO `class_name`s, `compatibility_date`/`flags`, `[limits]`, `[triggers].crons`, `[assets]`,
`[[migrations]]` and `[vars]` keys across both files; staging `name` = production `name` + `-staging`;
every Workflow `name`, queue `queue`, R2 `bucket_name` in staging ends in `-staging` and differs
from production; Hyperdrive/KV ids differ. When you add a binding, add it to both files, run
`pnpm types`, and commit `worker-configuration.d.ts`.
