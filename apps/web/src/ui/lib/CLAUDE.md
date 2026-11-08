# UI lib (transports, keys, navigation)

The rules every UI edit follows (cache-only server data, realtime roots, SSE via `fetch`) are in
`.claude/rules/ui.md`; this is the detail for editing the modules here.

- `api-client.ts` — `ApiError`, `parseErrorBody` (reuse it for any non-JSON transport),
  `setUnauthorizedHandler` / `notifyUnauthorized` (the global 401 path, coalesced), `api.upload`
  for multipart. `queryClient.ts` routes `QueryCache` and `MutationCache` 401s into it.
- `query-keys.ts` — `queryKeys` = `CORE_QUERY_KEYS` spread with every plugin's families, plus
  `cleanFilters` / `toSearchParams`. The family roots are what `REALTIME_INVALIDATIONS` names;
  `agentRuns.all` is `['agent-run']` because that is the nudge's `entity`.
- `websocketClient.ts` — singleton outside React: `/ws?tenantId=` (same origin; Vite proxies it in
  dev), backoff `min(1 s · 2^attempt, 30 s)` jittered in `[base/2, base]`; a close 1001/1012 or a
  reason "upgraded"/"new version" (Worker redeployed) reconnects in 100 ms without counting as a
  failure; `{"type":"ping"}` every 30 s; events parse with `realtimeEventSchema`. It is the only
  writer of `stores/websocketStore.ts`, whose `disconnectedAt` is kept at the FIRST drop so
  `ConnectionBanner` measures the whole outage. `setFactory()` is the test seam — reset it in
  `afterEach`.
- `sse.ts` — `readSse(response, parse, onEvent, { signal })`, `SseFrameBuffer` (survives frames
  split across chunks), `parseSseFrame`. Each `data` goes through the parser the CALLER passes
  (`kitAguiEventSchema.safeParse`); unknown frames are dropped, never thrown. It imports no schema —
  that keeps `@ag-ui/core` out of the eager shell.
- `aguiStream.ts` — `runChatTurn({ conversationId, content, onEvent, signal })` POSTs and streams
  AG-UI with `credentials: 'include'` + `X-Requested-With`. A pre-stream non-2xx is the shared
  envelope via `parseErrorBody`; 503 `ai_not_configured` throws `AiNotConfiguredError`
  (`isAiNotConfigured()`), so the page renders a "configure AI" call to action instead of a toast.
- Frame order the chat UI relies on: `RUN_STARTED` → `CUSTOM kit.chat.ids` → `STATE_SNAPSHOT` →
  per model turn `TEXT_MESSAGE_START → CONTENT* → END` and `TOOL_CALL_START → ARGS → END →
  RESULT` → `CUSTOM kit.usage` → `RUN_FINISHED`.
- `runAguiStream.ts` — the run READ-stream, the one GET (so a third-party client can point a bare
  `EventSource` at it), resuming with `?afterSeq=`, which beats an inbound `Last-Event-ID` when both
  arrive. A close with no terminal event means reconnect; reconnection lives in
  `hooks/useRunStream.ts`, not here (`pages/agents/CLAUDE.md`).
- `navigation.ts` — `NavigationBridge`, `navigateTo`, `hardNavigate` (full-page: OAuth,
  dev-login, logout), `loginUrl`, `safeReturnUrl`.
- `feature-guards.ts` exports only `featureGuard`; core declares no flag consts here.
- `notificationLink.ts`, `highlight.ts` (`<mark>` nodes, never HTML) — see `pages/agents/CLAUDE.md`
  and `pages/documents/CLAUDE.md`.
