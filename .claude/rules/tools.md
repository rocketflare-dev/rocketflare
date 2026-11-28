---
paths:
  - apps/web/src/api/services/agents/tools/**
  - apps/web/src/plugins/**/tools/**
  - apps/web/src/plugins/**/index.ts
  - apps/web/src/api/services/mcp/**
---

# Writing a tool (chat, agent runs and MCP)

One `Tool` serves three surfaces: chat, agent runs and the MCP server. An MCP client is a model
outside the app, acting as one person, so write every tool for it. In a plugin, `ServerPlugin.tools`
(`apps/web/src/plugins/CLAUDE.md`, `tools(ctx)`). In the app, append it in `buildAgentTools`
(`apps/web/src/api/services/agents/tools/index.ts`). How the server lists and runs it:
`docs/CONCEPTS.md` §19. Connecting a client and testing by hand: `/rf-mcp`.

## Checklist

- **Who and where come from `ToolCtx`, never from arguments.** The tenant is `ctx.tenantId` /
  `ctx.scope.tenantId`. The person is `ctx.requester` (`null` for a run nobody started). The
  person's rights are `ctx.can(...)`. The schema has no `tenantId`, `userId`, `email` or
  organisation input. Every query filters by `ctx`'s tenant.
- **Read group-visible rows through the visibility helpers.** Use `visibleDocuments(scope)`
  (`apps/web/src/api/services/access.ts`, the documents predicate the core tools use). Use
  `searchKnowledge(ctx, …)` from `@/plugins/api` for knowledge. For your own restrictable rows,
  build the predicate with `sharedWithMyGroups` (`apps/web/src/plugins/api/access.ts` says how).
  Never run a raw query over `documents`. Never use `fullAccessScope` in a tool. A hidden row and
  an unknown id get the same answer.
- **`sideEffects: true` on every tool that writes, sends or charges.** That flag makes it
  `mcp:write`: hidden under the default `read_only` exposure, listed only under "all" or when
  ticked, and refused with 403 `insufficient_scope` to a read-only token. A write tool without the
  flag is listed to every read-only connection. Never set `mcp: { scope: 'mcp:read' }` on a tool
  that writes. Offer a write tool only when `ctx.can('manage', YOUR_SUBJECT)` allows it, never
  because `scope.bypass` is set. `durable: true` only if the handler passes
  `call.idempotencyKey` to a system that deduplicates on it.
- **`egress` on every tool: can this tool send your data outside your organisation — by email, a
  webhook, a web request, or by publishing a page?** Answer it from what the HANDLER itself does.
  `true`: it emails, calls a webhook, fetches a URL, calls a remote MCP tool, or writes something
  another organisation or the public can see (a published page). `false`: it only reads or writes
  this organisation's own records. The app's own AI providers are part of the app: calling the
  embeddings model, the reranker or the chat model is not egress (`search_knowledge` is `false`).
  Which surfaces a tool is offered on is a separate question (`surfaces`, the MCP rules); never
  fold it into `egress`. Never default it to `false` to silence the warning. Optional for now: the
  value check calls each `tools(ctx)` with a stub context and WARNS for a tool without it, in
  `pnpm gate` and `pnpm plugin check`; a later release makes it required.
- **`readsContent: false` only for a tool that returns no organisation text** (a terminal tool, a
  count, an id). Absent reads as `true`: what it returns is private and untrusted, because a
  document or a message can carry instructions somebody planted.
- **Build tools before you query.** The value check's stub context has no database: a `tools(ctx)`
  that reads a settings row first is unreadable there, and `plugin check` falls back to reading
  your `defineTool({ … })` calls statically, so write `egress:` in the call itself.
- **Tools that never reach MCP.** A terminal tool (no handler) and an approval-gated one
  (`requiresApproval[When]`) are never offered there (`offeredOn` in
  `apps/web/src/api/services/agents/tools/surfaces.ts`). Do not work around this. A write that
  needs a person's yes stays off MCP.
- **`surfaces`** keeps a tool off a surface (absent = all three). Use `['mcp', 'agents']` for a
  tool that chat should not pay prompt tokens for.
- **The `mcp` block** only changes what a client is shown. `title` is a human name for the list.
  `annotations` are hints merged over the defaults from `sideEffects`/`durable`. They are never a
  security boundary. Set `openWorldHint: true` on a tool that reaches the web. `outputSchema`
  promises the JSON object the handler returns. A dead end (`{ error }`), a non-object or an
  answer over the cap goes back as an error result with no `structuredContent`.
- **Names.** Match `^[A-Za-z0-9_-]{1,64}$` (`MCP_TOOL_NAME_PATTERN`). Use snake_case with your
  namespace first (`orders_find`). Never a core name (`CORE_TOOL_NAMES`: `search_knowledge`,
  `get_document`, `list_documents`, `lookup_facts`) or another plugin's. A clashing plugin tool is
  dropped at runtime and fails `pnpm plugin check`. App tools are not checked: check them by hand.
- **Descriptions and titles are shown to the client's model under the app's name.** Name no
  brand, and never "Rocketflare" (`plugin check` warns). No secrets, no internal ids or hosts. No
  instructions beyond when to call the tool and what it returns.
- **Results are untrusted data to the client.** Never return a secret, a token, a key, or anyone
  else's private data. Keep answers bounded: take a `limit`, page long text, and say what was
  left out. The server caps every answer at `MCP_RESULT_MAX_CHARS` (60 000), so a long answer is
  cut off, not paged. Do not build links or markdown from user content unless the tool needs
  them. A tool that fetches the web reads only URLs in `ctx.requesterUrls` or URLs its own search
  returned. Over MCP, `requesterUrls` is always empty.
- **Cost.** MCP limits each tool by call count: per connection, per person and per organisation
  each minute. A call's model spend lands in `ai_usage` under the tool's own feature
  (`recordUsage`), under the tenant's caps, with no MCP tag (CONCEPTS §19 known gaps). Keep the
  spend of one call small and bounded: no unbounded loops of model or embedding calls.
- **Errors.** A dead end is an answer, not a throw. Return JSON `{ error: '<stable_code>', hint }`,
  as the core tools do, so the model can act on it. For a refusal, throw one of the HTTP error
  classes from `@/plugins/api` (`ForbiddenError`, `NotFoundError`, `ConflictError`,
  `BadRequestError`…) with a stable code. It reaches the client as `{ error: code, message }`, so
  its message is client text: no SQL, no stack, no internal names. Anything else thrown becomes a
  generic `tool_failed`, and the server logs it.

## Tests you owe

Use `callMcpTool(db, '<tool>', { as, tenant, args?, scopes?, exposure? })` from
`@testkit/integration`. It goes through the real `/mcp`. Copy `example-feature`'s "over MCP" cases
(`apps/web/src/plugins/example-feature/tests/api/example-feature.test.ts`). Prove that:

1. a member of a SECOND organisation is offered the tool and sees none of the first's rows;
2. for group-visible rows, a member outside the group does not see them;
3. a write tool is `listed: false` under `exposure: 'read_only'`, and with `scopes: ['mcp:read']`
   the call rejects (`InsufficientScopeError`, the 403 step-up).

## Never

- Mount a route on `/mcp`, `/oauth/*` or `/.well-known/oauth-*`. The host refuses it at load. A
  feature reaches MCP only as a tool.
- Accept an API key, a cookie or a CLI key for MCP, or resolve the caller yourself (a token, a
  header) inside a tool. `ToolCtx` already is the caller; gate on `ctx.can`.
- Add a tool that takes a tenant id, or a "list all organisations" tool.
