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
`features.ts` (D30) — the feature-flag registry (`CORE_FEATURE_FLAGS`, now EMPTY — the kit's demo
flag is the `example-feature` PLUGIN — merged with each plugin's `SharedPlugin.features` into
`FEATURE_FLAGS`, keyed on `FEATURES`/`FeatureName` from `permissions.ts`, where `CORE_FEATURES` is
likewise empty; so `featureNameSchema` is a refined `z.string()` over the runtime list rather than a
`z.enum`, which needs a non-empty tuple), `featureBucket` (**a wire format — changing it reshuffles every live
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
`plugins/types.ts` + `plugins/index.ts` (D31) — `SharedPlugin`, `PLUGIN_ID_RE`/`isPluginId`, the
`SHARED_PLUGINS` barrel one line per installed plugin is written into, and the per-plugin
derivations the composers read — `DeclaredBy<P, K>` first, which narrows the barrel union to the
plugins that actually DECLARE an optional field (indexing `as const` literals directly is a compile
error for a plugin that omits one, and `never` is exactly the empty contribution wanted), then
`JobTypeOf`, `AgentKeyOf`, `PromptKeyOf`, `SubjectOf`, `FeatureKeyOf` on top of it;
**no runtime import of a composer, see Rules**. A plugin's own contracts live in
`plugins/<id>/index.ts`, which is its ONE published shared surface — nothing outside the plugin may
import a deeper path, and `tests/config/plugins.test.ts` is the check ·
`jobs.ts` — per-type payload schemas and `CORE_JOB_VARIANTS`, the ONE list everything else is
DERIVED from (D31): `JOB_VARIANTS` = core + every plugin's, `jobInputSchema` (what `enqueueJob`
takes), `jobEnvelopeSchema` (`+ id, enqueuedAt, attempt?`, what the consumer parses), `JobType` /
`CoreJobType` / `JOB_TYPES`, `JobOf<T>` (D7) ·
`files.ts` — `FILE_SCOPES`/`fileScopeSchema`, `MAX_UPLOAD_BYTES`, `AVATAR_MIME_TYPES`/`isAvatarMimeType`,
`INLINE_MIME_TYPES`/`isInlineMimeType` (served `Content-Disposition: inline`) and
`EMBEDDABLE_MIME_TYPES`/`isEmbeddableMimeType` (may ALSO be framed) — two lists on purpose, because
inline and framable are different properties, `filePath(id)`, `fileSchema`/`uploadResponseSchema`,
`uploadQuerySchema` (D23) ·
`jobs.ts` also carries `document.index` (`{ tenantId, documentId }` — re-index a `documents` row, D18) ·
**`ai/`** (Phase 3, D17/D18/D32; barrel `ai/index.ts`, deep imports `@rocketflare/shared/ai/<file>` equally valid):
`config.ts` — `AI_PROVIDERS`/`aiProviderSchema` (append LAST: the DB column is a text enum), `AI_SCOPES`
(`chat | embeddings`), `thinkingSchema` + `THINKING_*` bounds, `aiConfigSchema` (sanitised row:
`hasCredential`, never a key), `upsertAiConfigRequestSchema` (`apiKey` write-only), `testAiConfigRequest/ResponseSchema`,
`aiReadinessSchema`, `DEFAULT_MODELS`, `PROVIDER_PRESETS`/`presetsFor` (vendors are data, not enum values),
**`EMBEDDING_DIM = 1024`** (the `chunks.embedding` column width — a change is a migration) ·
`evals.ts` (D33) — `evalCaseSchema` (the dataset line: `id`, `input` string|object, `messages`,
`context` docs, `expected { output, rubric, tools, toolsMatch, contains }`, `tags`, `source` — a
promoted case names the message/run, never the tenant, `agentKey`), `EVAL_TRAJECTORY_MODES`,
feedback (`FEEDBACK_TARGETS` `message|agent_run`, `feedbackRatingSchema` `1|-1`,
`createFeedbackRequestSchema`, `feedbackSchema`, list/mine queries and responses,
`feedbackTargetParamSchema`) and `evalExportQuerySchema` (exactly one of `messageId`/`runId`) /
`evalExportResponseSchema` (`containsTenantData: true`) — `/api/feedback`, `/api/evals`, the CLI and
`apps/evals` ·
`traces.ts` (D32) — `TRACE_SPAN_KINDS` (`agent|llm|tool|retrieval|embedding|job|span`), `traceIdSchema` (32 hex), `traceSpanSchema`, `traceSummarySchema`, `traceListQuerySchema` / `traceListResponseSchema`, `traceDetailSchema`, `traceLookupParamSchema` (trace id OR uuid) — `GET /api/traces` and the CLI ·
`prompts.ts` — `promptKeySchema` (kebab-case), `PROMPT_MAX_LENGTH`, `promptDefinitionSchema`, `promptOverrideSchema`,
`updatePromptRequestSchema`, `promptWithResolvedSchema`, `interpolatePrompt()` (`{{var}}`, unknown left visible) ·
`chat.ts` — `conversationSchema`, `messageSchema`, `tokenUsageSchema`, `toolCallRecordSchema`, request bodies,
`MAX_MESSAGE_LENGTH`, `CONVERSATION_TITLE_LENGTH`, `CHAT_MAX_TOOL_TURNS`, and the history budget
(`CHAT_HISTORY_MAX_MESSAGES` backstop, `CHAT_SUMMARY_MAX_CHARS`, `CHAT_COMPACTION_MIN_CHARS`; the
real budget is the `CHAT_HISTORY_MAX_CHARS` var) — the DB-shaped half; the wire protocol is `agui.ts` ·
`agents.ts` — `CORE_AGENT_KEYS` (what you append to) leading `AGENT_KEYS` = core + every plugin's
`agentKeys`, and `agentKeySchema` over it (never empty — it is a `z.enum`, and CORE is what keeps it
non-empty), `AgentMeta<Input, Output>`
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
`Conversation`, `AgentRun`, `Document` — plus whatever an installed PLUGIN declares in
`SharedPlugin.subjects` (the analytics plugin's `Dashboard` and `Analytics`, D19 + D31, which is
where its contracts live too: `@rocketflare/shared/plugins/analytics/index`). Known gap:
`GET /api/ai/config/providers` has no schema here (the catalog is server data in
`apps/web/src/api/services/ai/providers.ts`; the UI keeps a permissive one).

Adding an interrupt kind: the literal in `AGENT_INTERRUPT_KINDS` + an ask variant in
`agentInterruptSpecSchema` + a payload schema + arms in `INTERRUPT_REJECTION`, `AGUI_REASON_FOR_KIND`
and `interruptPayloadSchema` (all four are exhaustive, so the compiler is the checklist) + one UI
branch. Adding a job type: a payload schema + ONE variant in `CORE_JOB_VARIANTS` (both unions and both
type lists follow from it) + an entry in `coreHandlers` (`apps/web/src/api/queues/jobs.ts`); there
is no `runHandler` switch to keep in step, because the handler table's mapped type is the check. Adding an
agent: the key in `CORE_AGENT_KEYS` + its input/output schemas in `ai/agents.ts` (then the prompt, the
definition and the `CORE_AGENTS` entry server-side — `docs/ADAPTING.md` §3). **Each of those is a
PLUGIN slot too** (D31): a job type is `SharedPlugin.jobs` + `ServerPlugin.jobHandlers`, an agent
`SharedPlugin.agentKeys` + `ServerPlugin.agents`, a flag `SharedPlugin.features`, a subject
`SharedPlugin.subjects` — declared in `packages/shared/src/plugins/<id>/index.ts` and merged in by
the composer, so a plugin never edits one of these literals. Adding an AI provider: the
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
- **`plugins/**` never imports one of the five composers AT RUNTIME (D31).** The five are
  `ai/agents.ts`, `jobs.ts`, `permissions.ts`, `features.ts` and `realtime.ts`; each reads the
  plugin barrel to open a closed set (agent keys, job variants, subjects, feature keys, the
  `access.changed` roots), so a plugin module importing one back closes a cycle through
  `plugins/index.ts` — and two zod modules in a cycle crash at module evaluation, not at compile
  time. **A whole-declaration `import type { X } from` is fine**: it is erased before anything
  evaluates, and it is how `SharedPlugin.features` is typed against the one `FeatureDefinition`
  rather than a restatement that drifts. **`import { type X } from` is not** — eliding every
  specifier leaves an empty import clause, and whether that survives as a bare side-effect import is
  the bundler's decision rather than ours. `apps/web/tests/config/shared-imports.test.ts` checks all
  three spellings
- `tenantRoleSchema` (assignable) on every input; `membershipRoleSchema` (+`support`) on outputs only
- Server code imports via `@rocketflare/shared/*`; UI too. Re-export every file from `index.ts`
