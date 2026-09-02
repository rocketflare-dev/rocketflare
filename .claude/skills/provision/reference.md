# /provision — reference

Companion to `SKILL.md`. The implementation is `apps/web/scripts/provision.ts` with the vendor
clients in `apps/web/scripts/provision/{neon,resend,cloudflare-dns,secrets,patch-toml,redact,config}.ts`;
each client's header comment cites the API page every call was checked against (2026-09-02).

## Where the tokens live

`apps/web/.provision.env` — `KEY=VALUE` lines with `.dev.vars` conventions (`#` comments, blank
lines, `export KEY=` and quotes tolerated), git-ignored, mode 0600 (the script warns when it is
looser and carries on). `pnpm provision tokens` writes it (TTY only: hidden prompts, each token
verified against its vendor before it is saved, other keys and comments preserved); by hand, copy
`apps/web/.provision.env.example`. **Precedence: an exported variable of the same name wins over
the file** — CI exports, people use the file — and every value the script resolves is registered
with `redact()` so it cannot be echoed whatever its shape. `PROVISION_ENV_FILE=<path>` relocates
the file (tests, a one-off run). It is not `.dev.vars` because `wrangler dev` loads that file into
the Worker as secrets — account-level Cloudflare/Neon/Resend tokens must never reach a Worker —
and because `RESEND_API_KEY` there is the app's *sending* key (minted by `email verify`, set on the
Worker) while here it is the *full-access* account key.

## Token scopes

| Variable | Where to mint | Scope |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | https://dash.cloudflare.com/profile/api-tokens | Account: Workers Scripts, Workers KV Storage, Queues, Workflows, Durable Objects, Hyperdrive, R2 — **Edit**; Workers AI, Account Analytics — **Read**. Zone: **DNS — Edit** on the zone holding the app hosts and the sending domain (docs/DEPLOY.md → API token scopes) |
| `CLOUDFLARE_ACCOUNT_ID` | Workers & Pages → Overview (right-hand column / URL) | the 32-hex account id |
| `NEON_API_KEY` | https://console.neon.tech/app/settings/api-keys | personal or organisation key; creates the project and branches |
| `RESEND_API_KEY` | https://resend.com/api-keys | **Full access** (creates the domain, mints a `sending_access` key per environment; the full-access key itself never reaches a Worker) |

Optional Worker secrets copied by `pnpm provision secrets <env>` when exported or present in
`apps/web/.provision.env`: `BOOTSTRAP_ADMIN_EMAILS`
(defaults to `--admin-email`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`,
`MICROSOFT_CLIENT_SECRET`, `ANTHROPIC_API_KEY`, `EMBEDDINGS_API_KEY`, `LANGFUSE_PUBLIC_KEY`,
`LANGFUSE_SECRET_KEY`. `DATABASE_URL` is never set on a Worker (it uses Hyperdrive);
`OAUTH_ENCRYPTION_KEY` is generated (64 hex).

## What each phase calls

| Phase | Calls |
|---|---|
| tokens | per token, after it is typed: `wrangler whoami` with the candidate token in the child environment (exit 1 = rejected), the account id in that output or Cloudflare `GET /accounts/{id}`, Neon `GET /users/me`, Resend `GET /domains`; then `writeFileSync` + `chmod 600` on `apps/web/.provision.env` |
| preflight | `wrangler whoami`, Neon `GET /users/me`, Resend `GET /domains`, `gh auth status`, `git remote get-url origin`; per custom host / sending domain Cloudflare `GET /zones?name=` up the `zoneCandidates` walk (`GET /zones?per_page=1` to tell "no zone" from "no Zone scope") and `GET /zones/{id}/dns_records?per_page=1`; zone ids → `.provision.json` |
| email create | Resend `GET/POST /domains`, `GET /domains/{id}`; Cloudflare `GET /zones?name=`, `GET/POST/PUT /zones/{zone}/dns_records`; `patch-toml` (`EMAIL_FROM`) |
| email verify | Resend `POST /domains/{id}/verify`, `GET /domains/{id}` (poll ≤ 10 min), `POST /api-keys` (`sending_access`, `domain_id`); `wrangler secret put RESEND_API_KEY` (stdin) |
| neon | `GET/POST /projects` (+ operations polling), `GET/POST /projects/{id}/branches`, `…/branches/{b}/{endpoints,databases,roles}`, `…/roles/{r}/reveal_password` or `reset_password`; `SELECT 1` with the `postgres` package |
| cloudflare | `scripts/cf-provision.sh <env> --apply` → `wrangler hyperdrive create`, `kv namespace create`, `queues create`, `r2 bucket create`; `patch-toml` (ids); `REQUIRE_PROVISIONED=1 pnpm web test:config` once both tomls are done |
| migrate | `DATABASE_URL=… pnpm db:migrate:ci`; `SELECT count(*) FROM drizzle.__drizzle_migrations` vs `migrations/meta/_journal.json` |
| github | `gh api -X PUT repos/{owner}/{repo}/environments/{env}`, `gh secret set NAME -e env` (value on stdin), `gh secret list -e env --json name` |
| urls | Cloudflare `GET /accounts/{id}/workers/subdomain` (when `workers.dev`); `patch-toml` (`APP_URL`, `routes`); parity test |
| deploy | `pnpm deploy[:staging]`, `wrangler deployments list --json`, `GET /api/health`, `GET /api/ready` |
| secrets | `wrangler secret list --format json`, `wrangler secret put NAME` (stdin) |

API references: Neon https://api-docs.neon.tech/reference/ · Resend https://resend.com/docs/api-reference/
· Cloudflare https://developers.cloudflare.com/api/ · wrangler https://developers.cloudflare.com/workers/wrangler/commands/
· gh https://cli.github.com/manual/ · GitHub Environments https://docs.github.com/en/rest/deployments/environments

## Optional exploration tools (NOT the provisioning path)

The official Claude Code plugins and MCP servers are handy for *looking* at an account while
debugging (list branches, read a domain's status), but they authenticate with a browser OAuth
session that cannot be handed to CI or reproduced from a token, so this skill does not provision
through them:

- `/plugin install neon@claude-plugins-official` · MCP `https://mcp.neon.tech/mcp`
- `/plugin install resend@claude-plugins-official` · MCP `https://mcp.resend.com/mcp`
- `/plugin install cloudflare@claude-plugins-official` (the `cloudflare` / `wrangler` skills in this
  repo already cover the docs)

## Manual path

`SETUP.md` Part 3 is the same sequence by hand (`pnpm provision:cloudflare <env>` is the shell half:
`NEON_DATABASE_URL=… bash apps/web/scripts/cf-provision.sh <env> [--apply]`), and `docs/DEPLOY.md`
is the topology reference (two tomls, account-scoped names, the release dance, rollback).

## Known risks and limits

- **Workers Paid.** Hyperdrive, Workflows and `[limits]` are documented as Paid features in
  `docs/DEPLOY.md`; Cloudflare's pricing page now lists Hyperdrive on Free with a daily query cap
  and without connection pooling. `cf-provision.sh` maps a plan-related create failure to the
  upgrade URL `https://dash.cloudflare.com/?to=/:account/workers/plans`.
- **DNS records are created `proxied: false`** (DKIM/CNAME and MX must resolve to Resend's values);
  an existing proxied record at the same name is left alone and reported by `email status`.
- **Resend region is permanent per domain** (`--email-region`, default `us-east-1`); deleting and
  re-creating the domain is the only way to change it.
- **Neon cold starts**: the first `SELECT 1` on a scaled-to-zero compute can take several seconds;
  the script retries for ~40 s per branch. `reveal_password` answers 412 on projects without
  password storage — the script then resets the password (and says so).
- **`--rotate`** resets Neon passwords (once per run, from the `neon` phase only; an existing
  Hyperdrive config is then updated with `wrangler hyperdrive update <id> --connection-string=…`
  when the toml already carries its id, and GitHub's `DATABASE_URL` is re-set by `github <env>`),
  `OAUTH_ENCRYPTION_KEY` (invalidates every tenant AI credential and stored OAuth token) and mints
  a new Resend key. Not for routine re-runs.
- **A conflicting SPF record is not merged.** `email create` adds Resend's `send.<domain>` TXT
  beside an existing one with different content rather than editing it (two SPF TXTs at one name
  are invalid SPF) — `email status` shows both; remove the stale one by hand.
- **The connection string is an argv once**: `wrangler hyperdrive create --connection-string=…`
  inside `cf-provision.sh` (inherited behaviour, output redacted). Everything else travels by env or stdin.
- **`gh api -X PUT …/environments/<env>`** needs the `repo` scope on the `gh` login; the origin
  remote must be `github.com`.
- **`/auth/methods` always reports `magicLink: true`** — the email verify line proves the Worker is
  up and the key is set, not that a message was delivered. Send yourself a magic link to confirm.
- `apps/web/.provision.json` (git-ignored) caches ids and answers only; the writer refuses any
  secret-shaped value. Delete it to start the questions over.
- **`pnpm provision tokens` stores a token it could not verify** after three attempts (with a
  warning) rather than losing it to a vendor outage — `preflight` is the real check. A token that
  exists only in the environment is kept on Enter and not copied into the file.
