# Phase 2 — Schema and migration `0011_*`

**Goal:** two new tables, one widened index, one unbackfillable column, one `[vars]` key.

Both new tables carry `tenantIsolation()` (`rls-coverage.test.ts` fails until they do — by design),
are re-exported from `schema/index.ts`, and get a registry row in `db/schema/CLAUDE.md`.

## `agent_run_interrupts`

`id` (**this is the AG-UI `Interrupt.id`**), `tenantRef()`, `runId` cascade, `key`, `kind`,
`reason`, `message`, `toolCallId`, `responseSchema` jsonb, `spec` jsonb typed, `status`,
`payload` jsonb, `expiresAt`, `resolvedAt`, `resolvedByUserId` (set null), `...timestamps()`.

Indexes:

- **`UNIQUE (run_id, key)`** — T2, the idempotency that stops a re-entered `execute` asking twice
- `(tenant_id, status, created_at desc)` — the inbox
- `(tenant_id, run_id)` — the run page
- `tenantIsolation('agent_run_interrupts')`

> **`runId` is the only host-specific column.** That is the Part-3 seam: a nullable `conversationId`
> sibling with `CHECK (num_nonnulls(run_id, conversation_id) = 1)` is the entire chat-HITL migration.

## `agent_run_artifacts`

`id`, `tenantRef()`, `runId` cascade, `key`, `kind`, `title`, `description`, `data` jsonb,
`...timestamps()`. `UNIQUE (run_id, key)` (the upsert), `(tenant_id, created_at desc)`,
`(tenant_id, kind)`, `tenantIsolation()`.

A table rather than an event type — see decision 4 in [00-decisions.md](00-decisions.md).

## The widened index — the migration's whole point

```sql
DROP INDEX "agent_runs_active_exclusive_idx";
CREATE UNIQUE INDEX "agent_runs_active_exclusive_idx" ON "agent_runs" ("tenant_id","agent_key")
  WHERE "status" IN ('queued','running','awaiting_input');
```

A parked run is still *the* active run for `(tenant, agent_key)`. Leave the predicate alone and a
second enqueue slips past the exclusive guarantee while the first waits on a human.

`agent_runs.status` itself needs **no DDL** — the column is `text`.

> **After `pnpm db:generate`, read the SQL.** drizzle-kit is weak on changed partial-index
> predicates and may emit only a `CREATE`. Hand-write the `DROP` if so. The `CREATE UNIQUE INDEX`
> is non-concurrent and takes an `ACCESS EXCLUSIVE` lock; `agent_runs` is small, so this is fine —
> and saying so beats discovering it.

## Also in this migration: `ai_usage.agent_run_id`

Nullable uuid, `ON DELETE SET NULL`. Per-run cost is **not attributable today** (`ai_usage` has
`feature`, `tenantId`, `userId` and no run id) and **cannot be backfilled later** — the same
argument the `costMicrocents` comment already makes. One column now or never. The Usage tab in
[phase 7](07-ui.md) tells the truth about it until it is populated.

## Config

`AGENT_INTERRUPT_TIMEOUT = "168 hours"` in `config.ts`, `.dev.vars.example`, and `[vars]` of
**both** tomls — `wrangler-parity.test.ts` compares `[vars]` keys, so one file is a red build.

Confirmed against [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/):
wall clock per step is **unlimited** on Paid, `waitForEvent` accepts **1 s – 365 days** (default
24 h), and **`waiting` instances do not count toward concurrency**. So 7 days is well inside range
and parking really is free.

> **But instance retention is 30 days on Paid and 3 days on Free**, and that is the real bound. On
> Free, a run parked longer than 3 days loses its instance, `waitForEvent` never fires, and only
> T6's read-path `expireParkedRun` plus the `not_found` restart recover it. Document the default as
> "≤ 3 days if you are not on Workers Paid".

## Done when

- [ ] `pnpm db:generate` reviewed by hand; the DROP+CREATE is present
- [ ] `pnpm db:migrate` clean on a fresh database
- [ ] `rls-coverage.test.ts` green for both tables
- [ ] `wrangler-parity.test.ts` green with the new `[vars]` key in both tomls
- [ ] `kit-manifest.test.ts` green (new files under `apps/web/src/**` are already `core`)
