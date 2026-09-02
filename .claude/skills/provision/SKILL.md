---
name: provision
description: Take a locally-running copy to Cloudflare + Neon + Resend — provisions every resource, patches the tomls, migrates, deploys staging, sets secrets, verifies email. Runs after /setup and /adapt.
disable-model-invocation: true
argument-hint: "[--deploy staging|both] [--skip-email] [--rotate]"
---

# /provision — from "runs on my laptop" to "deployed"

**This one is user-invoked only** (`disable-model-invocation`), unlike `/setup` and `/adapt`:
it creates paid cloud resources and its `tokens` phase needs a TTY for hidden prompts. Asked
to deploy, tell the user to run `/provision` themselves rather than attempting it.

You are driving `pnpm provision` (`apps/web/scripts/provision.ts`) for a person who may never have
deployed anything. Explain each step in one plain sentence before you run it, show the `Verify:`
line it ends with, and stop at the first failure. Reference material (API docs, token scopes,
known risks, the manual path) is in `reference.md` next to this file.

Prerequisites: `/setup` Part 1 has passed locally and, on a fresh copy, `/adapt` has renamed the
app (the script reads the app name from `apps/web/wrangler.toml`, never a literal).

## Step 0 — accounts and tokens (the user does this, not you)

**Before anything: three accounts you create yourself** (no script can):

1. **Cloudflare** — on the **Workers Paid** plan (Hyperdrive, Workflows), AND your domain on the
   account: registered there (https://dash.cloudflare.com/?to=/:account/domains/register) or added
   as a site with its nameservers moved (https://dash.cloudflare.com/?to=/:account/add-site). The
   app's hostnames and the email DNS records are created in that zone. Without a domain the skill
   uses a `workers.dev` address for both hosts and `--skip-email`.
2. **Neon** — the free tier is fine for the two branches.
3. **Resend** — the free tier is fine; it needs the domain from (1).

Then **`! pnpm provision tokens`**. Three accounts, four tokens. **Tokens are never pasted into this
chat and never echoed.** Ask the
user to run **`! pnpm provision tokens`** in their own terminal (the `!` prefix runs it there; it
shows where to mint each token with its scopes, prompts with hidden input, verifies each token
against its vendor and writes `apps/web/.provision.env`, git-ignored, mode 0600) — or to copy
`apps/web/.provision.env.example` to `apps/web/.provision.env` and fill it in by hand. Environment
variables still override the file (CI exports them). Your Bash has no TTY, so `tokens` refuses to
run from here (exit 2) — that is deliberate. If they are missing, tell the user to:

1. Create the tokens (scope lists in `reference.md`; `pnpm provision tokens` prints the same):
   - Cloudflare: https://dash.cloudflare.com/profile/api-tokens → `CLOUDFLARE_API_TOKEN`; the
     account id (Workers & Pages overview, right-hand column) → `CLOUDFLARE_ACCOUNT_ID`.
     The token needs `Zone: DNS — Edit` on the zone from (1).
   - Neon: https://console.neon.tech/app/settings/api-keys → `NEON_API_KEY`.
   - Resend: https://resend.com/api-keys (Full access) → `RESEND_API_KEY` — or use `--skip-email`
     (`pnpm provision tokens --skip-email` skips that prompt).
   - Optional, same file (the `secrets` phase copies them to the Worker): `GOOGLE_CLIENT_ID/SECRET`,
     `MICROSOFT_CLIENT_ID/SECRET`, `ANTHROPIC_API_KEY`, `EMBEDDINGS_API_KEY`,
     `LANGFUSE_PUBLIC_KEY/SECRET_KEY`.
2. `! pnpm provision tokens` in their terminal (or fill the file). A CI job exports the variables
   instead; an exported variable always wins over the file.
3. Log in to the two CLIs themselves (these open a browser; you cannot do it for them):
   type `! gh auth login` and, if `wrangler whoami` is not already happy, `! pnpm web exec wrangler login`.

Then check everything at once:

```
pnpm provision preflight --domain <sending domain> --staging-host <host|workers.dev> --production-host <host|workers.dev> --admin-email <email>
```

Exit code 2 = something is missing; the output names each missing token with the URL to mint it
and says to run `pnpm provision tokens`. Exit code 1 with "the domain <apex> is not on this
Cloudflare account" = step 0 (1) is not done: the user registers the domain or moves its
nameservers (the message carries both links), or answers `workers.dev` for both hosts and adds
`--skip-email`. Fix (no restart of `claude` is needed when the file changed — it is read on every
run), re-run. Success reads
`Verify: preflight ok — app=… account=… neon=… resend=… zone=<zone> (<id>)` (`zone=none` when both
hosts are `workers.dev` and email is skipped); the zone id is cached for `email create` and `urls`.

## Step 1 — collect the four answers, then run everything

Your Bash has no TTY, so the script cannot ask questions — **ask the user first**, then pass the
answers as flags (they are cached in `apps/web/.provision.json` after the first run):

| Question | Flag | Sensible default |
|---|---|---|
| Neon region (near your users) | `--region aws-us-east-1` | `aws-us-east-1` |
| Sending domain (a subdomain of a zone in the Cloudflare account) | `--domain mail.example.com` | `mail.<apex of APP_URL>` |
| Staging host, or `workers.dev` | `--staging-host staging.example.com` | `workers.dev` |
| Production host, or `workers.dev` | `--production-host app.example.com` | `workers.dev` |
| First admin email (`BOOTSTRAP_ADMIN_EMAILS`) | `--admin-email you@example.com` | `git config user.email` |

Then run the whole sequence (it takes 10–20 minutes; use a long Bash timeout):

```
pnpm provision all $ARGUMENTS --region … --domain … --staging-host … --production-host … --admin-email …
```

`$ARGUMENTS` may carry `--deploy both` (deploy production too; default staging only),
`--skip-email` (no Resend: magic links are logged in `wrangler tail` instead of sent) and
`--rotate` (regenerate keys/passwords — read the warning it prints first).

## How to read the output

Every phase prints one `Verify:` line. `all` runs them in this order and stops at the first one
that fails, telling you which phase to re-run; every phase is idempotent (find-or-create), so
re-running `all` afterwards is safe.

| Phase | It did | If it fails |
|---|---|---|
| `tokens` | (user's terminal only) prompts, verifies and writes `apps/web/.provision.env` | "needs a terminal" → the user runs it with the `!` prefix, not you |
| `preflight` | tokens, tools, accounts, answers; every custom host and the sending domain resolved to a zone on the account, DNS readable | missing token → step 0; `gh` not logged in → the user runs `gh auth login` themselves; "not on this Cloudflare account" → step 0 (1), or `workers.dev` + `--skip-email`; "cannot read DNS records" → the token lacks `Zone: DNS — Edit` on that zone |
| `email create` | Resend domain + DNS records in your Cloudflare zone, `EMAIL_FROM` in both tomls | "no Cloudflare zone" → the apex domain must be in this Cloudflare account (or `--skip-email`) |
| `neon` | project + `staging` branch, `SELECT 1` on both | region name wrong → `--region`; 412 password storage → it resets the password itself |
| `cloudflare staging/production` | Hyperdrive, KV, Queue, R2; ids patched into the toml | "Hyperdrive requires Workers Paid" → upgrade the plan at the printed URL; "already has id" → `--force` only if you know the old resource is gone |
| `migrate <env>` | migrations on that branch, count == journal | a schema error is a code problem — do not retry blindly |
| `github <env>` | GitHub Environment + `DATABASE_URL`, `CLOUDFLARE_*` secrets | `gh` needs `repo` scope; the remote must be GitHub |
| `urls` | `APP_URL` + `routes` (custom host) or `workers.dev` in both tomls; parity test | "no workers.dev subdomain" → pick one in the Cloudflare dashboard once |
| `deploy <env>` | `pnpm deploy[:staging]`, then `/api/health` and `/api/ready` | `/api/ready` 503 → Hyperdrive cannot reach Neon: wrong host / SSL; re-run `cloudflare <env> --force` after checking |
| `secrets <env>` | `OAUTH_ENCRYPTION_KEY` (generated) + every optional secret in the environment or `apps/web/.provision.env` | nothing to fix; unset ones are listed as skipped |
| `email verify <env>` | Resend verification (polls ≤ 10 min), mints a sending key into `RESEND_API_KEY` | "DNS still propagating" → wait and re-run `pnpm provision email verify <env>` later |

`pnpm provision email status` shows each DNS record's presence when verification stalls.

## Close-out

`all` ends with a checklist — walk the user through it: sign in with the admin's magic link (with
`SIGNUP_MODE=invite_only` the first login lands on `/pending`; create the first organisation at
`/admin`), add OAuth redirect URIs per environment if they use Google/Microsoft, commit the two
tomls (`git add apps/web/wrangler*.toml && git commit`), push, optionally
`gh workflow run deploy.yml -f environment=staging`, and `pnpm cli login --server <APP_URL>`.
Production, when not deployed by `--deploy both`, ships through the release dance in
`docs/DEPLOY.md` or `pnpm provision deploy production` + `secrets production` + `email verify production`.

## Rules

- Never print, paste or store a token, key or connection string; the script redacts its own
  output and keeps secrets in memory or in child-process stdin/env only. Do not work around that.
  You never read, `cat` or edit `apps/web/.provision.env` — the script reads it.
- Do not edit `.dev.vars`, and do not hand-edit the tomls while a phase runs.
- The user's local `pnpm dev` stack is untouched by every phase; no phase needs it running.
- `gh auth login`, `wrangler login` and any browser step are the user's own commands (they type them
  with the exclamation-mark prefix in Claude Code); you never run them.
