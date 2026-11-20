# MCP server and its authorization server

An AI client connects at `/mcp` (or `/mcp/t/<slug>`, the same server pinned to one organisation)
and acts as one person in one organisation. The routes are thin: `../../routes/mcp.ts` (transport)
and `../../routes/oauth.ts` (OAuth endpoints and discovery). How it works and its known gaps:
`docs/CONCEPTS.md` §19. Writing a tool for it: `.claude/rules/tools.md`.

| File | What |
|---|---|
| `server.ts` | `buildMcpServer(ctx, tools)` — a fresh SDK `McpServer` per request. `runMcpToolCall` runs every call the same way: three rate limits → handler → the untrusted-data notice + `capResult` (`MCP_RESULT_MAX_CHARS`) → `structuredContent` for an `outputSchema` → call log + span. The write-tool scope challenge. `mcpInstructions` |
| `caller.ts` | `resolveMcpCaller` — bearer → access token → grant, bound to the URL it was made on. `resolveMcpMember` — the one admission rule, re-read on every call and at consent. `McpChallengeError` (401 + `WWW-Authenticate`) |
| `tools.ts` | `mcpToolsFor` — `toolsFor('mcp', …)` built from the member's own scope, CASL, flags and `requester`, with empty `requesterUrls`, then filtered by `exposedOverMcp`. Used by `/mcp` and the consent screen |
| `settings.ts` | `mcp_settings` read/upsert (no row = off, `read_only`, `everyone`). `exposedOverMcp` and `isReadOnlyTool` (the ONLY exposure decision), `mayConnect` (the connect policy) |
| `listing.ts` | Settings → MCP's tool list: every tool, its provider, `unavailableReason`, `exposed`, 30-day call counts |
| `tokens.ts` | Grants and token pairs (`mcpat_` / `mcprt_`, SHA-256 at rest). `findMcpAccessToken`, `mcpResourceUrl`, idle and absolute lapse, `touchMcpGrant` |
| `authorization.ts` | The OAuth 2.1 server: authorize → `/login` → consent → code → token (`authorization_code`, rotating `refresh_token` with reuse detection and `MCP_REFRESH_RETRY_GRACE_MS`), revoke, remembered consent |
| `cimd.ts` | Client ID Metadata Documents: the guarded fetch, validation and the `oauth_clients` cache. `CIMD_UNUSABLE` |
| `seal.ts` | Seals a spent refresh token's successor pair under a key derived from that token's plaintext (the retry grace) |
| `connections.ts` | Lists and revokes connections (admin: the organisation's; a person: their own). `revokeMcpGrantsOf` (member removal and block) |
| `retention.ts` | `runPruneMcp` — the nightly sweep: old calls, expired tokens, requests and codes, unredeemed grants, stale client documents |

## Invariants — each has a test; keep it passing, never loosen it

- **An OAuth access token is the only credential on `/mcp`.** No cookie, API key or CLI key. Any
  other bearer misses in `findMcpAccessToken` and gets the same 401 as an unknown token. `/mcp` is
  mounted outside `authMiddleware` and outside the global CORS (its own CORS: any origin, no
  credentials). Keep it registered before the mount table in `api/index.ts`. `isMcpPath`
  (`middleware/cors.ts`) must cover every path with its own CORS, with or without a trailing slash.
  Tests: `tests/api/mcp-server.test.ts` ("the transport", "the 401 challenge"),
  `tests/api/security/mcp-cors-paths.test.ts`.
- **Admission is re-read on every call** in `resolveMcpMember`. It checks the block, the
  membership, the tenant's status, the support role (refused), the `mcp` flag, the organisation's
  switch and the connect policy. `isGlobalAdmin` is always `false`. Cache none of it on the grant.
  A token problem is a 401 with the challenge. A person problem is a 403 with a code (`blocked`,
  `tenant_suspended`, `mcp_disabled`, `mcp_not_allowed`), which must never send the client round
  the sign-in loop again. Tests: `mcp-server.test.ts` ("the 403s"),
  `tests/api/mcp-oauth-admission.test.ts`.
- **Removing a member or blocking a person revokes their grants in the same transaction.** Any new
  path that deletes a `tenant_users` row or sets `users.blocked_at` calls `revokeMcpGrantsOf(tx,
  …)`. The callers today: `services/members.ts`, `services/admin.ts`, `services/idp-tenancy.ts`.
  Test: `mcp-oauth-admission.test.ts` ("what ends a connection").
- **One call per request.** A JSON-RPC batch is refused (400, -32600) before the SDK sees it, in
  both protocol eras. `capabilities.tools.listChanged` stays false, so no request is held open.
  Test: `tests/api/security/mcp-call-limits.test.ts`.
- **Three limit buckets, in order: connection, person, organisation**
  (`MCP_CALLS_PER_GRANT|USER|TENANT_PER_MINUTE`). They answer as tool errors (`rate_limited`),
  never 429. A limiter that cannot be read fails the call closed (`tool_failed`). Tests:
  `mcp-server.test.ts` ("the call log, the limits and the span"), `mcp-call-limits.test.ts`.
- **The call log never stores arguments or results.** `mcp_tool_calls` records who, which
  connection, which tool, the outcome, the code and the duration. Never add a column for either.
- **The CIMD fetch stays guarded, and its refusals look the same to the client.** https on the
  default port only. No IP literal, `localhost`, private suffix or single-label host. No
  redirects, ten seconds, 5 KB, a JSON type, and the document must name its own URL. Every
  refusal of a fetched document shows the same page (`CIMD_UNUSABLE`); only the server log has the
  cause. Never echo what the URL returned.
  Before `redirect_uri` is checked against the document, an error is a page on our origin, never
  a redirect. Tests: `tests/config/mcp-cimd.test.ts`, `tests/api/security/mcp-oauth-clients.test.ts`,
  `tests/api/mcp-oauth.test.ts`.
- **Tokens and codes are stored as SHA-256 hashes.** No plaintext token goes in a row or a log.
  The retry grace keeps the successor only sealed (`seal.ts`) and clears it after the grace. Tests:
  `mcp-cimd.test.ts` ("the refresh successor seal"), `mcp-oauth.test.ts` ("refresh", "the code").
- **Nothing a client sees names the product.** `serverInfo`, the instructions, the notice, every
  error and every authorization page use `APP_NAME` and the organisation's name. Token prefixes are
  neutral. Tests set `APP_NAME="Acme Tools"` and ban `/rocketflare/i`: `mcp-server.test.ts` and
  `mcp-oauth-admission.test.ts` ("branding").
- **Visibility is the HTTP routes'.** A group-only document, its facts and its entities do not
  exist for an outsider through any core tool. A new core tool needs a case in
  `tests/api/security/mcp-visibility.test.ts`, or that test fails.
- **Core owns `/mcp`, `/oauth/*` and `/.well-known/oauth-*`.** A plugin that claims one stops the
  app at load (`RESERVED_PLUGIN_PATHS`, `utils/routes/api-prefixes.ts`). Tests:
  `tests/config/mcp.test.ts`, `tests/config/mcp-plugin-seam.test.ts`.
