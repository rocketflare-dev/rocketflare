# Permissions (CASL) — D10

`buildAbility({ role, isGlobalAdmin, features })` → typed `AppAbility` (`MongoAbility<[Actions, Subjects]>`,
vocabulary in `packages/shared/src/permissions.ts`). Built once per request by the auth middleware into
`c.get('auth').ability`; shipped to the UI as `packRules(ability)` on `/auth/session.permissions`.

## Matrix (02 §10b — `abilities.ts` implements exactly this)

| Subject \ Role | globalAdmin | owner | admin | support | member |
|---|---|---|---|---|---|
| `all` | manage | – | – | – | – |
| `Tenant` | manage | manage | read | manage | read |
| `TenantMember`, `Invitation`, `ApiKey`, `ActivityEvent` | manage | manage | manage | manage | read |
| `Notification` (own, route-scoped) | manage | manage | manage | manage | manage |
| `File` (D23) | manage | manage | manage | manage | create + read (own-file delete is `routes/files.ts`'s `ownerUserId` check, not CASL) |
| `AiConfig`, `Prompt` (D17) | manage | manage | manage | manage | read (Settings → AI / Prompts are read-only for members; `/api/ai/usage` and `/api/ai/agent-models` writes need `manage AiConfig`) |
| `Conversation` (D17) | manage | manage | manage | manage | manage (own only — `routes/chat.ts` filters every query by `userId`; another member's thread is 404, admins included) |
| `AgentRun` (D7) | manage | manage | manage | manage | manage (own runs — `routes/agents.ts` filters by `requestedByUserId` unless `isAdminLevel(auth)`, which sees and cancels every run) |
| `Document` (D18) | manage | manage | manage | manage | create + read (anyone ingests and searches; own-document delete is `routes/ai-documents.ts`'s `ownerUserId` check, others' need `delete Document`) |
| `Dashboard` (D19, `analytics_pages`) | manage | manage | manage | manage | read |
| `Analytics` (D19, the cube API `/cubejs-api`, `/mcp`) | manage | read | read | read | read |
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

Add it to `CORE_SUBJECTS` in `packages/shared/src/permissions.ts`, grant it per role here (default
posture: owner/admin/support `manage` via `ADMIN_MANAGED`, member `read` via `MEMBER_READABLE`; add
an explicit `can('create', …)` for the member only when anyone may write, as `File` and `Document`
do; `can('manage', …)` for the member only when ownership is enforced by the route's `userId`
filter, as `Conversation` and `AgentRun` are), add the row above and to the matrix test
(`tests/config/permissions.test.ts`). CASL conditions are never used — "own" is always a route predicate.
