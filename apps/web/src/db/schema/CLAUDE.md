# Database Schema

Drizzle table definitions, one file per table, re-exported from `index.ts` (which `drizzle.config.ts`,
`src/db/client.ts` and the RLS coverage test all read). `many()` relations live in `relations.ts`
(the hub tables `users`/`tenants` must not import their dependents — `tenantRef(tenants)` is eager).

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
| `activity_events` | `activity-events.ts` | `tenant_id` | ✓ | audit log + analytics source; `(tenant_id, created_at DESC)` |
| `files` | `files.ts` | `tenant_id` | ✓ | R2 object index (D23): `key` unique (`tenants/<tenant>/<scope>/<uuid>-<name>`), `scope` enum, `ownerUserId`, immutable (no `updated_at`) |
| `ai_configs` | `ai-configs.ts` | `tenant_id` | ✓ | tenant AI providers (D17): `scope` chat\|embeddings, `provider` text enum, `label` (unique per tenant+scope, the upsert key), `apiKeyEnc` (AES-GCM, never returned), `thinking` jsonb, partial unique **one default per (tenant, scope)**; only `services/ai/resolve.ts` reads it |
| `prompt_overrides` | `prompt-overrides.ts` | `tenant_id` | ✓ | PK `(tenant_id, key)`; row exists only when a registry prompt is overridden (revert = delete); `updatedByUserId` |
| `conversations` | `conversations.ts` | `tenant_id` | ✓ | chat threads (D17): `userId` is ownership (routes filter tenant AND user — others' threads are 404), `provider`/`model` frozen at creation, `lastMessageAt`; index `(tenant_id, user_id, last_message_at DESC)` |
| `messages` | `messages.ts` | `tenant_id` | ✓ | chat turns: `role` text enum, `content`, `toolCalls` jsonb, `usage` jsonb; immutable. Index `(conversation_id, created_at)` — deliberate exception to tenant-first (fetched by thread id after the ownership check) |
| `ai_usage` | `ai-usage.ts` | `tenant_id` | ✓ | one row per generation (D18): `feature`, `provider`, `model`, four token counters, `costMicrocents` nullable bigint, `at`; append-only; index `(tenant_id, at DESC)` |
| `agent_models` | `agent-models.ts` | `tenant_id` | ✓ | per-agent model assignment (D17): PK `(tenant_id, prompt_key)`; `aiConfigId` nullable FK → `ai_configs` **cascade** (deleting a provider reverts its agents), `model` nullable; row exists only when overridden (revert = delete); only `services/ai/resolve.ts` reads it |
| `agent_runs` | `agent-runs.ts` | `tenant_id` | ✓ | one row per agent run (D7): `agentKey` text, `status` text enum `queued\|running\|succeeded\|failed\|cancelled`, `input`/`output` jsonb, `error`, `requestedByUserId`, `instanceId` unique (= Workflow instance id = run id), `attempt`, `startedAt`/`finishedAt`, `cancelRequestedAt` (cooperative cancel flag). **Partial unique `agent_runs_active_exclusive_idx` on `(tenant_id, agent_key) WHERE status IN ('queued','running')` = the exclusive guarantee.** Claim = `UPDATE … WHERE status IN (queued,running) RETURNING` |
| `agent_run_events` | `agent-run-events.ts` | `tenant_id` | ✓ | append-only progress log (D7/D8): `runId` cascade, per-run `seq` (unique `(run_id, seq)`), `type` `step\|tool.start\|tool.end\|text\|status\|error`, `data` jsonb, `at`. DB is the truth; the hub carries an `entity.changed {entity:'agent-run'}` nudge |
| `documents` | `documents.ts` | `tenant_id` | ✓ | text a tenant indexed for retrieval (D18): `ownerUserId`, `title`, `source`, `contentType`, `sizeBytes`, `content` (raw text, API-invisible — the `document.index` job re-reads it), `chunkCount`, `embeddingModel`, `status` `pending\|indexed\|failed`, `error` |
| `analytics_pages` | `analytics-pages.ts` | `tenant_id` | ✓ | dashboards (D19): `slug` unique per tenant (= `templateKey` for seeded pages), `config` jsonb `$type<DashboardConfig>` (drizzle-cube/client, type-only), `templateKey` nullable (null = user-created; non-null = resettable), `isDefault`, `sortOrder`, `createdByUserId` set-null. Seeded per tenant by `services/dashboard-templates.ts` |
| `tenant_activity_daily_facts` | `facts/tenant-activity-daily-facts.ts` | `tenant_id` | ✓ | the example FACT table (D19): grain `(tenant_id, day date, user_id nullable)` with `UNIQUE NULLS NOT DISTINCT` (PG15+) so NULL actors collapse to one row; `event_count`, `distinct_event_types`, `first/last_event_at`, `fact_refreshed_at` watermark; no `id`, no FK to users. Rebuilt per tenant by `services/fact-tables` (DELETE+INSERT, cron `15 * * * *`); read by the `TenantActivityDaily` cube |
| `chunks` | `chunks.ts` | `tenant_id` | ✓ | retrieval units (D17/D18): `documentId` cascade, `seq` (unique per document), `text`, `tokenCount` (char estimate), `embedding vector(1024)` (`EMBEDDING_DIM`; a new dimension is a new table); **HNSW `vector_cosine_ops`** index; lexical half is `to_tsvector('english', text)` at query time (generated tsvector + GIN is the scaling path) |

22 policies (`tenants`, `users` + 20 tenant tables); 4 revoked tables = `RLS_REVOKED_TABLES` =
`RLS_EXCLUDED_TABLES`. jsonb columns are `$type<>()`d from `@gmgo/shared` (type-only imports).

## Conventions

- PK: `uuid('id').primaryKey().defaultRandom()`. No ULIDs.
- Tenant FK: `tenantId: tenantRef(tenants)` from `_helpers.ts` → `tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`. First column of every index on a tenant table is `tenant_id`.
- Timestamps: `...timestamps()` from `_helpers.ts` — `created_at`/`updated_at` as **`timestamptz`**. Never a naive `timestamp`.
- extraConfig is the **array** form: `table => [index(...), tenantIsolation('x')]` (required for `pgPolicy`).
- Fact tables live in `facts/` (barrel `facts/index.ts`): plain tables, grain-unique, `fact_refreshed_at`, no surrogate id; they are registered in `api/services/fact-tables/registry.ts` too.
- Enums via `pgEnum`, exported; `relations()` next to the table; `export type X = typeof x.$inferSelect` / `NewX = $inferInsert`.
- D25: the schema is identical in `TENANCY_MODE=multi` and `single` — every table keeps `tenant_id`.

## Row-level security — read before adding a table (D1)

RLS scaffolding ships inert (`TENANT_SCOPE_MODE=off`; the `gmgo_app` role is NOLOGIN). Policies still
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
4. `packages/shared/src/<name>.ts` zod contract if the API exposes it (`@gmgo/shared/<name>`).
