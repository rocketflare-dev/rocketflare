---
name: rf-mcp
description: Turn on the app's MCP server, add an MCP tool to the app or a plugin, connect Claude (claude.ai, Desktop, Claude Code) or ChatGPT to it, and debug a connection or a tool that does not show up. Use when someone says "MCP", "connect Claude / ChatGPT / Claude Code to our app", "expose X to MCP", "add an MCP tool", "let an AI client use our data", or a client fails to connect, gets 401/403, or cannot see a tool.
argument-hint: "[enable | add-tool <what> | test | debug <symptom>]"
---

# MCP — turn it on, add a tool, connect a client, debug it

The app is an MCP server at `/mcp` (and `/mcp/t/<slug>`, the same server pinned to one
organisation). A client signs in with the app's own login through the app's own OAuth server, and
then acts as that one person in one organisation, with their permissions. How it works:
`docs/CONCEPTS.md` §19. Setup reference: `SETUP.md` §2.10.

**Do not coach a new route, an API key for the client, or a tool that takes a tenant id.** A feature
reaches MCP as a TOOL, declared once for chat, agent runs and MCP. You may run every step here
yourself, except two: editing a deployed toml's `FEATURES_ENABLED` needs the user's yes, and the
tunnel in §3 puts the dev instance on the internet, so explain that first.

## 1. Turn MCP on for a deployment

1. **Ship it.** Add `mcp` to `FEATURES_ENABLED` (comma-separated) in `apps/web/.dev.vars` for
   local use. For a deployed environment, add it to the `[vars]` of BOTH `apps/web/wrangler.toml`
   and `apps/web/wrangler.staging.toml`. Without it, `/mcp`, `/oauth/*`, the OAuth `.well-known`
   documents and `/api/mcp*` answer 404.
2. **The rollout.** `mcp` is environment-gated and on for every tenant where it ships. A global
   admin can narrow it per tenant at `/admin/feature-flags`.
3. **Settings → MCP**, as an owner or admin of each organisation:
   - turn it on (off by default);
   - **who can connect**: everyone, admins only, or chosen groups (owners and admins always can;
     support never can);
   - **exposure**: all read-only tools (default), "Enable all" (write tools too, after a
     confirmation), or Selected (tick each one);
   - copy the **server URL** shown there: `<APP_URL>/mcp/t/<slug>` under multi-tenancy, `/mcp`
     under single.
4. Verify: `curl -si -X POST <APP_URL>/mcp` answers 401 with a `WWW-Authenticate: Bearer
   resource_metadata="…"` header. A 404 means `mcp` is not in `FEATURES_ENABLED`.

## 2. Add a tool (the app or a plugin)

1. **Where.** In a plugin: `ServerPlugin.tools(ctx)` with `defineTool` from `@/plugins/api`. Copy
   `apps/web/src/plugins/example-feature/tools/list-example-notes.ts`. In the app: append it in
   `buildAgentTools` (`apps/web/src/api/services/agents/tools/index.ts`).
2. **Follow `.claude/rules/tools.md`.** It loads when you open a tool file. Settle with the user:
   - a namespaced snake_case name (`orders_find`);
   - whether it changes anything (`sideEffects: true` → needs `mcp:write`, hidden under the
     default exposure);
   - `surfaces` if it must stay off chat or agent runs;
   - an `mcp: { title, annotations }` block for how a client shows it.
   Its tenant and person come from `ToolCtx`, never from arguments.
3. **Write the tests.** Use `callMcpTool(db, '<tool>', { as, tenant })` from
   `@testkit/integration`. Cover a member of a second organisation (rows absent), a member outside
   the group for group-visible rows, and for a write tool `exposure: 'read_only'` (not listed)
   plus `scopes: ['mcp:read']` (the call rejects). The rules file lists them.
4. **Check the listing.** Run the gate (`pnpm gate`, or `pnpm web test:api` while iterating). Then,
   in Settings → MCP, the tool appears under its provider with its read-only/writes badge. A greyed
   tool shows why it cannot reach a client.

## 3. Test it with a real client

- **Automated first.** The `callMcpTool` cases go through the real `/mcp`, OAuth tokens and
  exposure included. No client is needed for them.
- **A real client needs a public https URL** to sign in. Locally that is the tunnel:

  ```bash
  pnpm web cfld setup   # once: picks a Cloudflare zone
  pnpm dev:tunnel       # cfld → :3000, the tunnel URL passed to the Worker as APP_URL
  ```

  **Say this to the user before starting it:** while the tunnel runs, the whole dev instance is
  public, and so is its password-less dev sign-in. Anyone with the URL can sign in as any user,
  read the local database and spend the keys in `.dev.vars` (`SETUP.md` §1.10). Use dummy data
  only, keep real provider keys out of `.dev.vars`, and stop the tunnel (Ctrl-C) when done.
- Turn MCP on in Settings → MCP on the tunnel host, and copy the URL shown there. Then:
  - **Claude Code:** `claude mcp add --transport http <name> <url>`, then `/mcp` in Claude Code to
    sign in;
  - **claude.ai / Claude Desktop:** Settings → Connectors → Add custom connector, paste the URL.
- **ChatGPT cannot connect to local `wrangler dev`.** chatgpt.com answers workerd's metadata fetch
  with 403. Test ChatGPT on staging, where a deployed Worker fetches it fine.
- Cursor and other clients with dynamic registration only cannot connect: the server accepts
  clients with a Client ID Metadata Document only.

## 4. Troubleshoot

| Symptom | Cause and fix |
|---|---|
| 404 on `/mcp` or `/.well-known/oauth-authorization-server` | `mcp` is not in `FEATURES_ENABLED` for this environment |
| 401 `invalid_token` + `WWW-Authenticate` | The TOKEN: unknown, expired, revoked, idle past `MCP_GRANT_IDLE_DAYS`, past `MCP_GRANT_MAX_DAYS`, or issued for another URL (`/mcp` vs `/mcp/t/<slug>`). The client signs in again |
| 403 `blocked` / `tenant_suspended` | The person is blocked, or the organisation is suspended |
| 403 `mcp_disabled` | The organisation's switch is off, or the `mcp` flag is off for this tenant. Connections are suspended, not revoked |
| 403 `mcp_not_allowed` | Not a member, a support role, or outside "who can connect" |
| 403 `insufficient_scope` on a call | A write tool and a read-only connection. The client asks again for `mcp:read mcp:write`, and the person consents again |
| tool error `rate_limited` | Over a per-minute cap: connection 60, person 120, organisation 600. Wait `retryAfterSeconds`, or raise `MCP_CALLS_PER_GRANT\|USER\|TENANT_PER_MINUTE` in BOTH tomls |
| A tool is not listed | Check its row in Settings → MCP (`unavailableReason`): `not_on_mcp` (its `surfaces`), `terminal` (no handler), `approval` (approval-gated tools never reach MCP). Not exposed: a write tool under the read-only exposure, or not ticked under Selected. Not in the list at all: the plugin's flag is off for the tenant (the builder returns `[]`), or the server log says `plugin tools failed` or `plugin tool left out` (a bad or taken name) |
| "The client metadata document could not be used" | The page never says why. The server log line `oauth: client metadata document refused` has the `reason` (`wrangler dev` output, or `wrangler tail` deployed) |
| claude.ai refuses a second connector at the same URL | It keeps one connector per URL. Use each organisation's own `/mcp/t/<slug>` |
| A call is missing from the call log | Calls the SDK refuses before the handler (bad arguments, unknown tool) are not logged |

Run `wrangler` from `apps/web`: `pnpm --filter @rocketflare/web exec wrangler tail`.
