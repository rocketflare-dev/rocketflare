# External deployer protocol, v1

`deploy.yml` can deploy the Worker in two ways. By default the job holds a Cloudflare API token and
the environment's owner `DATABASE_URL`, migrates and runs `wrangler deploy` (`docs/DEPLOY.md` → CI/CD
flow). When the repository variable **`DEPLOYER_URL`** is set, it hands the build to an **external
deployer** instead, and CI holds **no Cloudflare token and no database credential**.

Why this exists: a Cloudflare token that can deploy a Worker can also bind **any** resource in the
account into it (another app's KV, R2, queue, database). A deployer that owns the token can check
every binding against what this app is allowed before anything goes live.

This page is the contract. The client side is `scripts/deployer.mjs` (no dependencies); any service
that implements the endpoints below can deploy a kit app.

## The flow

```
start ──► (approval) ──► build ──► upload ──► migrate ──► activate ──► finish (always)
  ticket    pending→        wrangler   deployer checks    pnpm db:migrate:ci   version    credentials
  opened    approved        --dry-run  the build, stores  with migratorUrl     goes live  revoked,
                            + build:ui an undeployed                                      ticket closed
                                       version, THEN
                                       issues migratorUrl
```

The order is the security property: **the build is checked before any credential exists**, so a
refused build cannot have migrated the database. A rejected or never-approved ticket gets no
build accepted, no credentials and no migration.

## Configuration (the GitHub side)

| Name | Where | Meaning |
|---|---|---|
| `DEPLOYER_URL` | repository variable | the deployer's base URL. Unset or empty → the default path |
| `DEPLOYER_AUDIENCE` | repository variable, optional | the OIDC audience to request. Default: the origin of `DEPLOYER_URL` |
| `WAIT_SECONDS` | step env, optional | how long `start` waits for approval (default 300) |
| `permissions: id-token: write` | both deploy jobs | lets the job mint OIDC tokens |
| `permissions: contents: write` | `release-bundle` only | attaches the build-once bundle to the tag's draft release (Build once below) |

The GitHub Environments `staging` and `production` still exist (they scope the OIDC `environment`
claim); on this path they need no secrets.

## Authentication

Every request carries `Authorization: Bearer <token>`, where the token is a **GitHub Actions OIDC
token** minted fresh for that call (`ACTIONS_ID_TOKEN_REQUEST_URL` + `&audience=<DEPLOYER_AUDIENCE>`).
The deployer verifies it against `https://token.actions.githubusercontent.com/.well-known/jwks` and
checks, at minimum:

| Claim | Check |
|---|---|
| `iss` | `https://token.actions.githubusercontent.com` |
| `aud` | the audience this deployer answers to |
| `repository` (better: `repository_id`, stable across renames) | a repository registered as this app |
| `environment` | `staging` or `production`, mapped to the app's environment — the ticket deploys only that one |
| `job_workflow_ref` | starts with `<owner>/<repo>/.github/workflows/deploy.yml@` — otherwise any workflow on any branch that can target the environment could ask |
| `ref` | `refs/heads/<default branch>` or `refs/tags/*` (a tag push and a published Release both carry the tag) |
| `run_id` (+ `run_attempt`) | recorded on the ticket at `start`; every later call on that ticket must come from the same run and environment, so one run cannot use another's approval |

Answer **401** for a missing, invalid or wrong-audience token and **403** for a valid token the
deployer does not accept. Approval policy (automatic for staging, a person for production, …) is
the deployer's business.

## Endpoints

All bodies are JSON. Every non-2xx response is `{ "error": "<human-readable reason>", … }`; the
client prints `error` and fails the step. The client ignores response fields it does not know.

### `POST /deploy/start`

Request: `{ "protocol": 1 }`. Response **200**: `{ "id": "<ticket id>", "status": "pending" | "approved" | "rejected" }`.
An unsupported `protocol` → **400** `{ "error": …, "supported": [1] }`. The client exports the id
as `DEPLOYER_TICKET` for the later steps.

### `GET /deploy/:id`

Response **200**: `{ "id", "status" }` (plus anything informative). The client polls every 10 s until
`approved` (continue), `rejected` (fail) or `WAIT_SECONDS` elapses (fail). A 5xx is retried; any
other non-2xx fails.

### `POST /deploy/:id/upload`

Allowed only on an `approved` ticket (otherwise **409**). Request:

```json
{
  "protocol": 1,
  "version": "1.4.0",
  "main": "worker.js",
  "toml": "<the wrangler config, verbatim>",
  "modules": { "worker.js": "<base64>", "chunks/lib.js": "<base64>", "abc123.wasm": "<base64>" },
  "assets": { "/index.html": "<base64>", "/assets/app-3f2a.js": "<base64>" },
  "digest": "<sha256 hex>",
  "source": "build"
}
```

- `toml` is the file named by `TOML` (`apps/web/wrangler.staging.toml` or `apps/web/wrangler.toml`).
  The deployer parses it itself and **refuses** (403, `{ "error", "refused": ["kv_namespaces X=…"] }`)
  any `name` that is not this app's Worker and any binding not registered for this app and
  environment. Never trust it beyond that.
- `modules` is every file `wrangler deploy --dry-run --outdir` wrote, keyed by its path relative to
  the outdir, except source maps (`*.map`) and wrangler's `README.md`. Module type follows
  wrangler's default rules: `.js`/`.mjs` ES module, `.cjs` CommonJS, `.wasm` compiled Wasm, `.bin`
  data, `.txt`/`.html`/`.sql` text. `main` names the entry module.
- `assets` is every file under the toml's `[assets] directory` (the built UI), keyed by its
  `/`-rooted path, `.assetsignore` excluded. `{}` when the toml has no `[assets]`.
- `digest` (optional; the kit's client always sends it) is the artifact digest of `modules` +
  `assets`: each file at its bundle path — module `<rel>` at `worker/<rel>`, asset `/<rel>` at `ui/<rel>` —
  hashed (sha256 of the decoded bytes), the `<sha256>  <path>\n` lines sorted by path in byte
  order, and sha256 over them: the `bundleSha256` recipe (Build once, below), applied to the
  payload. A deployer should recompute it from what it received and refuse a mismatch; it is a
  check on the transfer, not a credential.
- `source` (optional, likewise): `bundle` when the job deploys the staging release bundle
  (`scripts/bundle.mjs fetch` → `source=bundle`, passed as `DEPLOYER_SOURCE`), `build` when it
  built the bytes itself — staging always, production with no bundle. A deployer may refuse a
  `bundle` upload whose `digest` differs from what staging uploaded for the same version (Launch:
  409); a `build` one can only be compared and warned about.
- `version` becomes the Worker's `RELEASE_VERSION` var; the deployer sets it, the toml's `[vars]`
  otherwise apply as written. Worker secrets are the deployer's to manage and must survive the
  deploy (Cloudflare: `keep_bindings: ["secret_text"]`).
- **Size.** Everything is base64 inside one JSON body, about 4/3 of the bytes on disk; the kit's own
  build is a few MB. A deployer should accept at least 50 MB. Cloudflare's own limits still apply
  (Worker size per plan, 25 MiB per asset file).

Response **200**: `{ "id", "status": "uploaded", "migratorUrl": "postgresql://…", … }` (e.g. a
`versionId`). The deployer stores the build as an **undeployed version** (Cloudflare: the Workers
Versions API) and only then issues `migratorUrl`. The client masks it (`::add-mask::` for the URL
and its password) and exports it as `MIGRATOR_URL`; it is never printed.

**`migratorUrl`** is a Postgres connection string for this environment's database that the next
step runs `pnpm db:migrate:ci` with (`db-roles --phase=role` → migrations → `db-roles
--phase=grants`), so the role must be able to:

- own the schema: create and alter every table (it is the tables' owner, or the role that created them);
- `CREATE ROLE rocketflare_app` and `ALTER ROLE` it (`CREATEROLE`);
- `ALTER DEFAULT PRIVILEGES FOR ROLE <its own username>` — `db-roles.ts` names the URL's user as the
  owner, so that user must be the one the tables are created by.

In practice: the database owner role, or an equivalent. Prefer the **direct** (non-pooled) host
(`migrate.ts` strips a Neon `-pooler` itself). It must be **short-lived**: valid from this response
until `activate` or `finish`, whichever comes first, then revoked (e.g. the password reset). The
deployer never stores it.

### `POST /deploy/:id/activate`

Allowed only on an `uploaded` ticket. The deployer makes the uploaded version live (Cloudflare: a
deployment at 100%) and revokes `migratorUrl`. Response **200**: `{ "id", "status": "active" }`.

### `POST /deploy/:id/finish`

Always called last (`if: always()`), after success, failure, rejection or a timeout. **Idempotent**:
it revokes `migratorUrl` if still live and closes the ticket, and answers **200** `{ "id", "status" }`
on any ticket this run owns, however many times it is called. A ticket finished before `activate`
never goes live. The client skips the call when `start` never opened a ticket.

## Ticket statuses

| Status | Meaning | Next |
|---|---|---|
| `pending` | opened, waiting for approval | `approved`, `rejected`, `finished` |
| `approved` | may upload; no build accepted, no credentials issued | `uploaded`, `failed`, `finished` |
| `rejected` | refused by a person or a policy. Terminal | — |
| `uploaded` | build checked and stored as an undeployed version; `migratorUrl` issued | `active`, `failed`, `finished` |
| `active` | the version is live; credentials revoked | `finished` |
| `finished` | closed by `finish`; credentials revoked. Terminal | — |
| `failed` | the deployer could not complete a step (e.g. activation). Terminal; production keeps serving the previous version | — |

## Build once (release bundle)

On a **tag**, the staging job builds once and production deploys those bytes: Live runs what
Staging validated. Nothing in the protocol above changes — production still runs start → upload →
migrate → activate → finish, with `toml` = its own `wrangler.toml`; only where `modules` and
`assets` come from changes. The bundle is environment-neutral: the Worker and UI builds are
byte-identical under either toml, and every binding and var reaches the deployer through `toml`.

| Job | Does |
|---|---|
| `staging` | after the dry run, `node scripts/bundle.mjs pack` → `apps/web/dist/launch-bundle-<tag>.tgz`; uploads it as the `launch-bundle` workflow artifact once `activate` succeeded |
| `release-bundle` | `contents: write`, no install: `node scripts/bundle.mjs attach` verifies the bundle against the checkout and attaches it to the tag's release — creating a **draft** when there is none — then `node scripts/bundle.mjs prune` deletes old unpromoted bundle drafts. Never fails the run (staging is already live): a failed attach is a warning and a summary line, and production builds from the tag |
| `production` | `node scripts/bundle.mjs fetch`: the published release's asset → verify → unpack into `dist/deploy` and `dist/ui`, then skip `build:ui` and the dry run (`source=bundle`). No release or no asset → `source=build`, today's build. Rollback (`workflow_dispatch environment=production` at a tag) takes the same path |

**The asset** `launch-bundle-<tag>.tgz` (ustar + gzip, entries sorted, mtime 0, mode 0644 — the
same inputs give the same bytes):

```
manifest.json  { protocol: 1, tag, version, commit, treeSha, main, compatibility_date,
                 compatibility_flags, wranglerVersion, files: { "<path>": "<sha256>" }, bundleSha256 }
worker/<rel>   the dry-run outdir minus *.map and README.md (the filter `upload` uses)
ui/<rel>       the toml's [assets] directory minus .assetsignore (likewise)
```

`bundleSha256` is sha256 over the `sha256sum` lines of `files`, sorted by path in byte order —
recomputable from an unpacked bundle with
`LC_ALL=C find worker ui -type f | LC_ALL=C sort | xargs sha256sum | sha256sum`.
Because the bundle holds exactly the files `upload` sends, the upload `digest` of a bundle
deploy equals its `bundleSha256` — and equals staging's upload `digest` for the same tag, since
staging uploaded the same bytes it packed.

**Verification** (`fetch`, and `attach` before it uploads) fails the job — it never falls back to a
build — when: the protocol is not 1; `tag`, `commit` or `treeSha` differ from the checkout; a
file's sha256, or `bundleSha256`, does not match; the archive holds a file the manifest does not
list, or lacks one it does; an entry is not a plain file under `worker/` or `ui/`; or the toml's
`main` and compatibility settings differ from the build's.

**Why a draft, not a prerelease.** `release: published` fires when ANY release is first published,
a prerelease included — it is production's trigger, so a staging-created prerelease would start
production. A draft fires nothing until it is published, and publishing it (`PATCH draft: false`,
or Publish in the GitHub UI) fires `published` exactly once. Releases stay the external record.
`attach` replaces the asset on a draft (a staging re-run) and never on a published release.

**What a promoter must do** (Launch, or a person): publish the existing draft for the tag rather
than create a new release. `GET /repos/{o}/{r}/releases/tags/{tag}` answers 404 for a draft, so:

1. `GET …/releases/tags/{tag}` → 200: already published, nothing to do.
2. Otherwise list `GET …/releases?per_page=100` (a `contents: write` token sees drafts) and take the
   draft whose `tag_name` is the tag — the one carrying `launch-bundle-<tag>.tgz` first — and
   `PATCH …/releases/{id}` with `{ "draft": false, "name", "body" }` (never `tag_name`). That fires
   `release: published` and production deploys the bundle.
3. No draft: `POST …/releases` as before; production builds from the tag.

A new release created beside the draft also deploys, but from a rebuild, and leaves the draft behind.
A person cutting releases by hand on this path does the same: `gh release edit X.Y.Z --draft=false`,
not `gh release create` (`SETUP.md` 3.7).

**Unpromoted drafts are pruned.** Every staging deploy leaves a draft and only promoted tags are
published, so after each attach `prune` deletes the bundle drafts older than the newest
`BUNDLE_KEEP_DRAFTS` (a repository variable; default **5**, the tag just attached included; `0`
turns pruning off). It deletes only a draft for a bare `X.Y.Z` tag at or below the one deployed
whose sole asset is its own `launch-bundle-<tag>.tgz` — a draft somebody added files to, a newer
tag's, and every published release are left alone. No tag is deleted: an older tag can still be
promoted, and then builds from the tag (step 3).

## Versioning

This is **protocol 1**. The client sends `"protocol": 1` in `start` and `upload`. Within v1 a
deployer may add response fields and optional request fields; the client ignores what it does not
know. Likewise a v1 deployer **ignores request fields it does not know**, so a client may add
optional ones (`digest` and `source` were added that way) without asking first. Anything else — a
renamed field, a new required step, a different auth scheme — is protocol 2, and a deployer that supports both answers by the `protocol` the client sent. A deployer that does
not support the client's version answers `start` with **400** and `supported`.

## Testing

`apps/web/tests/config/deployer.test.ts` runs `scripts/deployer.mjs` against a fake deployer and a
fake OIDC endpoint: the whole flow, the payload (its `digest` and `source` included), the masking,
rejection, timeout and `finish` with no ticket. It is the executable half of this page. Build once: `bundle-lib.test.ts` (pack/unpack,
the digest, every verification failure, the two workflow decisions) and `bundle.test.ts` (the real
script against a fake GitHub releases API: draft creation, re-runs, fetch, fallback, tampering, a
moved tag); `ci-workflows.test.ts` pins the wiring in `deploy.yml`.
