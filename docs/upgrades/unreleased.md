---
version: unreleased
previous: 0.40.0
date: null
breaking: false
migrations: ["MCP server tables: mcp_settings, mcp_grants, mcp_tokens, mcp_tool_calls", "MCP authorization server: oauth_clients, oauth_requests, mcp_tokens.successor_sealed, mcp_grants.activated_at"]
areas: [api, config, db, shared, ui, docs]
touches_surfaces: [example-feature, feature-chat, feature-agents]
requires_surfaces: []
manual: false
---

## What changed

The MCP server's tool seam: one tool list for chat, agent runs and MCP, filtered by `toolsFor(surface, ctx)`, with `Tool.surfaces`, a `Tool.mcp` block, and `ServerPlugin.tools` replacing `agentTools` (still read, with a warning).

- `Tool` (and `defineTool` in `@/plugins/api`) gains `surfaces?: ('chat' | 'agents' | 'mcp')[]` (absent = all) and `mcp?: { title?, annotations?, outputSchema?, scope? }`; `@/plugins/api` exports the types `ToolSurface`, `ToolMcpOptions`, `McpToolAnnotations` and `McpToolScope`.
- `toolsFor(surface, ctx)` in `services/agents/tools` is the one filter; chat, the chat inspector, agent runs and replay call it. `buildAgentTools(ctx)` still builds the unfiltered list and is still where an app appends a kit-wide tool.
- On `mcp`, a terminal tool (no handler) and an approval-gated tool (`requiresApproval[When]`) are never offered; `mcpToolProfile(tool)` derives a tool's MCP scope (`mcp:read`, or `mcp:write` for `sideEffects`) and annotations (`docs/CONCEPTS.md` §9 "Chat").
- `ServerPlugin.agentTools` is renamed `ServerPlugin.tools`, same signature. `agentTools` is still read when `tools` is absent and is marked deprecated; `pnpm plugin check` warns on it, naming the replacement.
- `example-feature` declares `tools`, and `list_example_notes` carries the reference `mcp` block (a title, `openWorldHint: false`).
- Tool names are one rule for every surface, `MCP_TOOL_NAME_PATTERN` in `@rocketflare/shared/mcp`: 1–64 of `A–Z a–z 0–9 _ -` (no `.`, which the chat models refuse). `admittedPluginTools` in `services/agents/tools` drops and logs a plugin tool whose name breaks it, is a core tool's (`CORE_TOOL_NAMES`) or an earlier plugin's.
- `pnpm plugin check` fails a plugin tool name that breaks the rule or collides (read from `defineTool({ name })` literals and `const`s), fails a reserved-path `apiPrefixes` entry or `['/mcp', …]` mount tuple, and warns on "Rocketflare" in a tool's `title` or `description`.
- `@testkit/integration` exports `callMcpTool(db, tool, { as, tenant, args?, scopes?, exposure?, exposedTools? })` — turn MCP on, connect as `as`, list and call over the real `/mcp`, answering `{ listed, listing, isError, text, json, structured }` — plus `connectMcp`, `enableMcp`, `mcpClient`, `mcpTestEnv` and `toolJson`.

For plugin authors: a tool reaches MCP clients through `ServerPlugin.tools` alone — no mount, no auth of its own — and a plugin proves it scopes there with `callMcpTool` as a member of a second organisation. The opt-in analytics plugin's own `/mcp` (drizzle-cube, API-key auth) is now refused at load; its next plugins release moves its cube tools onto `tools` with `surfaces: ['mcp', 'agents']`, drops the mount and drops its vite `coreEdits` `/mcp` proxy line, which the kit's own proxy replaces.

The MCP server itself, at `/mcp` and `/mcp/t/<slug>` (`docs/CONCEPTS.md` §19), shipped dark behind the environment-gated `mcp` flag:

- `apps/web/src/api/routes/mcp.ts` serves stateless Streamable HTTP through `@modelcontextprotocol/server` (a new dependency), mounted before the mount table with its own CORS, outside the global one. A request needs an MCP access token; `services/mcp/caller.ts` resolves it to the person's membership (`isGlobalAdmin` always false) and answers 401 with a `WWW-Authenticate` challenge or 403 `blocked`, `tenant_suspended`, `mcp_disabled` or `mcp_not_allowed`.
- `/api/mcp/settings|tools|calls` (`manage McpSettings`, owners and admins) hold an organisation's switch (off by default), exposure (`read_only` by default) and who may connect.
- Four tenant tables in `apps/web/src/db/schema/mcp.ts`: `mcp_settings`, `mcp_grants`, `mcp_tokens` and `mcp_tool_calls` (pruned nightly after `MCP_CALL_RETENTION_DAYS`).
- New optional vars: `MCP_GRANT_IDLE_DAYS`, `MCP_GRANT_MAX_DAYS`, `MCP_CALL_RETENTION_DAYS`, `MCP_CALLS_PER_GRANT_PER_MINUTE`, `MCP_CALLS_PER_TENANT_PER_MINUTE`.
- `CORE_FEATURES` gains `mcp`, `CORE_SUBJECTS` gains `McpSettings`, and `ERROR_CODES` gains `invalid_token`, `mcp_disabled` and `mcp_not_allowed`.
- `/mcp`, `/mcp/*`, `/oauth`, `/oauth/*` and `/.well-known/oauth-*` are reserved for core: a plugin declaring one as a mount, an `apiPrefixes` entry or a public mount stops the app at load, naming the plugin.
- `tenantAuthContext(cfg, input)` is extracted from `middleware/auth.ts` and exported; the API-key path uses it.
- Settings → MCP (`ui/pages/settings/Mcp.tsx`, `hooks/useMcp.ts`, the `mcp` query-key family) — a new `mcp` settings tab, shown only where the deployment ships `mcp` and to `manage McpSettings`.

The app is its own OAuth 2.1 authorization server for `/mcp`, in Postgres (`services/mcp/authorization.ts`, `routes/oauth.ts`):

- Discovery at `/.well-known/oauth-protected-resource[/mcp|/mcp/t/<slug>]`, `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration`; clients identify themselves by a Client ID Metadata Document (`services/mcp/cimd.ts` fetches it behind a guard and caches it in `oauth_clients`). No dynamic registration.
- `GET /oauth/authorize` → the app's own `/login` → `/oauth/continue` → the consent page `/consent` (a new SPA route) → `POST /oauth/consent` → a code → `POST /oauth/token` (`authorization_code`, `refresh_token` with rotation, reuse detection and a 30-second retry grace) and `POST /oauth/revoke`. PKCE S256 is mandatory.
- Two platform tables, `oauth_clients` and `oauth_requests`, both in `RLS_REVOKED_TABLES`; `mcp_tokens` gains `successor_sealed`, and `mcp_grants` gains `activated_at` — a consent's grant is a connection (listed, counted, `mcp.client_connected`) only once its code is redeemed, and the nightly retention deletes one never redeemed.
- A client metadata document is accepted when the client can act as a public client: `token_endpoint_auth_method` absent or `none`, or `none` among `token_endpoint_auth_methods_supported` (ChatGPT's document prefers `private_key_jwt` and lists `none`). Its `grant_types` and `response_types`, when present, must include `authorization_code` and `code`.
- Removing a member or blocking a person revokes their connections in the same transaction (`revokeMcpGrantsOf` in `members.ts`, `idp-tenancy.ts`, `admin.ts`).
- `/api/mcp/connections` (admins: list, revoke, `POST /revoke-all`) and `/api/mcp-connections` (a person's own, across organisations), shown as **Connected clients** in Settings → MCP and **Connected apps** in Profile (`ui/components/mcp/McpConnectionsTable.tsx`).
- Settings → MCP renders a tool description's `inline code` as code instead of showing the backticks.
- Fix, not MCP-specific: `pnpm dev:tunnel` never gave the Worker the tunnel's public URL. `scripts/tunnel-dev.mjs` passed `pnpm dev:api -- --var APP_URL:…`; pnpm 10 forwards the `--` literally and wrangler drops what follows, so the Worker kept `.dev.vars`'s localhost `APP_URL` for its redirects. It now passes `--var` with no `--` (`scripts/lib/tunnel-dev.mjs`).
- `docs/THREAT-MODEL.md` gains the OAuth client and its model as actors, the codes, tokens and grants as assets, and an "MCP promises" list.

## How to apply

1. In every server plugin of your own that declares `agentTools:`, rename the key to `tools:`; the signature is unchanged. `pnpm plugin check` lists each such plugin as a `warn:` line until it is renamed.
2. In app code that calls `buildAgentTools(ctx)` to hand tools to chat or to an agent run, call `toolsFor('chat', ctx)` or `toolsFor('agents', ctx)` from `apps/web/src/api/services/agents/tools` instead, so that a tool's `surfaces` is honoured. Leave an app's own additions inside `buildAgentTools`.
3. In a test that mocks `@/api/services/agents/tools` to replace `buildAgentTools` for chat or agent runs, mock `toolsFor(surface, ctx)` instead — chat and the agent runtime no longer reach `buildAgentTools` through the module export.
4. Run `pnpm install`. Add `apps/web/src/db/schema/mcp.ts` and export it from `apps/web/src/db/schema/index.ts`, run `pnpm db:generate --name kit-mcp-server`, read the SQL and run `pnpm db:migrate`.
5. Add `"/mcp"`, `"/mcp/*"`, `"/oauth"`, `"/oauth/*"` and the three discovery documents, each also with `/*` (`"/.well-known/oauth-protected-resource"`, `"/.well-known/oauth-authorization-server"`, `"/.well-known/openid-configuration"`), to `run_worker_first` in BOTH tomls; the parity test names any you miss. In `apps/web/vite.config.ts` proxy `/mcp`, `/oauth` and `^/\\.well-known/(oauth-|openid-configuration)` to the API port.
6. Add `apps/web/src/db/schema/oauth.ts` (export it from the schema index), add `oauth_clients` and `oauth_requests` to `RLS_REVOKED_TABLES`, run `pnpm db:generate --name kit-mcp-oauth`, read the SQL, run `pnpm db:migrate` — its grants phase revokes the app role from both.
7. If your app has its own path that deletes a `tenant_users` row or sets `users.blocked_at`, call `revokeMcpGrantsOf(tx, { userId, tenantId?, reason })` from `services/mcp/connections.ts` in the same transaction.
8. If your app already has a client route at `/consent`, or serves anything at `/oauth` or `/.well-known/openid-configuration`, move it: core owns them now.
9. If an installed plugin of yours mounts `/mcp` (the analytics plugin's drizzle-cube endpoint did), upgrade it to a release that offers its tools through `tools` instead before upgrading the kit; the app refuses to start while a plugin claims a reserved path.
10. To ship the server, add `mcp` to `FEATURES_ENABLED` in both tomls (and `.dev.vars` locally), then turn it on per organisation at Settings → MCP (`SETUP.md` §2.10).
11. Rename any tool of yours whose name has a `.`, is over 64 characters, or repeats a core or another plugin's tool name — `pnpm plugin check` names a plugin's; an app tool appended in `buildAgentTools` is not checked, so check those by hand. In a plugin with a tool, add an "over MCP" case with `callMcpTool` from `@testkit/integration` (copy `example-feature`'s).
12. If an app role of yours should manage MCP settings, grant it `manage McpSettings` in `permissions/abilities.ts`; the kit grants owners and admins only, never support.

## Conflicts to expect

- `apps/web/src/api/services/agents/tools/index.ts` → `toolsFor`, `pluginTools`, `CORE_TOOL_NAMES` and `admittedPluginTools` added, plugin builders read through `pluginTools` and admitted through `admittedPluginTools` → keep your own tools in `buildAgentTools` and take the kit's additions.
- `apps/web/src/api/middleware/auth.ts` → the API-key branch now builds its context through `tenantAuthContext` → take the kit's version and re-apply any change of yours to that branch inside `tenantAuthContext`.
- `apps/web/src/ui/pages/settings/tabs.ts`, `SettingsLayout.tsx`, `ui/lib/query-keys.ts` → an `mcp` tab, its content entry and an `mcp` key family → keep your own tabs and keys alongside.
- `apps/web/src/api/index.ts` → `/mcp` mounted after `/api/invite`, `/api/mcp` added to the mount table, `assertNoReservedPluginPaths` after the public mounts → take the kit's lines.
- `apps/web/wrangler.toml`, `wrangler.staging.toml` → `/mcp` entries in `run_worker_first` → keep your own entries alongside.
- `apps/web/src/api/services/members.ts`, `idp-tenancy.ts`, `admin.ts` → a `revokeMcpGrantsOf` call inside the removal and block transactions (`blockDeprovisioned` now runs in a transaction) → keep yours and add the kit's call.
- `apps/web/src/ui/App.tsx` → a `/consent` route → take the kit's line.
- `apps/web/scripts/tunnel-dev.mjs` → its children now come from `scripts/lib/tunnel-dev.mjs`, with no `--` before `--var` → take the kit's version.
- `apps/web/src/ui/pages/Profile.tsx` → a `ConnectedApps` panel after the sign-in methods → keep your own panels and add the kit's.
- `apps/web/src/api/services/ai/chat-turn.ts`, `ai/chat-stats.ts`, `agents/runtime.ts`, `agents/replay.ts` → `buildAgentTools(` became `toolsFor('chat' | 'agents', ` → take the kit's line.

## Verify

1. `pnpm plugin check` prints no `declares \`agentTools\`` warning for a plugin you renamed.
2. `pnpm --filter @rocketflare/web exec vitest run --project config tests/config/tool-surfaces.test.ts tests/config/mcp-plugin-seam.test.ts` passes.
3. With `mcp` in `FEATURES_ENABLED`, `curl -si -X POST http://localhost:3001/mcp` answers 401 with `WWW-Authenticate: Bearer resource_metadata="…"`, and `curl -s http://localhost:3001/.well-known/oauth-authorization-server` answers `"client_id_metadata_document_supported": true`; without it, both 404.
4. `pnpm gate` passes.
