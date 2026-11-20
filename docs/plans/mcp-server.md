# MCP server in core

Status: **grilled and agreed** (2026-11-20). Issue #165. The phase 0 spike settles the few items
marked *spike*; everything else is decided. This is the build plan; the CONCEPTS section, SETUP,
DEPLOY and the threat model describe the shipped behaviour once it lands.

## Goal

The goal is that any MCP client supporting Client ID Metadata Documents can connect to an app built
on the kit at `https://<app>/mcp`. In v1 that means Claude (claude.ai, Desktop and Code) and
ChatGPT.
- **Sign-in:** people sign in with the app's own login, whichever methods the deployment has turned on.
- **Tools:** the client can call the app's tools, meaning the core knowledge tools and every plugin tool.
- **Control:** a tenant admin turns MCP on or off, chooses what is exposed and who may connect, and sees and revokes every connection.

**Out of scope:**
- MCP apps (UI resources), resources and prompts.
- An MCP **client**, where agents call remote MCP servers. That is a separate plugin idea.
- API keys on `/mcp`.
- Dynamic Client Registration (DCR) and static clients.
- Agents exposed as tools.
- Tools that need approval.

The last four are deliberate. See the decisions and "Later".

## Background (research, 2026-11-20)

- **Spec.** The current revision is **2026-07-28**.
  - Transport is stateless: no `initialize` session, no `Mcp-Session-Id`, `server/discover`, the `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers, and `input_required` round-trips for elicitation. 2025-11-25 clients must keep working.
  - Authorization is OAuth 2.1 with PKCE S256, RFC 8707 resource binding with an audience check, RFC 9728 protected-resource metadata, RFC 9207 `iss` on authorization responses, and 403 `insufficient_scope` step-up.
  - CIMD is preferred, and DCR is deprecated.
- **Existing code.** Rocketpod's `/mcp` (on its `main`, unreleased) and unwind-next's are **resource servers for one outside authorization server**, NearForm's Labs Access.
  - They need an authorization server that mints RFC 9068 JWTs carrying our audience and an `email`, and that registers MCP clients itself. Google, Entra, Cognito, magic link and dev-login can't do that.
  - **Worth porting:** the stateless transport wiring, building the list from `buildAgentTools`, the admission path, the 60k answer cap and the untrusted-content wrapper.
  - **Not worth porting:** the token model, matching people by email, and the per-call `tenant` argument.
- **Rocketflare 0.40.0** has no MCP and no OAuth authorization server.
  - The analytics plugin owns `/mcp` today: drizzle-cube, API-key auth. A core `/mcp` would shadow it.
  - The CLI login (`/auth/cli` → SPA confirm → a tenant-bound credential) is the shape `/authorize` + consent takes.
- **Clients.** Claude uses CIMD when the authorization server advertises `client_id_metadata_document_supported` and the `none` auth method.
  - Callback: `https://claude.ai/api/mcp/auth_callback`. Claude Code uses a loopback redirect on any port.
  - Claude wants refresh rotation, `invalid_grant` on an expired token, and a 10 s budget for every endpoint.
  - ChatGPT prefers CIMD and requires S256 and `resource`.
  - Cursor (CIMD unknown) and VS Code (partial) are not v1 clients unless the spike shows CIMD works.

## Decisions

| # | Decision |
|---|---|
| D1 | **The app is its own OAuth 2.1 authorization server, in Postgres**, not `@cloudflare/workers-oauth-provider` (KV only). Revocation is immediate and transactional, admins can list connections, grants are tenant-isolated, and Rocketpod shares the code |
| D2 | **A connection is one person in one organisation.** The organisation is chosen on the consent screen. There is one `/mcp` URL, and the grant is bound to (user, tenant, client). *Spike*: can a client hold two connections to one URL? If not, add an alias, `/mcp/t/<slug>` |
| D3 | **Who may connect**: any member, acting with their own permissions, once an admin turns MCP on. The tenant setting "who can connect" is everyone (default), admins, or chosen groups. **Support users are refused at consent** |
| D4 | **Scopes**: `mcp:read` (read-only tools) and `mcp:write` (side effects). The baseline challenge is `mcp:read`; a write tool returns 403 `insufficient_scope` naming both. A tool's scope comes from `sideEffects`, and a plugin can override it. A call needs all four of: the scope, the tenant exposure, the person's role and CASL, and the tool's own checks. A scope only narrows, never grants |
| D5 | **Tool seam**: one tool list for chat, agents and MCP. `Tool` and `defineTool` gain `surfaces?: ('chat'\|'agents'\|'mcp')[]` (default all) and `mcp?: { title?, annotations?, outputSchema?, scope? }`. Annotations default from `sideEffects`. One `toolsFor(surface, ctx)` filters for every surface. Terminal tools (no handler) are never exposed. `plugin check` refuses colliding or non-conforming names |
| D6 | **Data access constraints flow through unchanged.** Every call rebuilds the caller's `AccessScope` (tenant + groups) and CASL from the database. Nothing is cached on the grant. A core visibility conformance test covers every exposed core tool, and `@testkit`'s `callMcpTool` lets each plugin prove its own tools scope |
| D7 | **Exposure modes** per tenant: **all read-only tools** (default, new ones included), **enable all** (writes too, new ones included, after a confirmation), and **selected** (only ticked tools). A write tool still needs `mcp:write` |
| D8 | **Tools that need approval** (`requiresApproval[When]`) **are not exposed in v1**, in any mode. They are shown greyed out with the reason |
| D9 | **Agents are not exposed in v1** |
| D10 | **Analytics registers its cube tools through the plugin tool seam**, with `surfaces: ['mcp', 'agents']`. Its `/mcp` mount is removed in a plugins release that requires the new kit, with no alias. Core refuses any plugin mount or `apiPrefix` on `/mcp`, `/oauth/*` or `/.well-known/oauth-*` |
| D11 | **`ServerPlugin.agentTools` is renamed `ServerPlugin.tools`.** `agentTools` stays as a deprecated alias (`tools ?? agentTools`, a `plugin check` warning naming the replacement) until a later kit release removes it with a porting-note step |
| D12 | **Client identification: CIMD only.** No DCR and no static clients in v1 |
| D13 | **`/mcp` accepts OAuth access tokens only.** API keys and CLI keys are refused there; they stay the HTTP API's and the CLI's |
| D14 | **Lifetimes**: access token 60 min (opaque, stored as a hash); refresh token rotates on every use, and reusing one revokes the grant. A grant lapses after 30 days idle (`MCP_GRANT_IDLE_DAYS`) or 90 days in total (`MCP_GRANT_MAX_DAYS`), capped by `OIDC_SESSION_MAX_AGE_DAYS` under IdP-managed tenancy. A grant is **independent of the browser session**. It ends on revocation by the person or an admin, or on member removal or block. Turning MCP off for the tenant suspends grants (403) without revoking them |
| D15 | **Audit**: `mcp_tool_calls`, one row per call (tenant, user, grant, client, tool, outcome and code, duration, cost), with **no arguments or results** stored. Kept 90 days (`MCP_CALL_RETENTION_DAYS`). Activity rows are for lifecycle events only. Each call gets a span named for its tool, and `/mcp` gains tracer coverage |
| D16 | **Limits**: 60 calls per grant per minute and 600 per tenant per minute (`MCP_CALLS_PER_GRANT_PER_MINUTE`, `MCP_CALLS_PER_TENANT_PER_MINUTE`) on the KV window, returned as **tool errors**, not 429. Cost goes through `ai_usage` tagged `surface: mcp`, under the existing tenant caps; there is no MCP-specific spend cap. `/oauth/*` uses `authRateLimit`. *Spike*: check that limit against Claude's refresh pattern |
| D17 | **SDK**: the official `@modelcontextprotocol/server` 2.x with `@modelcontextprotocol/hono`, confirmed by the spike. Fallback: `agents` `createMcpHandler`, used for the transport only. Not `McpAgent` |
| D18 | **Branding**: everything a client or person sees comes from `cfg.APP_NAME` and the organisation's name, never "Rocketflare". That covers `serverInfo`, `resource_name`, instructions, the consent page, snippets and error text. Identifiers are neutral: scopes `mcp:*`, token prefix `mcpat_` / `mcprt_`. A test sets `APP_NAME` to "Acme Tools" and bans `/rocketflare/i` from every MCP and OAuth response. `plugin check` warns on the literal in a tool's `title` or `description` |
| D19 | **Delivery**: one kit release built as stacked PRs (spike → A tools and server → B authorization server → C plugins). `/rf-security` standard runs over the diff before the tag, with fixes in the same release. Analytics ships in a plugins release after it. Rocketpod ports it **after** its 0.40 catch-up (`~/work/rocketpod/docs/PORT-ROCKETFLARE-0.40.md`), and its current resource-server `/mcp` becomes the later outside-authorization-server mode |

## Configuration and storage

**Deployment gate.** A D30 feature flag `mcp`, `environmentGated`. A deployment ships it only when
`FEATURES_ENABLED` names it, and a global admin sets its rollout. When it is off, these answer 404:
- `/mcp` and `/oauth/*`;
- the `.well-known` documents;
- the consent page;
- the settings routes.

**New vars** (optional; undeclared means the default):

| Var | Default |
|---|---|
| `MCP_GRANT_IDLE_DAYS` | 30 |
| `MCP_GRANT_MAX_DAYS` | 90 |
| `MCP_CALL_RETENTION_DAYS` | 90 |
| `MCP_CALLS_PER_GRANT_PER_MINUTE` | 60 |
| `MCP_CALLS_PER_TENANT_PER_MINUTE` | 600 |

The *spike* checks whether `global_fetch_strictly_public` goes in both tomls; that depends on it
breaking nothing else. If it can't, CIMD fetches go through our own public-address guard.

**Tables** (Drizzle; the host generates the DDL; every tenant table calls `tenantIsolation()`):

| Table | Scope | Holds |
|---|---|---|
| `mcp_settings` | tenant | `enabled` (default false), `exposure` (`read_only`\|`all`\|`selected`), `exposed_tools` (text[] for `selected`), `connect_policy` (`everyone`\|`admins`\|`groups`), `connect_group_ids`, `updated_by`, `updated_at` |
| `oauth_clients` | platform (RLS-excluded, reason given) | CIMD clients: `client_id` (the metadata URL), name, `redirect_uris`, logo URI, `fetched_at`, `last_used_at`. A cache of the document, refetched after 24 h |
| `oauth_requests` | platform, short-lived | Pending authorize requests (10 min) and authorization codes (hash, 60 s, single-use, bound to the client, redirect URI, PKCE challenge, resource, user, tenant and scopes). Swept by the daily cron |
| `mcp_grants` | tenant | user, client, scopes, `created_at`, `last_used_at`, `expires_at` (absolute), `revoked_at`, `revoked_by`, `revoke_reason` |
| `mcp_tokens` | tenant | grant, `kind` (`access`\|`refresh`), hash, `expires_at`, `rotated_from`, `used_at` |
| `mcp_tool_calls` | tenant | as D15 |

Remembered consent is the live grant itself: reconnecting the same client to the same
organisation, with no wider scopes, skips the consent click.

## The authorization server

All of it lives in core, is mounted before the mount table, and lives under the deployment gate.

| Endpoint | Behaviour |
|---|---|
| `GET /.well-known/oauth-protected-resource` and `…/mcp` | `resource: <APP_URL>/mcp`, `authorization_servers: [<APP_URL>]`, `scopes_supported: ["mcp:read","mcp:write"]`, `bearer_methods_supported: ["header"]`, `resource_name: <APP_NAME>` |
| `GET /.well-known/oauth-authorization-server` and `/.well-known/openid-configuration` | `issuer` and the endpoints; `response_types_supported: ["code"]`; `grant_types_supported: ["authorization_code","refresh_token"]`; `code_challenge_methods_supported: ["S256"]`; `token_endpoint_auth_methods_supported: ["none"]`; `client_id_metadata_document_supported: true`; `authorization_response_iss_parameter_supported: true`; `revocation_endpoint`; `scopes_supported`. There is no `registration_endpoint` |
| `GET /oauth/authorize` | Fetch or validate the CIMD client: an https `client_id`, a document no larger than 5 KB, a 10 s timeout, public addresses only, `client_id` equal to the URL, and `redirect_uri` among its `redirect_uris` (loopback: any port). Also checks `response_type=code`, `code_challenge_method=S256`, `resource` equal to our `/mcp` (else `invalid_target`), the requested scopes and `state`. Errors redirect only to a validated `redirect_uri`, with `iss`; before validation they render an error page. **No session → `/login?returnUrl=…`**, so every sign-in method and its `ssoPolicy`, `SIGNUP_MODE` and blocking apply. Then 302 to `/oauth/consent?request=<id>` |
| SPA `/oauth/consent` | Kit chrome, `frame-ancestors 'none'`. It shows "<Client> wants to use <APP_NAME> as you". The client's name and logo are shown as "claims to be", next to the **verified host of its `client_id`** and the redirect host, with a warning when only loopback redirects are registered. Then the organisation picker, listing only organisations where MCP is on, the person may connect and they aren't support; it is hidden under single-tenancy. Then the scopes ("read" and, if asked, "make changes"), the tools that will be available, and Approve / Deny |
| `POST /oauth/consent` | JSON with the cookie, so CSRF applies. Re-checks everything from authorize against the stored request. Writes the grant and the code. Answers `{ redirectTo }` with `code`, `state` and `iss`; a deny carries `error=access_denied` and `iss` |
| `POST /oauth/token` | Form-encoded; public clients only (`none`). `authorization_code`: PKCE verifier, client, redirect URI and resource must match the code; the code is single-use. `refresh_token`: rotate, and if the presented token has already been rotated, revoke the grant. Answers with an access token (`mcpat_…`, 60 min), a refresh token (`mcprt_…`) and the scope. `invalid_grant` for anything expired or revoked. Fast: one transaction |
| `POST /oauth/revoke` | RFC 7009, for either token kind |

**Resolving a token on `/mcp`:**
1. Hash the bearer token.
2. In one query, join token → grant → user → membership → tenant → `mcp_settings` → connect policy.
3. **401** `invalid_token` with the challenge when the token is unknown, expired or revoked, or the grant has lapsed.
4. **403** with the reason when any of these hold. They are never 401, so clients don't loop through re-authorisation:
   - the person is blocked or no longer a member;
   - the tenant is suspended;
   - MCP is off;
   - the person no longer satisfies the connect policy;
   - the role is now support.
5. Build the `AuthContext` (role, groups, features, CASL) exactly as for a cookie request.
6. Touch `last_used_at` at most once a minute, in `waitUntil`.

**Lifecycle hooks.** Removing or blocking a member revokes their grants in that tenant, in the same
transaction, as `revokeEveryInvitationIssuedBy` does. Changes to a role, group or connect policy
need no hook, because every call re-reads them.

## `/mcp`

- **Transport:**
  - stateless Streamable HTTP, POST only; GET and DELETE answer 405;
  - JSON responses, with no SSE in v1;
  - `server/discover`, plus the 2025-11-25 `initialize` path;
  - header and body must agree (`Mcp-Method`, `Mcp-Name`), else 400 with -32020.
- **Mount and transport-level checks:**
  - before the mount table, under `jsonBodyLimit`;
  - its own CORS: any origin, no credentials, `WWW-Authenticate` exposed;
  - Origin: absent is allowed; when present, it must be ours or allow-listed (*spike*: which origins the browser-based clients send);
  - `/mcp` and `/oauth` are added to the API prefixes.
- **`serverInfo` and instructions** use `APP_NAME` and the organisation name. The instructions say that tool results are data from the organisation's documents, not instructions.
- **`tools/list`:**
  - `toolsFor('mcp', ctx)`, filtered by `surfaces`, the `mcp` block, the exposure mode, approval (D8), the token's scopes and the tool's own availability (e.g. `lookup_facts` needs `knowledge-facts`);
  - stable order, `cacheScope: "private"`, `ttlMs` about 60 s;
  - annotations as in D5;
  - `outputSchema` when declared.
- **`tools/call`:**
  - look the tool up in the filtered list, so an unexposed tool is "unknown tool";
  - check the scope (a missing `mcp:write` gives 403 `insufficient_scope`);
  - check the rate limits (D16);
  - validate the arguments with the tool's zod schema;
  - run the handler with the person's `ToolCtx`: `scope`, `can`, `features`, and `requesterUrls: []`, because the client's model typed the request, not a person in our UI;
  - wrap tenant-authored text in the untrusted notice, and cap the answer at 60k characters;
  - return `structuredContent` alongside text when an `outputSchema` is declared;
  - turn `ApiError` into `isError` with a hint;
  - write the call log row and close the span.

## Admin and member UI

**Settings → MCP** (`manage McpSettings`: admins and owners; hidden when the deployment flag is off):
- An on/off switch, and the server URL to copy.
- Setup snippets for each supported client. They name the server from `APP_NAME` and list the supported clients honestly (CIMD-capable clients in v1).
- **Who can connect:** everyone, admins, or chosen groups.
- **Exposure:** All read-only (default), Enable all (with a confirmation that clients can make changes as their users), or Selected.
- **Tools,** grouped by provider (Knowledge, then each plugin). Each shows its read-only or writes badge, its annotations and its 30-day call count. Approval-gated tools are greyed out with the reason.
- **Connected clients:**
  - per grant: person, client (name and verified host), scopes, connected, last used, 30-day calls, and Revoke;
  - "Revoke all".

**Profile → Connected apps:** a person's own grants across organisations, with Revoke.

**Activity:**
- `mcp.enabled` and `mcp.disabled`;
- `mcp.exposure_changed` and `mcp.connect_policy_changed`;
- `mcp.client_connected`;
- `mcp.client_revoked`, carrying who revoked it and the reason.

## Plugin seam

- `ServerPlugin.tools` (D11), each tool with `surfaces` and `mcp` (D5). `defineTool` in
  `@/plugins/api` carries both. A plugin's MCP tools need nothing else: no mount and no auth of
  their own.
- `@testkit` gains `callMcpTool(plugin, tool, { as, tenant, scopes })` and an MCP test token
  helper, so a plugin proves its tools' scoping and visibility in its own tests.
- `plugin check` rules:
  - tool names must be unique across core and plugins and match MCP's name pattern;
  - no plugin mount or `apiPrefix` on the reserved paths;
  - a warning on `agentTools`;
  - a warning on "Rocketflare" in tool text.
- `example-feature`'s `list_example_notes` gets an `mcp` block, as the reference.
- Docs to update:
  - CONCEPTS §16;
  - `apps/web/src/plugins/CLAUDE.md`;
  - `rf-plugin/reference.md`;
  - `docs/plugin-api.md`, regenerated.

## Threat model (`docs/THREAT-MODEL.md`)

**New actors:**
- **An OAuth client:** untrusted, acting with one person's consent, within one organisation and the granted scopes.
- **The client's model:** steerable by any tool result.

**New assets:** authorization codes, access and refresh tokens, and grants.

**Promises:**
- The tenant comes from the grant only.
- Every admission rule applies at `/authorize`, because sign-in goes through the normal login.
- Revocation takes effect on the next call.
- The CIMD fetch never reaches private addresses.
- There is no open redirect.
- PKCE is mandatory.
- Reusing a refresh token kills the grant.
- Visibility and CASL are identical to the HTTP routes.
- An unexposed tool can't be called.
- Tool results can't widen scope or change the organisation.
- Rate limits and cost caps hold over MCP.
- Support users can't connect.

## Tests

- **Spec:**
  - the metadata documents;
  - the 401 challenge, and 403 `insufficient_scope` naming both scopes;
  - -32020 on a header mismatch;
  - 405 on GET and DELETE;
  - the Origin rule;
  - both protocol versions.
- **OAuth:**
  - PKCE required and verified;
  - an exact redirect URI, and the loopback port rule;
  - `invalid_target`;
  - a code is single-use and expires in 60 s;
  - refresh rotation, and reuse revoking the grant;
  - `iss` on every authorization response;
  - CIMD: a mismatched id, a private address, an oversized document, a timeout and a `redirect_uri` outside the document are all refused;
  - revoke;
  - the idle and absolute limits.
- **Admission:**
  - a cookie session from each sign-in mode, then a full authorize;
  - `ssoPolicy` refusal, `SIGNUP_MODE`, a blocked user, IdP-managed tenancy with no membership;
  - support refused;
  - the connect policy.
- **Visibility conformance (D6):**
  - an outsider and an insider of a group, a group-only document, every exposed core tool;
  - no leak of text, facts, entity names or citations;
  - results equal to the HTTP route's.
- **Isolation:**
  - a grant in A never reaches B;
  - MCP off gives 403;
  - an unexposed tool is unknown;
  - member removal kills the grant;
  - suspension stops calls;
  - an API key or a CLI key on `/mcp` is refused.
- **Exposure:** each mode; a new plugin tool under each mode; approval tools never listed.
- **Plugins:** a fixture plugin's tool listed and filtered; a reserved mount refused; the `agentTools` alias still works.
- **Branding (D18):** `APP_NAME="Acme Tools"`, and no `/rocketflare/i` in any MCP or OAuth response.
- **Limits:** the per-grant and per-tenant caps answer with tool errors; the cost cap holds.
- **Real clients** (a manual checklist in the PR): Claude Code, claude.ai and ChatGPT through a cfld tunnel.

## Delivery

| Step | Contents |
|---|---|
| **Spike** (thrown away) | SDK v2 + hono on Workers: bundle size, `build:api` clean. Both protocol versions against Claude Code, claude.ai and ChatGPT over a cfld tunnel with a hard-coded token. Two connections to one URL (D2). Cursor and VS Code CIMD status. `global_fetch_strictly_public` side effects. The Origin values. Claude's refresh cadence against `authRateLimit` |
| **PR A: tools and server** | `ServerPlugin.tools` + alias, `surfaces`, the `mcp` block, `toolsFor`. The `/mcp` transport with filtering, the untrusted wrapper, the cap, limits, the call log and tracing. `mcp_settings`, and Settings → MCP (switch, who can connect, exposure, tools). The visibility conformance and branding tests. A test-only token injector so everything is testable without OAuth |
| **PR B: authorization server** | The metadata documents, authorize, consent, token, refresh rotation, revoke and CIMD. Grants, tokens and lifecycle hooks. Connected clients and Connected apps. The threat model |
| **PR C: plugins** | example-feature's MCP block, `@testkit` `callMcpTool`, the `plugin check` rules, plugin-api docs. An `rf-how-do-i` entry (connect a client, expose a plugin tool) |
| **Release** | `/rf-security` standard over the diff (budget agreed then), fixes, then the tag. Docs: a CONCEPTS section with its known gaps, SETUP (turning it on), DEPLOY (the feature flag and the vars), `rules/api.md` (the mount order), `unreleased.md` |
| **Plugins release** | Analytics cube tools through `tools`; its `/mcp` removed; `minKit` raised |
| **Rocketpod** | After its 0.40 catch-up |

## Later

- **Approval tools through elicitation** (`input_required`), for clients that declare it, plus
  inbox asks for approvers who are someone else.
- **Agents as tools,** ideally on the Tasks extension.
- **Static clients and DCR,** only if clients that lack CIMD matter.
- **Enterprise:** ID-JAG (`jwt-bearer`, Enterprise-Managed Authorization) and the generalised
  outside-authorization-server mode from Rocketpod. That generalisation covers OIDC discovery, a
  configurable `typ`, `aud` and identity claim, matching people on `iss`+`sub`, and treating a
  missing `email_verified` as unverified.
- **Resources and prompts,** and MCP apps.
