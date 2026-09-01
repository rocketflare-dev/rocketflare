# Permissions (CASL) — D10

`buildAbility({ role, isGlobalAdmin, features })` → typed `AppAbility` (`MongoAbility<[Actions, Subjects]>`,
vocabulary in `src/shared/permissions.ts`). Built once per request by the auth middleware into
`c.get('auth').ability`; shipped to the UI as `packRules(ability)` on `/auth/session.permissions`.

## Matrix (02 §10b — `abilities.ts` implements exactly this)

| Subject \ Role | globalAdmin | owner | admin | support | member |
|---|---|---|---|---|---|
| `all` | manage | – | – | – | – |
| `Tenant` | manage | manage | read | manage | read |
| `TenantMember`, `Invitation`, `ApiKey`, `ActivityEvent` | manage | manage | manage | manage | read |
| `Notification` (own, route-scoped) | manage | manage | manage | manage | manage |
| `AccessRequest`, `User` (platform) | manage | – | – | – | – |
| `Feature:<name>` via `access` | all | by `features` | by `features` | all | by `features` |

- Actions: `manage` (wildcard) · `create` · `read` · `update` · `delete` · `access` (features only)
- Roles come from `tenant_users.role`; `support` is minted only from `/admin`. `globalAdmin` is `users.isGlobalAdmin`
- **Owner-only checks are explicit `role === 'owner'`, not CASL** (`isOwnerLevel` in
  `src/api/middleware/permissions.ts`): delete tenant, transfer/assign `owner`. `manage Tenant` alone
  is NOT proof of ownership — `support` and global admins hold it too
- `features: string[]` is injected by the app (tenant flag, KV, env) and only ever ADDS `access` rules

## Usage

Server: `guardPermission(c, 'manage', 'TenantMember')` throws 401/403; `can(c, …)` for branching.
UI: `AbilityProvider` rebuilds with `abilityFromPackedRules(session.permissions)`; `<Can I="read" a="ApiKey">`.
Tests: `tests/config/permissions.test.ts` asserts every cell above — change the table and the test together.

## Adding a subject

Add it to `CORE_SUBJECTS` in `src/shared/permissions.ts`, grant it per role here (default posture:
owner/admin/support `manage`, member `read`), add the row above and to the matrix test.
