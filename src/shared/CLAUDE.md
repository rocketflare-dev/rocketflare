# Shared Contracts (`src/shared/`)

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
`permissions.ts` actions/subjects/`AppAbility`/packed rules (matrix lives in `src/permissions/`) ·
`api-keys.ts` · `tenant-settings.ts` · `user-settings.ts` · `notifications.ts` · `admin.ts` ·
`activity.ts` · `errors.ts` envelope + codes · `pagination.ts`

## Rules

- Imports: `zod`, sibling files, and TYPE-only imports from `@casl/ability`. NEVER import from
  `src/api`, `src/db` or `src/ui` — this directory bundles into the browser
- `tenantRoleSchema` (assignable) on every input; `membershipRoleSchema` (+`support`) on outputs only
- Server code imports via `@shared/*`; UI too. Re-export every file from `index.ts`
