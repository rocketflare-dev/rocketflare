# Shared Contracts (`packages/shared` — `@rocketflare/shared`, private)

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
`activity.ts` · `errors.ts` envelope + codes · `pagination.ts` ·
`features.ts` (D30) — the feature-flag registry (`FEATURE_FLAGS` keyed on `FEATURES`/`FeatureName`
from `permissions.ts`), `featureBucket` (**a wire format — changing it reshuffles every live
rollout**), `evaluateFlag`/`evaluateFeatures` (the one implementation of the environment-then-rollout
precedence), and the admin contracts. A flag is CONFIGURATION, not a permission: nothing here
touches CASL · `groups.ts` (D29) — `groupTypeSchema`/`groupSchema` (with `typeName` and `memberCount`)/`groupDetailSchema`,
`groupRefSchema` (what the auth context, a member row and a restricted resource all carry),
`myGroupsSchema`, the create/update/`addGroupMembers`/`setMemberGroups` request schemas,
`resourceVisibilitySchema` (`tenant | groups`), `setVisibilityRequestSchema`, `resourceAccessSchema`
and `isPrivateSelection()` (a `groups` selection with nothing in it means owner-and-admins only — the
UI warns, it does not block) · Phase 2 (server ⇄ UI, no HTTP):
`realtime.ts` — `realtimeEventSchema` `{ type, tenantId, at, payload? }`, `realtimeEventTypeSchema`,
`REALTIME_INVALIDATIONS` (event type → TanStack query-key roots) + `invalidationsFor()` (D8; it is
one of the five composers — it unions each plugin's `realtimeRoots` into `access.changed`) ·
`plugins/types.ts` + `plugins/index.ts` (D31) — `SharedPlugin`, `PLUGIN_ID_RE`/`isPluginId`, and the
`SHARED_PLUGINS` barrel one line per installed plugin is written into; **leaf-only, see Rules** ·
`jobs.ts` — `JOB_TYPES`, per-type payload schemas, `jobInputSchema` (what `enqueueJob` takes),
`jobEnvelopeSchema` (`+ id, enqueuedAt, attempt?`, what the consumer parses), `JobOf<T>` (D7) ·
`files.ts` — `FILE_SCOPES`/`fileScopeSchema`, `MAX_UPLOAD_BYTES`, `AVATAR_MIME_TYPES`/`isAvatarMimeType`,
`INLINE_MIME_TYPES`/`isInlineMimeType` (served `Content-Disposition: inline`) and
`EMBEDDABLE_MIME_TYPES`/`isEmbeddableMimeType` (may ALSO be framed) — two lists on purpose, because
inline and framable are different properties, `filePath(id)`, `fileSchema`/`uploadResponseSchema`,
`uploadQuerySchema` (D23) ·
`jobs.ts` also carries `document.index` (`{ tenantId, documentId }` — re-index a `documents` row, D18) ·
**`ai/`** (Phase 3, D16/D17/D18; barrel `ai/index.ts`, deep imports `@rocketflare/shared/ai/<file>` equally valid):
`config.ts` — `AI_PROVIDERS`/`aiProviderSchema` (append LAST: the DB column is a text enum), `AI_SCOPES`
(`chat | embeddings`), `thinkingSchema` + `THINKING_*` bounds, `aiConfigSchema` (sanitised row:
`hasCredential`, never a key), `upsertAiConfigRequestSchema` (`apiKey` write-only), `testAiConfigRequest/ResponseSchema`,
`aiReadinessSchema`, `DEFAULT_MODELS`, `PROVIDER_PRESETS`/`presetsFor` (vendors are data, not enum values),
**`EMBEDDING_DIM = 1024`** (the `chunks.embedding` column width — a change is a migration) ·
`prompts.ts` — `promptKeySchema` (kebab-case), `PROMPT_MAX_LENGTH`, `promptDefinitionSchema`, `promptOverrideSchema`,
`updatePromptRequestSchema`, `promptWithResolvedSchema`, `interpolatePrompt()` (`{{var}}`, unknown left visible) ·
`chat.ts` — `conversationSchema`, `messageSchema`, `tokenUsageSchema`, `toolCallRecordSchema`, request bodies,
`MAX_MESSAGE_LENGTH`, `CONVERSATION_TITLE_LENGTH`, `CHAT_MAX_TOOL_TURNS`, and the history budget
(`CHAT_HISTORY_MAX_MESSAGES` backstop, `CHAT_SUMMARY_MAX_CHARS`, `CHAT_COMPACTION_MIN_CHARS`; the
real budget is the `CHAT_HISTORY_MAX_CHARS` var) — the DB-shaped half; the wire protocol is `agui.ts` ·
`agents.ts` — `AGENT_KEYS`/`agentKeySchema` (append; never empty — it is a `z.enum`), `AgentMeta<Input, Output>`
(the server attaches `run()`), `agentInfoSchema`, `agentRunStatusSchema` + `isRunActive`, `agentRunSchema`,
`createAgentRunRequest/ResponseSchema` (`deduplicated`), `agentRunListQuerySchema`, `AGENT_RUN_EVENT_TYPES`,
`agentRunEventSchema` + `AGENT_RUN_EVENT_DATA` (type → payload schema; `tool.*`/`text`/`status`/`error`
were conventional and are now contracts), `agentRunWithEventsSchema` (`+ interrupts[]`, `artifacts[]`),
`ACTIVE_RUN_STATUSES` vs `CLAIMABLE_RUN_STATUSES` (a parked run holds the exclusive slot but is NOT
claimable — the resolve route flips it back to `running` first), `AGENT_RESUME_EVENT` +
`WORKFLOW_EVENT_TYPE_PATTERN` (Workflows event names allow only letters, digits, `-`, `_`; a `.` is
`workflow.invalid_event_type`, which no Node test would catch), `MAX_INTERRUPT_ROUNDS`, the
`RUN_STREAM_*` cadence constants, the example's `summarizeTextInput/OutputSchema` ·
`interrupts.ts` — human-in-the-loop (issue #17): `AGENT_INTERRUPT_KINDS` (`approval · choice · input ·
form`, closed), `agentInterruptSpecSchema` (the TYPED `spec` column — an untyped jsonb blob called
`metadata` is where render bugs live), the four payload schemas + `interruptPayloadSchema(spec)` and
`formValuesSchemaFor(fields)` (the ONE validator the route and the UI both call),
`INTERRUPT_REJECTION`/`rejectionFor` (a declined APPROVAL stops the run; every other decline is an
answer the model is told), `AGUI_REASON_FOR_KIND`/`aguiReasonFor`, `agentRunInterruptSchema` (the row;
`key` is MANDATORY and `UNIQUE (run_id, key)` is what stops a re-entered step asking twice),
`resolveInterruptRequestSchema` (`status` + `payload`, AG-UI's own `ResumeEntry` vocabulary — there is
deliberately no second `approved` boolean), the inbox contracts, steering, and the `interrupt` /
`interrupt.resolved` event payloads. **It must not import `@ag-ui/core`** (that is `agui.ts` alone,
where `toAguiInterrupt` lives) **and must not import `./agents`**, which imports IT — two zod modules
in a cycle crash at module evaluation, not at compile time ·
`artifacts.ts` — what a run produces that a person opens: `AGENT_ARTIFACT_KINDS`,
`agentArtifactDataSchema` (`document`/`file` carry IDS, never content), `agentArtifactSchema` (`key`
is the upsert key), the thin `artifact` event payload. A table rather than an event type because an
artifact is mutable, queried across runs and outlives the run; size caps live here, not in the column ·
`agui.ts` — the AG-UI wire protocol (`@ag-ui/core` schemas, the ONE file allowed to import it):
`kitAguiEventSchema` (a discriminated union over exactly the events the kit emits, never the full
`@ag-ui/core` set), `KIT_AGUI_EVENT_TYPES`, `KIT_CUSTOM_EVENTS` + `kitCustomPayloadSchema` +
`parseKitCustom` (the `kit.` CUSTOM namespace where every kit-specific semantic lives, including
`kit.document` — a `documentCardSchema` for a document a knowledge tool surfaced),
`chatRunResultSchema` (`RUN_FINISHED.result` for a chat turn), `toAguiInterrupt(row)` (the kit row is
the truth, the protocol shape is a projection of it — and the HITL pause/answer need NO new event:
`RunFinishedEventSchema` already validates an `outcome` and `RunAgentInputSchema` already carries
`resume[]`), `kitRunAgentInputSchema` +
`readRunAgentTail` (`POST /api/agui/run`: the server is the transcript, the client supplies the tail) ·
`agent-models.ts` — `agentModelAssignmentSchema`, `upsertAgentModelRequestSchema` (at least one of
`aiConfigId`/`model`), `agentModelEntrySchema` (`effective.source: assignment | tenant | platform | none`) ·
`embeddings.ts` — `documentSchema` (never the text or vectors), `INGEST_TEXT_MAX_CHARS`, `ingestTextRequestSchema`,
`documentListQuerySchema`, `searchRequestSchema` (`SEARCH_MAX_LIMIT`), `searchHitSchema` (RRF `score`, `rank`,
`denseRank`/`lexicalRank`), `searchResponseSchema`, and the read side (D18): `documentContentSchema` + `documentContentQuerySchema`
(`DOCUMENT_WINDOW_CHARS` 20 000, `DOCUMENT_WINDOW_MAX_CHARS` 50 000) + `windowStart()` (snap an offset
down to a window boundary so a deep link and the reader's paging share one cache entry),
`documentPassageSchema`, `documentCardSchema` + `DOCUMENT_EXCERPT_CHARS` + `documentPath()` (the ONE
place the viewer route is written) + `documentCardFromDocument()`, and the pure
`documentCardsFromToolResult()` / `documentCardsFromToolCalls()` + `KNOWLEDGE_TOOLS` +
`documentExcerpt()` that the chat stream, the agent-run projection and the UI's persisted-message
rendering all share · `usage.ts` — `aiUsageSchema`, `aiUsageSummarySchema`,
`aiUsageSummaryQuerySchema` (`costMicrocents` nullable, `unpricedCalls`) · `pricing.ts` — `MODEL_PRICES`
(USD per million tokens, per provider, longest-prefix model match), `PRICES_UPDATED`, `priceFor`,
`estimateCostMicrocents`; the ONE place to correct rates, unknown model → null, never a guess. `errors.ts` codes added: `ai_not_configured`,
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

Adding an interrupt kind: the literal in `AGENT_INTERRUPT_KINDS` + an ask variant in
`agentInterruptSpecSchema` + a payload schema + arms in `INTERRUPT_REJECTION`, `AGUI_REASON_FOR_KIND`
and `interruptPayloadSchema` (all four are exhaustive, so the compiler is the checklist) + one UI
branch. Adding a job type: a payload schema + a variant in BOTH `jobInputSchema` and `jobEnvelopeSchema` +
the literal in `JOB_TYPES` (then the handler table in `apps/web/src/api/queues/jobs.ts`). Adding an
agent: the key in `AGENT_KEYS` + its input/output schemas in `ai/agents.ts` (then the prompt, the
definition and the `AGENTS` entry server-side — `docs/ADAPTING.md` §3). Adding an AI provider: the
value in `AI_PROVIDERS` + `DEFAULT_MODELS` (mirrored in `apps/web/src/db/schema/ai-configs.ts`); a
vendor on an existing wire format is a `PROVIDER_PRESETS` entry only. Adding a streamed event: an AG-UI type in
`kitAguiEventSchema` or a member of the kit CUSTOM namespace in `ai/agui.ts` — the UI drops frames it
cannot parse, so the server may lead. A breaking
payload change is a NEW type (`email.send.v2`) — the `type` string is the version seam. Adding a
realtime event type: the enum + its roots in `REALTIME_INVALIDATIONS` (a ui test checks every root
is a `queryKeys` family). Adding a file scope: `FILE_SCOPES` here AND the mirrored enum in
`apps/web/src/db/schema/files.ts`. Making a NEW resource restrictable (D29): add `visibility` +
`groups: z.array(groupRefSchema)` to its schema here, a `visibility` column plus a junction table
server-side, and a `visible<Resource>(scope)` predicate registered as a `VISIBILITY_RESOURCES`
entry in `api/services/access.ts` — never infer "restricted" from the presence of grant rows.

## Rules

- Imports: `zod`, sibling files, TYPE-only imports from `@casl/ability`, and **`@ag-ui/core`
  (pinned, zod-only, no platform APIs) in `src/ai/agui.ts` alone**. NEVER import from
  `apps/web/src/api`, `apps/web/src/db`, `apps/web/src/ui` or `apps/cli` — this package bundles into the browser and the CLI.
  `@ag-ui/core` is on the list because it satisfies that reason AND because AG-UI is a wire format:
  server and UI must parse the SAME runtime schema, so a loose mirror (the `analytics.ts` precedent,
  where nothing needs to validate a `DashboardConfig`) would mean two sources of truth. A fifth
  dependency needs the same written justification here and in the root `CLAUDE.md`;
  `apps/web/tests/config/shared-imports.test.ts` is the check
- **`plugins/**` is LEAF-ONLY (D31).** `plugins/types.ts`, `plugins/index.ts` and every installed
  plugin's `plugins/<id>/index.ts` may import zod and leaf contract files, and **never one of the
  five composers — `ai/agents.ts`, `jobs.ts`, `permissions.ts`, `features.ts`, `realtime.ts`**.
  Those five read the plugin barrel to open their closed sets (agent keys, job variants, subjects,
  feature keys, the `access.changed` roots), so a plugin module importing one back closes a cycle
  through `plugins/index.ts` — and two zod modules in a cycle crash at module evaluation, not at
  compile time. A2 adds the check to `apps/web/tests/config/shared-imports.test.ts`
- `tenantRoleSchema` (assignable) on every input; `membershipRoleSchema` (+`support`) on outputs only
- Server code imports via `@rocketflare/shared/*`; UI too. Re-export every file from `index.ts`
