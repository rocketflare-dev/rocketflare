# Threat model

What a security review of this codebase should try to break. Read by the `/rf-security` audit
(`docs/SECURITY-AUDIT.md`), and by anyone adding a route, a tenant table, a plugin or an agent tool.
The mechanisms are in `docs/CONCEPTS.md`, and the state of row-level security is in `docs/RLS.md`.

In an app built from the kit this file is the app's own: rewrite it for your product, your users
and your deployment. A kit upgrade shows the kit's changes to it as a diff and never applies them,
and never brings it back once deleted (the `threat-model` surface in `.rocketflare.json`). The
audit will not start without one.

## Scope

A multi-tenant Hono API and React UI in one Cloudflare Worker (`apps/web`), a CLI (`apps/cli`), shared
contracts (`packages/shared`), installed plugins, and the scripts that install, upgrade and deploy
them (`scripts/`). A finding in a deployed build matters more than one reachable only in local
development; a default that makes a deployment unsafe counts as deployed.

## Assets

- Tenant data: documents and their chunks, conversations, agent runs, files in R2, memberships,
  activity, notifications, and every copy derived from them (search chunks, compaction summaries,
  `ai_spans`, OTLP exports, logs).
- Credentials: sessions, API keys, magic-link and invitation tokens, tenant AI provider keys, OAuth
  tokens, plugin secrets, `OAUTH_ENCRYPTION_KEY` and everything derived from it.
- Authority: tenant roles, global admin, IdP-derived membership.
- Money: model spend against platform keys.

## Actors, least to most trusted

| Actor | May | Must not |
|---|---|---|
| Anonymous visitor | Public routes, sign-in, an invitation they hold the token for | Read or change tenant data; learn whether an account exists |
| Pending or rejected user | See the pending page | Gain tenant access or platform resources |
| Member | Use what the CASL matrix grants in their tenant; see documents visible to them | Reach another tenant; read a restricted document; raise their own role |
| Admin | Manage their tenant within the matrix | Create or remove an owner; extract a stored credential |
| Owner | Everything in their tenant | Reach another tenant |
| API key | Act as its tenant and role, within its stated scopes and expiry; read its creator's profile, and with a write scope edit it (`PATCH /api/me`, which the CLI uses) | Exceed either; reach `/api/admin/*`; list or act in its creator's other organisations, invitations or access requests |
| Support, global admin | Cross-tenant work through `/api/admin/*` and the audited entry path | Keep elevated access after losing the role |
| Document author (including a colleague or an uploaded file's source) | Supply text that the model reads | Steer another user's model turn into disclosure or an action |
| The model | Call tools bound to the requester's scope | Choose a tenant, or exceed the requester |
| Identity provider, inbound webhook sender | Assert what their configuration trusts | Be believed about anything else; replay beyond the accepted window |
| Plugin | Use the declared entries and injected context | Reach core outside them. Plugins run in-process with no sandbox, so an installed plugin is trusted like a dependency |
| Operator, developer | Control tomls, secrets, deploys | Out of scope as attackers |

Every role boundary in `apps/web/src/permissions/` is a security boundary. `TENANCY_MODE`,
`SIGNUP_MODE`, `OIDC_MANAGED_TENANCY` and `AUTH_OIDC_ONLY` each change who may be admitted, and each
is a promise to check in every path that admits someone.

## Trust boundaries and untrusted input

- HTTP: paths, query strings, bodies, uploads, cookies, `Origin`, `returnUrl`-style parameters.
- Tenant identity comes from the authenticated context only, never a client-supplied value. Background
  work takes it from a payload a server-side producer wrote, and re-reads rows with that tenant.
- Isolation is application predicates. Row-level security is inert by default, so **one missed
  `tenantId` is a cross-tenant read**, and no second layer catches it.
- Text from documents, uploads, tool results, summaries and web sources is untrusted when it reaches a
  model or the page that renders model output.
- Server-side fetches of a configured URL (`baseUrl`) are attacker-influenced: stored credentials must
  go only where the credential's owner intended.
- OIDC claims, identity webhooks, `install.sh` and a plugin's git source cross a boundary inward.

## Out of scope

- Anything requiring a compromised operator, Cloudflare account or developer machine.
- Upstream bugs in Hono, Drizzle, workerd or similar, without a reachable impact here.
- Volumetric denial of service. Cost abuse and per-request resource exhaustion by a low-trust actor
  remain in scope.
- Scanner output with no reproduction; missing hardening where another layer already blocks the attack.
- Limits already documented in the "Known gaps" of `docs/CONCEPTS.md`, unless the code does less than
  they say, or a default turns one into a boundary failure.

## For plugin authors

A plugin runs in the same Worker as the kit, with no sandbox (`docs/CONCEPTS.md` §16). Installing
one is as trusting as merging its code, so the threat model above applies to it in full: a hole in
a plugin is a hole in every app that installs it.

**What a plugin's author is trusted with.** Everything the declared entries and the injected
contexts hand over: a database client, the tenant and user of the current request, the requester's
CASL grant, the sealing key behind `sealSecret`, the job queue, storage, the model, and for a
public mount or public site, anonymous traffic. Nothing in the runtime stops a plugin misusing
them; the review and the tests are the control.

**What a plugin must assume about each caller.**

- **Anonymous callers** reach a public mount (`/api/hooks/<id>`) and a public site with no session.
  The handler gets no tenant and must prove the caller (a signature, `verifyState`) before it names
  one. `verifyState` has no replay ledger: a callback that must run once records that itself.
- **Members** call every authed route the plugin mounts. A member must not reach another tenant's
  rows, a row restricted from them, or a write their role does not grant. Check the role on the
  server (`ToolCtx.can`, the request's ability), never in the UI alone.
- **Tenant admins** manage their own tenant within the matrix. They must not reach another tenant,
  read a stored credential back, or raise themselves past the matrix through a plugin's settings.
- **The model** is steered by any text it reads: documents, uploads, tool results, web pages,
  email. A tool acts within the requester's grant and tenant, gates its writes on the requester's
  `manage` grant (not on `scope.bypass`, which is row visibility), and fetches only URLs the person
  wrote (`ToolCtx.requesterUrls`) or its own search returned. Model output that a page renders is
  untrusted markup.

**What the kit's seams guarantee.**

- The tenant on an injected context comes from the authenticated request or from a payload a
  server-side producer wrote, never from the client. `emit` on a tenant-bound context takes no
  tenant id, so an event cannot be forged into another tenant.
- Public mounts are confined to `/api/hooks/<id>`, rate-limited per IP and body-capped before the
  router runs. A public site gets the strict public CSP, and a cacheable request reaches its
  router without `Cookie` or `Authorization`.
- `sealSecret` / `openSecret` are AES-GCM under the deployment's key, and `signState` /
  `verifyState` are HMAC with a purpose and an expiry.
- `pnpm plugin check` and the host's `tests/config/plugins.test.ts` refuse an id that names the
  kit, a table two plugins declare, an import past the declared entries, an authed mount under
  `/api/hooks`, and a tenant table with no isolation test.

**What the plugin must prove itself.**

- **Tenant isolation of its own tables and query surfaces.** Every tenant table calls
  `tenantIsolation()`, every query filters by the tenant from the context, and the plugin's own api
  tests show tenant B cannot list, read, change or delete tenant A's rows. A query surface the kit
  cannot see (a cube, a search index, an export) needs its own isolation case. `plugin check` proves
  such a test exists, not that it is right.
- **Namespacing.** Tables, job types (`<id>.x`), query keys (`<id>:`), routes (`/api/<id>`) and
  CUSTOM events (`<id>.`) carry the plugin's id; never `kit.`.
- **No secrets in a response.** A stored credential is sealed, kept in a `*_enc` column, and
  answered as `hasCredential`; never logged, never sent back, never placed in a model prompt.
- **Visibility and roles.** A row hidden from a caller answers the same 404 as a missing one, and
  an empty grant list means private.

Run `/rf-security` over an app with the plugin installed (`audit.mjs host --plugin
<repo>:<subdir>`) before a release that changes any of the above.
