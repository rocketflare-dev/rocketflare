# Chat UI (`/chat/:conversationId?`)

`ChatPage` is `guard read Conversation` (every role; ownership is server-side) and lazy — its chunk
carries the markdown renderer. The turn logic lives in `hooks/useChat.ts` and `lib/aguiStream.ts`;
the SSE transport rules are in `.claude/rules/ui.md` → Streaming.

## A turn (`useSendMessage`)

- **Streaming is the one exception to "server data lives only in the cache".** The user bubble is
  appended optimistically (`setQueryData` on `chat.conversations.detail(id)` with a real `Date`;
  `CUSTOM kit.chat.ids` swaps its id for the persisted `userMessageId`). The assistant reply
  accumulates in LOCAL state from `TEXT_MESSAGE_CONTENT` deltas — across EVERY message id the run
  opens, one per model turn — and is not truth until `RUN_FINISHED`. `usage` comes from
  `CUSTOM kit.usage`.
- On `RUN_FINISHED` write the finished message into the cache (the server persisted it BEFORE that
  frame), then invalidate the whole `chat.conversations` family (list re-sorts, auto-title arrives).
- Stop = `AbortController.abort()`: **a cancelled run emits NO terminal event** — a normal end, no
  toast, no error bubble. A pre-stream failure takes the optimistic bubble back; a `RUN_ERROR`
  leaves the turn in `error` status until the next send.
- Tool calls render as ONE row each (`ToolStep { id, label, done }`): `TOOL_CALL_START` opens it
  with a spinner and `TOOL_CALL_RESULT` completes it in place with a tick, matched by
  `toolCallId` — never a second "Done" line, never an index key. `toolLabel(name)` owns the wording.
- A `CUSTOM kit.notice` renders as a quiet italic line above the reply (`NOTICE_TEXT` in `ChatPage`
  owns its wording) — information, never the error styling.

## Not configured

`ai_not_configured` (503) — from `POST /api/chat/conversations` (`ApiError`, toast suppressed in
the hook) or from the send (`AiNotConfiguredError`, `isAiNotConfigured()`) — or readiness
`chat.ready === false` → the `EmptyState` with a "Configure AI" link to `/settings?tab=ai` for
`manage AiConfig`, "ask an administrator" otherwise.

## Tests

`tests/ui/chat-page.test.tsx`, `chat-stats-panel.test.tsx`; `tests/ui/helpers/sse.ts` builds fake
`text/event-stream` `Response`s (`sseResponse`, `streamResponse` for arbitrary chunking,
`hangingSseResponse` for Stop). Bubbles remount when an optimistic id becomes the persisted one, so
assert with `waitFor(() => getByText…)`, not `findBy`.
