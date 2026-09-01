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
`filePath(id)`, `fileSchema`/`uploadResponseSchema`, `uploadQuerySchema` (D23)

Adding a job type: a payload schema + a variant in BOTH `jobInputSchema` and `jobEnvelopeSchema` +
the literal in `JOB_TYPES` (then the handler table in `apps/web/src/api/queues/jobs.ts`). A breaking
payload change is a NEW type (`email.send.v2`) — the `type` string is the version seam. Adding a
realtime event type: the enum + its roots in `REALTIME_INVALIDATIONS` (a ui test checks every root
is a `queryKeys` family). Adding a file scope: `FILE_SCOPES` here AND the mirrored enum in
`apps/web/src/db/schema/files.ts`.

## Rules

- Imports: `zod`, sibling files, and TYPE-only imports from `@casl/ability`. NEVER import from
  `apps/web/src/api`, `apps/web/src/db`, `apps/web/src/ui` or `apps/cli` — this package bundles into the browser and the CLI
- `tenantRoleSchema` (assignable) on every input; `membershipRoleSchema` (+`support`) on outputs only
- Server code imports via `@gmgo/shared/*`; UI too. Re-export every file from `index.ts`
