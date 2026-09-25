# Database Schema

Drizzle table definitions, one file per table, re-exported from `index.ts` (which `drizzle.config.ts`,
`src/db/client.ts` and the RLS coverage test all read). `many()` relations live in `relations.ts`
(the hub tables `users`/`tenants` must not import their dependents — `tenantRef(tenants)` is eager).

**`index.ts` carries `export * from '../../plugins/schema'`** (D31 — Biome sorts these lines, so
it sits where the sorter puts it; its position decides nothing, because a name exported twice is
TS2308 rather than a silent shadow), so an installed
plugin's tables are migrated, typed and RLS-checked exactly like these — prefixed with the first
hyphen-separated segment of the plugin's id, declaring `relations()` for their own tables only, and
never shipping a migration (the host generates it). Two plugins exporting one SYMBOL is a TS2308
error, not a silent shadow; two plugins declaring one TABLE NAME is invisible to TypeScript and is
what `pnpm plugin check` fails on.
A file inside `src/plugins/<id>/` must import a schema file DIRECTLY rather than this barrel, or it
closes a cycle back through `plugins/schema.ts`.

## Table registry

| Table | File | Tenant key | RLS | Notes |
|---|---|---|---|---|
| `users` | `users.ts` | — (membership) | `membershipIsolation()` | global person; unique `lower(email)`; `isGlobalAdmin`, `blockedAt`, `emailVerifiedAt` |
| `user_sessions` | `user-sessions.ts` | — | **revoked** | `tokenHash` (SHA-256 of cookie), `selectedTenantId` = current tenant |
| `oauth_providers` | `oauth-providers.ts` | — | **revoked** | UNIQUE `(provider, provider_user_id)` (D12); `*Enc` tokens |
| `magic_link_tokens` | `magic-link-tokens.ts` | — | **revoked** | keyed by email; `consumedAt` single-use |
| `access_requests` | `access-requests.ts` | — | **revoked** | gated sign-up queue (D9); `status` enum |
| `tenants` | `tenants.ts` | `id` | `tenantIsolation('tenants', sql\`id\`)` | `status` enum, `seedDataCreated`, `lastAccessedAt` |
| `tenant_users` | `tenant-users.ts` | `tenant_id` | ✓ | PK `(tenant_id, user_id)`; `role` text enum `MEMBERSHIP_ROLES` |
| `team_invitations` | `team-invitations.ts` | `tenant_id` | ✓ | `tokenHash`; partial unique pending `(tenant_id, lower(email))` |
| `api_keys` | `api-keys.ts` | `tenant_id` | ✓ | `keyHash` unique, `keyPrefix`, `scopes[]`, soft `revokedAt` |
| `tenant_settings` | `tenant-settings.ts` | `tenant_id` (PK) | ✓ | `timezone`, `notificationsEnabled`, `settings` jsonb |
| `tenant_user_settings` | `tenant-user-settings.ts` | `tenant_id` | ✓ | PK `(tenant_id, user_id)`; `preferences` jsonb |
| `notifications` | `notifications.ts` | `tenant_id` | ✓ | per user; `readAt`; `data` jsonb |
| `activity_events` | `activity-events.ts` | `tenant_id` | ✓ | audit log, and the source the analytics plugin's cubes and fact table read; `(tenant_id, created_at DESC)` |
| `files` | `files.ts` | `tenant_id` | ✓ | R2 object index (D23): `key` unique (`tenants/<tenant>/<scope>/<uuid>-<name>`), `scope` enum (`avatars`, `uploads`, `documents` — mirrors `FILE_SCOPES` in shared), `ownerUserId`, immutable (no `updated_at`) |
| `ai_configs` | `ai-configs.ts` | `tenant_id` | ✓ | tenant AI providers (D17): `scope` chat\|embeddings, `provider` text enum, `label` (unique per tenant+scope, the upsert key), `apiKeyEnc` (AES-GCM, never returned), `thinking` jsonb, partial unique **one default per (tenant, scope)**; only `services/ai/resolve.ts` reads it |
| `prompt_overrides` | `prompt-overrides.ts` | `tenant_id` | ✓ | PK `(tenant_id, key)`; row exists only when a registry prompt is overridden (revert = delete); `updatedByUserId` |
| `conversations` | `conversations.ts` | `tenant_id` | ✓ | chat threads (D17): `userId` is ownership (routes filter tenant AND user — others' threads are 404), `provider`/`model` frozen at creation, `lastMessageAt`; index `(tenant_id, user_id, last_message_at DESC)` |
| `messages` | `messages.ts` | `tenant_id` | ✓ | chat turns: `role` text enum, `content`, `toolCalls` jsonb, `usage` jsonb, `traceId` (D32 — the turn's trace, on the assistant row; `traces show <messageId>` resolves through it); immutable. Index `(conversation_id, created_at)` — deliberate exception to tenant-first (fetched by thread id after the ownership check) |
| `ai_usage` | `ai-usage.ts` | `tenant_id` | ✓ | one row per generation (D18): `feature`, `provider`, `model`, four token counters, `costMicrocents` nullable bigint, `agentRunId` nullable FK → `agent_runs` **set null** (per-run cost; recorded now because it cannot be backfilled), `at`; append-only; index `(tenant_id, at DESC)` |
| `ai_spans` | `ai-spans.ts` | `tenant_id` | ✓ | the local AI trace store (D32): one row per recorded span — `traceId` (32 hex), `spanId` (16 hex), `parentSpanId`, `name`, `kind` (`agent\|llm\|tool\|retrieval\|embedding\|job\|span`, `$type` from `@rocketflare/shared/ai/traces`), `status` `ok\|error`, `statusMessage`, `startedAt`/`endedAt`/`durationMs`, `runId`/`conversationId`/`userId` **plain uuids, NO foreign key** (a deleted run or thread never rewrites its trace; the tenant FK is the one cascade), `model`/`provider`/`inputTokens`/`outputTokens`/`toolName`, `attributes` jsonb (never content), `content` jsonb nullable (null when `OBSERVABILITY_CAPTURE_CONTENT=false`). Unique `(tenant_id, trace_id, span_id)` → `onConflictDoNothing`; indexes `(tenant_id, started_at DESC)` (also the nightly prune), `(tenant_id, run_id)`, `(tenant_id, conversation_id)`. Append-only, written by background flushes — the READ (`services/traces.ts`) is where tenancy is proven |
| `agent_models` | `agent-models.ts` | `tenant_id` | ✓ | per-agent model assignment (D17): PK `(tenant_id, prompt_key)`; `aiConfigId` nullable FK → `ai_configs` **cascade** (deleting a provider reverts its agents), `model` nullable; row exists only when overridden (revert = delete); only `services/ai/resolve.ts` reads it |
| `agent_runs` | `agent-runs.ts` | `tenant_id` | ✓ | one row per agent run (D7): `agentKey` text, `status` text enum `queued\|running\|succeeded\|failed\|cancelled\|awaiting_input`, `input`/`output` jsonb, `error`, `requestedByUserId`, `instanceId` unique (the Workflow instance — it STARTS as the run id and becomes `<runId>-rN` when a parked run has to be restarted, so it is *the latest* instance, not the run id), `attempt`, `startedAt`/`finishedAt`, `cancelRequestedAt` (cooperative cancel flag). **Partial unique `agent_runs_active_exclusive_idx` on `(tenant_id, agent_key) WHERE status IN ('queued','running','awaiting_input')` = the exclusive guarantee** — the predicate is `ACTIVE_RUN_STATUSES` rendered from the shared list, because a run parked on a human is still *the* active run for that agent. Claim = `UPDATE … WHERE status IN (queued,running) RETURNING` — `CLAIMABLE_RUN_STATUSES`, deliberately narrower. `checkpoint` jsonb = the tool loop's resume point for a retried step, cleared by every terminal settle and untyped on purpose (internal state, no shared contract); `traceId` = `traceIdForRun(id)` (D32), written at enqueue — which is why `enqueueRun` mints the id instead of the column default |
| `agent_run_effects` | `agent-run-effects.ts` | `tenant_id` | ✓ | the durable-effect ledger (D7): `runId` cascade, `key`, `result` jsonb, `at`. **Unique `(run_id, key)` IS the once-per-run guarantee** behind `ctx.once` — a DB constraint, not a memory map. Internal: no route reads it |
| `agent_run_events` | `agent-run-events.ts` | `tenant_id` | ✓ | append-only progress log (D7/D8): `runId` cascade, per-run `seq` (unique `(run_id, seq)`), `type` `step\|tool.start\|tool.end\|text\|status\|error`, `data` jsonb, `at`. DB is the truth; the hub carries an `entity.changed {entity:'agent-run'}` nudge |
| `agent_run_interrupts` | `agent-run-interrupts.ts` | `tenant_id` | ✓ | human-in-the-loop asks (#17): `id` **IS the AG-UI `Interrupt.id`**, `runId` cascade, `key`, `kind` text (`approval\|choice\|input\|form`, from `AGENT_INTERRUPT_KINDS`), `reason`, `message`, `toolCallId`, `responseSchema` jsonb, `spec` jsonb `$type<AgentInterruptSpec>`, `status` text (`pending\|resolved\|cancelled\|expired`, default `pending`), `payload` jsonb (validated by `interruptPayloadSchema(spec)`, so untyped here), `expiresAt`, `resolvedAt`, `resolvedByUserId` set-null. **Unique `(run_id, key)` IS the idempotency** — a re-entered `execute` finds the first ask's answer, never a second question. Indexes `(tenant_id, status, created_at DESC)` (the inbox) and `(tenant_id, run_id)` (the run page). `runId` is the only host-specific column: chat HITL is a nullable `conversationId` sibling plus a `num_nonnulls` CHECK |
| `agent_run_artifacts` | `agent-run-artifacts.ts` | `tenant_id` | ✓ | what a run PRODUCED (#17): `runId` cascade, `key` (**the UPSERT key — a redraft replaces itself**), `kind` text (`document\|file\|markdown\|table\|json`, a real column so `(tenant_id, kind)` can index it), `title`, `description`, `data` jsonb `$type<AgentArtifactData>` (`document`/`file` carry **ids, never content**). Unique `(run_id, key)`; indexes `(tenant_id, created_at DESC)`, `(tenant_id, kind)`. A table and not an event type because an artifact is mutable, cross-run queryable and outlives the run — a steering note is the opposite and stays an `agent_run_events` row |
| `documents` | `documents.ts` | `tenant_id` | ✓ | text a tenant indexed for retrieval (D18): `ownerUserId`, `title`, `source`, `contentType` (the ORIGINAL media type), `sizeBytes`, `content` (the indexed text, API-invisible — the `document.index` job re-reads it; null for an upload until `document.convert` ran), `fileId` → `files` (`set null`; the uploaded original, scope `documents`), `chunkCount`, `embeddingModel`, `status` `pending\|indexed\|failed`, `error` |
| `group_types` | `groups.ts` | `tenant_id` | ✓ | D29: group types ("Department"); unique `(tenant_id, name)` |
| `groups` | `groups.ts` | `tenant_id` | ✓ | D29: `groupTypeId` cascade; unique `(tenant_id, group_type_id, name)`. No `parentId` — hierarchy without inheritance is a column nothing reads |
| `group_members` | `groups.ts` | `tenant_id` | ✓ | D29: PK `(group_id, user_id)` so an add is `onConflictDoNothing`; **composite FK `(tenant_id, user_id)` → `tenant_users` cascade**, so losing a membership loses the group memberships in the DATABASE, not in service code; index `(tenant_id, user_id)` is the auth-context read |
| `document_groups` | `document-groups.ts` | `tenant_id` | ✓ | D29: which groups a `visibility: 'groups'` document is shared with. PK on the pair, both FKs cascade. **Grants, never the decision** — `documents.visibility` is |
| `chunks` | `chunks.ts` | `tenant_id` | ✓ | retrieval units (D17/D18): `documentId` cascade, `seq` (unique per document), `text`, `tokenCount` (char estimate), `embedding vector(1024)` (`EMBEDDING_DIM`; a new dimension is a new table); **HNSW `vector_cosine_ops`** index; lexical half is `to_tsvector('english', text)` at query time (generated tsvector + GIN is the scaling path) |

32 policies (`tenants`, `users` + 30 tenant tables); 4 revoked tables = `RLS_REVOKED_TABLES` =
`RLS_EXCLUDED_TABLES`. jsonb columns are `$type<>()`d from `@rocketflare/shared` (type-only imports).

## Conventions

- PK: `uuid('id').primaryKey().defaultRandom()`. No ULIDs.
- Tenant FK: `tenantId: tenantRef(tenants)` from `_helpers.ts` → `tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`. First column of every index on a tenant table is `tenant_id`.
- Timestamps: `...timestamps()` from `_helpers.ts` — `created_at`/`updated_at` as **`timestamptz`**. Never a naive `timestamp`.
- extraConfig is the **array** form: `table => [index(...), tenantIsolation('x')]` (required for `pgPolicy`).
- An installed PLUGIN's tables are here too, through one `export * from '../../plugins/schema'`
  line — so drizzle-kit, `typeof schema` and `rls-coverage.test.ts` see them exactly like a kit
  table, and a name exported twice is TS2308 rather than a silent shadow (D31). They are prefixed
  from the plugin's id; the analytics plugin's are `analytics_pages`, `analytics_page_groups` and
  `analytics_tenant_activity_daily_facts`, and `example-feature`'s is `example_notes`. A duplicated
  table NAME is not a TypeScript error at all — `pnpm plugin check` is what catches it. A plugin
  declares `relations()` for its OWN tables only.
- **Fact tables** — the shape for any pre-aggregated table, and the analytics plugin's worked
  example: plain tables (not materialised views — `REFRESH` cannot run through Hyperdrive), grain
  unique with `.nullsNotDistinct()` where a grain column is nullable, `fact_refreshed_at` as the
  freshness watermark, no surrogate `id`, no FK to a table whose rows may vanish.
- Enums via `pgEnum`, exported; `relations()` next to the table; `export type X = typeof x.$inferSelect` / `NewX = $inferInsert`.
- `feature-flags.ts` (D30) holds the pair: `feature_flags` (platform state, `key` as the PK, no
  `tenant_id`, hence an `RLS_EXCLUDED_TABLES` entry) and `tenant_feature_overrides` (ordinary tenant
  data). Read its header before touching either — two of its choices look like mistakes and are not.
- D25: the schema is identical in `TENANCY_MODE=multi` and `single` — every table keeps `tenant_id`.

## Row-level security — read before adding a table (D1)

RLS scaffolding ships inert (`TENANT_SCOPE_MODE=off`; the `rocketflare_app` role is NOLOGIN). Policies still
exist in every environment so enabling enforcement later is a config change, not a migration.
`tests/api/rls-coverage.test.ts` reads the live catalog, so every table must do ONE of:

1. **Has `tenant_id`** → add `tenantIsolation('<table_name>')` to its extraConfig array.
   `tenants` itself uses `tenantIsolation('tenants', sql\`id\`)`; `users` uses `membershipIsolation()`.
2. **No `tenant_id`** → add it to `RLS_EXCLUDED_TABLES` in `rls.ts` WITH a reason. Pre-tenant
   infrastructure tables (`user_sessions`, `oauth_providers`, `access_requests`) additionally go in
   `RLS_REVOKED_TABLES` — `scripts/db-roles.ts` REVOKEs them from the app role outright.

The predicate `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid` is ONE shared
object; never inline a copy (drizzle-kit diffs SQL text). No `FORCE ROW LEVEL SECURITY`: the owner
connection (HYPERDRIVE) bypasses policies, which is what keeps auth paths and rollback working.
**The `eq(x.tenantId, ...)` predicates stay** — RLS is defence in depth underneath them.

## Adding a table — checklist

1. `src/db/schema/<name>.ts` with `tenantRef`, `timestamps()`, indexes, and `tenantIsolation('<name>')`.
2. Export from `index.ts`; add the row to the table registry here.
3. `pnpm db:generate` → review the SQL in `migrations/` (policies included) → `pnpm db:migrate`
   (role → migrate → grants). Tests run migrations automatically.
4. `packages/shared/src/<name>.ts` zod contract if the API exposes it (`@rocketflare/shared/<name>`).
