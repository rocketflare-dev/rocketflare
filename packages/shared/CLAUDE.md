# Shared Contracts (`packages/shared` — `@gmgo/shared`, private)

Zod schemas + inferred types used by BOTH the API and the UI (D13). Contracts first: a new or
changed API surface starts here, then the route `validate()`s with it, then the UI parses the
response with the same schema. `pnpm test:config` covers the pure parts.

## Naming

- `<thing>Schema` — a response / entity shape (`memberSchema`, `sessionResponseSchema`)
- `<thing>RequestSchema` — a request body (`inviteMemberRequestSchema`); `<thing>QuerySchema` — query params
- `type <Thing> = z.infer<typeof <thing>Schema>` exported next to it; never a hand-written duplicate
- Timestamps are `z.coerce.date()` (JSON carries strings); nullable columns are `.nullable()`, not `.optional()`
- jsonb columns are typed from here (`TenantSettingsJson`, `UserPreferences`, `NotificationData`, `ActivityMetadata`)

## Files

`auth.ts` session/login · `tenants.ts` roles, slugs, members, invitations · `access-requests.ts` ·
`permissions.ts` actions/subjects/`AppAbility`/packed rules (matrix lives in `apps/web/src/permissions/`) ·
`api-keys.ts` · `tenant-settings.ts` · `user-settings.ts` · `notifications.ts` · `admin.ts` ·
`activity.ts` · `errors.ts` envelope + codes · `pagination.ts` · Phase 2 (server ⇄ UI, no HTTP):
`realtime.ts` — `realtimeEventSchema` `{ type, tenantId, at, payload? }`, `realtimeEventTypeSchema`,
`REALTIME_INVALIDATIONS` (event type → TanStack query-key roots) + `invalidationsFor()` (D8) ·
`jobs.ts` — `JOB_TYPES`, per-type payload schemas, `jobInputSchema` (what `enqueueJob` takes),
`jobEnvelopeSchema` (`+ id, enqueuedAt, attempt?`, what the consumer parses), `JobOf<T>` (D7) ·
`files.ts` — `FILE_SCOPES`/`fileScopeSchema`, `MAX_UPLOAD_BYTES`, `AVATAR_MIME_TYPES`/`isAvatarMimeType`,
`filePath(id)`, `fileSchema`/`uploadResponseSchema`, `uploadQuerySchema` (D23) ·
`jobs.ts` also carries `document.index` (`{ tenantId, documentId }` — re-index a `documents` row, D18) ·
**`ai/`** (Phase 3, D16/D17/D18; barrel `ai/index.ts`, deep imports `@gmgo/shared/ai/<file>` equally valid):
`config.ts` — `AI_PROVIDERS`/`aiProviderSchema` (append LAST: the DB column is a text enum), `AI_SCOPES`
(`chat | embeddings`), `thinkingSchema` + `THINKING_*` bounds, `aiConfigSchema` (sanitised row:
`hasCredential`, never a key), `upsertAiConfigRequestSchema` (`apiKey` write-only), `testAiConfigRequest/ResponseSchema`,
`aiReadinessSchema`, `DEFAULT_MODELS`, `PROVIDER_PRESETS`/`presetsFor` (vendors are data, not enum values),
**`EMBEDDING_DIM = 1024`** (the `chunks.embedding` column width — a change is a migration) ·
`prompts.ts` — `promptKeySchema` (kebab-case), `PROMPT_MAX_LENGTH`, `promptDefinitionSchema`, `promptOverrideSchema`,
`updatePromptRequestSchema`, `promptWithResolvedSchema`, `interpolatePrompt()` (`{{var}}`, unknown left visible) ·
`chat.ts` — `conversationSchema`, `messageSchema`, `tokenUsageSchema`, `toolCallRecordSchema`, request bodies,
`MAX_MESSAGE_LENGTH`, `CONVERSATION_TITLE_LENGTH`, **`chatStreamEventSchema`** (the SSE `data` union:
`message.start | text.delta | tool.start | tool.end | usage | message.end | error`) ·
`agents.ts` — `AGENT_KEYS`/`agentKeySchema` (append; never empty — it is a `z.enum`), `AgentMeta<Input, Output>`
(the server attaches `run()`), `agentInfoSchema`, `agentRunStatusSchema` + `isRunActive`, `agentRunSchema`,
`createAgentRunRequest/ResponseSchema` (`deduplicated`), `agentRunListQuerySchema`, `AGENT_RUN_EVENT_TYPES`,
`agentRunEventSchema`, `agentRunWithEventsSchema`, the example's `summarizeTextInput/OutputSchema` ·
`agent-models.ts` — `agentModelAssignmentSchema`, `upsertAgentModelRequestSchema` (at least one of
`aiConfigId`/`model`), `agentModelEntrySchema` (`effective.source: assignment | tenant | platform | none`) ·
`embeddings.ts` — `documentSchema` (never the text or vectors), `INGEST_TEXT_MAX_CHARS`, `ingestTextRequestSchema`,
`documentListQuerySchema`, `searchRequestSchema` (`SEARCH_MAX_LIMIT`), `searchHitSchema` (RRF `score`, `rank`,
`denseRank`/`lexicalRank`), `searchResponseSchema` · `usage.ts` — `aiUsageSchema`, `aiUsageSummarySchema`,
`aiUsageSummaryQuerySchema` (`costMicrocents` nullable). `errors.ts` codes added: `ai_not_configured`,
`agent_runs_not_configured`, `agent_run_active`; `permissions.ts` subjects added: `AiConfig`, `Prompt`,
`Conversation`, `AgentRun`, `Document`, and (D19) `Dashboard` (`analytics_pages` rows) + `Analytics`
(the cube API) · **`analytics.ts`** (Phase 4, D19): `dashboardConfigSchema` — a drizzle-cube
`DashboardConfig` typed LOOSELY (`{ portlets: [...] }` + catchall; this package may import only zod, so
the real type lives on the API's db column and in the UI via `drizzle-cube/client`; the documented shape
is in the file header) · `analyticsPageSchema` (`slug`, `templateKey` null = user page, `config`,
`isDefault`, `order`, `createdBy`) + `analyticsPageListResponseSchema` (`{ items }`, not paginated) ·
`createAnalyticsPageRequestSchema` / `updateAnalyticsPageRequestSchema` (partial, ≥ 1 field;
`ANALYTICS_PAGE_NAME_MAX` 120, `…_DESCRIPTION_MAX` 500) · `dashboardTemplateSummarySchema` +
`dashboardTemplateListResponseSchema` (`GET /api/analytics/templates`) · `factTableStatusSchema`
(`table`, `refreshedAt` nullable, `lagSeconds`, `stale`) + `factTableStatusListResponseSchema`
(`GET /api/analytics/facts/status`). The cube API (`/cubejs-api/v1/*`) is drizzle-cube's Cube.js-shaped
contract, consumed through `drizzle-cube/client` — no schema here. Known gap: `GET /api/ai/config/providers` has no schema here
(the catalog is server data in `apps/web/src/api/services/ai/providers.ts`; the UI keeps a permissive one).

Adding a job type: a payload schema + a variant in BOTH `jobInputSchema` and `jobEnvelopeSchema` +
the literal in `JOB_TYPES` (then the handler table in `apps/web/src/api/queues/jobs.ts`). Adding an
agent: the key in `AGENT_KEYS` + its input/output schemas in `ai/agents.ts` (then the prompt, the
definition and the `AGENTS` entry server-side — `docs/ADAPTING.md` §3). Adding an AI provider: the
value in `AI_PROVIDERS` + `DEFAULT_MODELS` (mirrored in `apps/web/src/db/schema/ai-configs.ts`); a
vendor on an existing wire format is a `PROVIDER_PRESETS` entry only. Adding an SSE frame type: a
variant in `chatStreamEventSchema` — the UI drops frames it cannot parse, so the server may lead. A breaking
payload change is a NEW type (`email.send.v2`) — the `type` string is the version seam. Adding a
realtime event type: the enum + its roots in `REALTIME_INVALIDATIONS` (a ui test checks every root
is a `queryKeys` family). Adding a file scope: `FILE_SCOPES` here AND the mirrored enum in
`apps/web/src/db/schema/files.ts`.

## Rules

- Imports: `zod`, sibling files, and TYPE-only imports from `@casl/ability`. NEVER import from
  `apps/web/src/api`, `apps/web/src/db`, `apps/web/src/ui` or `apps/cli` — this package bundles into the browser and the CLI
- `tenantRoleSchema` (assignable) on every input; `membershipRoleSchema` (+`support`) on outputs only
- Server code imports via `@gmgo/shared/*`; UI too. Re-export every file from `index.ts`
