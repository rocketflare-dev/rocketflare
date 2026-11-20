---
version: unreleased
previous: 0.40.0
date: null
breaking: false
migrations: []
areas: [api, config, docs]
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

## How to apply

1. In every server plugin of your own that declares `agentTools:`, rename the key to `tools:`; the signature is unchanged. `pnpm plugin check` lists each such plugin as a `warn:` line until it is renamed.
2. In app code that calls `buildAgentTools(ctx)` to hand tools to chat or to an agent run, call `toolsFor('chat', ctx)` or `toolsFor('agents', ctx)` from `apps/web/src/api/services/agents/tools` instead, so that a tool's `surfaces` is honoured. Leave an app's own additions inside `buildAgentTools`.
3. In a test that mocks `@/api/services/agents/tools` to replace `buildAgentTools` for chat or agent runs, mock `toolsFor(surface, ctx)` instead — chat and the agent runtime no longer reach `buildAgentTools` through the module export.

## Conflicts to expect

- `apps/web/src/api/services/agents/tools/index.ts` → `toolsFor` and `pluginTools` added, plugin builders read through `pluginTools` → keep your own tools in `buildAgentTools` and take the kit's additions.
- `apps/web/src/api/services/ai/chat-turn.ts`, `ai/chat-stats.ts`, `agents/runtime.ts`, `agents/replay.ts` → `buildAgentTools(` became `toolsFor('chat' | 'agents', ` → take the kit's line.

## Verify

1. `pnpm plugin check` prints no `declares \`agentTools\`` warning for a plugin you renamed.
2. `pnpm --filter @rocketflare/web exec vitest run --project config tests/config/tool-surfaces.test.ts` passes.
3. `pnpm gate` passes.
