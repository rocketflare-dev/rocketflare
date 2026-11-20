---
version: unreleased
previous: 0.40.0
date: null
breaking: false
migrations: ["MCP server tables: mcp_settings, mcp_grants, mcp_tokens, mcp_tool_calls"]
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
- `example-feature` declares `tools`.

The MCP server itself, at `/mcp` and `/mcp/t/<slug>` (`docs/CONCEPTS.md` §19), shipped dark behind the environment-gated `mcp` flag:

- `apps/web/src/api/routes/mcp.ts` serves stateless Streamable HTTP through `@modelcontextprotocol/server` (a new dependency), mounted before the mount table with its own CORS, outside the global one. A request needs an MCP access token; `services/mcp/caller.ts` resolves it to the person's membership (`isGlobalAdmin` always false) and answers 401 with a `WWW-Authenticate` challenge or 403 `blocked`, `tenant_suspended`, `mcp_disabled` or `mcp_not_allowed`.
- `/api/mcp/settings|tools|calls` (`manage McpSettings`, owners and admins) hold an organisation's switch (off by default), exposure (`read_only` by default) and who may connect.
- Four tenant tables in `apps/web/src/db/schema/mcp.ts`: `mcp_settings`, `mcp_grants`, `mcp_tokens` and `mcp_tool_calls` (pruned nightly after `MCP_CALL_RETENTION_DAYS`).
- New optional vars: `MCP_GRANT_IDLE_DAYS`, `MCP_GRANT_MAX_DAYS`, `MCP_CALL_RETENTION_DAYS`, `MCP_CALLS_PER_GRANT_PER_MINUTE`, `MCP_CALLS_PER_TENANT_PER_MINUTE`.
- `CORE_FEATURES` gains `mcp`, `CORE_SUBJECTS` gains `McpSettings`, and `ERROR_CODES` gains `invalid_token`, `mcp_disabled` and `mcp_not_allowed`.
- `/mcp`, `/mcp/*`, `/oauth`, `/oauth/*` and `/.well-known/oauth-*` are reserved for core: a plugin declaring one as a mount, an `apiPrefixes` entry or a public mount stops the app at load, naming the plugin.
- `tenantAuthContext(cfg, input)` is extracted from `middleware/auth.ts` and exported; the API-key path uses it.
- Settings → MCP (`ui/pages/settings/Mcp.tsx`, `hooks/useMcp.ts`, the `mcp` query-key family) — a new `mcp` settings tab, shown only where the deployment ships `mcp` and to `manage McpSettings`.

## How to apply

1. In every server plugin of your own that declares `agentTools:`, rename the key to `tools:`; the signature is unchanged. `pnpm plugin check` lists each such plugin as a `warn:` line until it is renamed.
2. In app code that calls `buildAgentTools(ctx)` to hand tools to chat or to an agent run, call `toolsFor('chat', ctx)` or `toolsFor('agents', ctx)` from `apps/web/src/api/services/agents/tools` instead, so that a tool's `surfaces` is honoured. Leave an app's own additions inside `buildAgentTools`.
3. In a test that mocks `@/api/services/agents/tools` to replace `buildAgentTools` for chat or agent runs, mock `toolsFor(surface, ctx)` instead — chat and the agent runtime no longer reach `buildAgentTools` through the module export.
4. Run `pnpm install`. Add `apps/web/src/db/schema/mcp.ts` and export it from `apps/web/src/db/schema/index.ts`, run `pnpm db:generate --name kit-mcp-server`, read the SQL and run `pnpm db:migrate`.
5. Add `"/mcp"` and `"/mcp/*"` to `run_worker_first` in BOTH tomls.
6. If an installed plugin of yours mounts `/mcp` (the analytics plugin's drizzle-cube endpoint did), upgrade it to a release that offers its tools through `tools` instead before upgrading the kit; the app refuses to start while a plugin claims a reserved path.
7. To ship the server, add `mcp` to `FEATURES_ENABLED` in both tomls (and `.dev.vars` locally), then turn it on per organisation at Settings → MCP (`SETUP.md` §2.10).
8. If an app role of yours should manage MCP settings, grant it `manage McpSettings` in `permissions/abilities.ts`; the kit grants owners and admins only, never support.

## Conflicts to expect

- `apps/web/src/api/services/agents/tools/index.ts` → `toolsFor` and `pluginTools` added, plugin builders read through `pluginTools` → keep your own tools in `buildAgentTools` and take the kit's additions.
- `apps/web/src/api/middleware/auth.ts` → the API-key branch now builds its context through `tenantAuthContext` → take the kit's version and re-apply any change of yours to that branch inside `tenantAuthContext`.
- `apps/web/src/ui/pages/settings/tabs.ts`, `SettingsLayout.tsx`, `ui/lib/query-keys.ts` → an `mcp` tab, its content entry and an `mcp` key family → keep your own tabs and keys alongside.
- `apps/web/src/api/index.ts` → `/mcp` mounted after `/api/invite`, `/api/mcp` added to the mount table, `assertNoReservedPluginPaths` after the public mounts → take the kit's lines.
- `apps/web/wrangler.toml`, `wrangler.staging.toml` → `/mcp` entries in `run_worker_first` → keep your own entries alongside.
- `apps/web/src/api/services/ai/chat-turn.ts`, `ai/chat-stats.ts`, `agents/runtime.ts`, `agents/replay.ts` → `buildAgentTools(` became `toolsFor('chat' | 'agents', ` → take the kit's line.

## Verify

1. `pnpm plugin check` prints no `declares \`agentTools\`` warning for a plugin you renamed.
2. `pnpm --filter @rocketflare/web exec vitest run --project config tests/config/tool-surfaces.test.ts` passes.
3. With `mcp` in `FEATURES_ENABLED`, `curl -si -X POST http://localhost:3001/mcp` answers 401 with `WWW-Authenticate: Bearer resource_metadata="…"`; without it, 404.
4. `pnpm gate` passes.
