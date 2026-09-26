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
| `AgentRun` (D7, #17) | manage | manage | manage | manage | manage (own runs — `routes/agents.ts` filters by `requestedByUserId` unless `isAdminLevel(auth)`, which sees and cancels every run) |
| `Group` (D29) | manage | manage | manage | manage | read (administering groups is `manage Group`; a member's only read is `GET /api/groups/mine`. Which ROWS a group lets you see is a SQL predicate in `services/access.ts`, never a CASL condition) |
| `Document` (D18) | manage | manage | manage | manage | create + read (anyone ingests and searches; own-document delete is `routes/ai-documents.ts`'s `ownerUserId` check, others' need `delete Document`) |
| `AccessRequest`, `User` (platform) | manage | – | – | – | – |
| `Feature:<name>` via `access` | all | by `features` | by `features` | all | by `features` |
| `FeatureFlag` (D30, administering flags) | manage | – | – | – | – |
| `Trace` (D32) | manage | read | read | read | – |
| `Feedback` (D33, thumbs on AI answers) | manage | create + read | create + read | create + read | create only (on an answer they can read — `services/feedback.ts` checks the target; reading ratings back is admin+) |

- Actions: `manage` (wildcard) · `create` · `read` · `update` · `delete` · `access` (features only)
- Roles come from `tenant_users.role`; `support` is minted only from `/admin`. `globalAdmin` is `users.isGlobalAdmin`
- **Owner-only checks are explicit `role === 'owner'`, not CASL** (`isOwnerLevel` in
  `src/api/middleware/permissions.ts`): delete tenant, transfer/assign `owner`. `manage Tenant` alone
  is NOT proof of ownership — `support` and global admins hold it too
- `features: string[]` comes from `src/permissions/features.ts` (D30) and only ever ADDS `access` rules
- **Never gate a surface on `access Feature:<name>`.** `globalAdmin` is `manage all` and `support`
  is granted `access all`; in CASL both are wildcards covering `access` on every `Feature:` subject,
  so an ability check answers "on" for platform staff whatever the deployment ships — while
  `requireFeature` and an installed plugin's own registries, which read the ARRAY, answer "off". An app on
  this kit shipped that and had five routes open in production to staff. A flag is CONFIGURATION:
  read `auth.features` / `session.features`. `applyFeatureFlags` stays for an app that wants
  permission-style entitlements, and nothing hiding a dark surface may use it

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

A PLUGIN (D31) never touches either literal: it declares the noun in `SharedPlugin.subjects` (which
`Subjects` unions in as `PluginSubject`) and its rules in `ServerPlugin.grants`, run after the
kit's matrix in `buildAbility`. Those grants are **additive and over the plugin's OWN subjects** —
CASL can only take a rule back with `cannot`, so a plugin that revoked a kit grant would change what
every role may do merely by being installed. The core matrix test stays core-only; a plugin ships
its own.

**Answering an agent's question is `update AgentRun` PLUS a policy the ABILITY cannot express**
(issue #17). `AgentMeta.approvers` is `'requester'` (the default — anyone who can see the run) or
`'admin'`, and `canAnswer` in `routes/agents.ts` is `approversFor(agentKey) === 'admin' ?
isAdminLevel(auth) : <the run is visible to you>`. It is a route check rather than a CASL condition
for the reason every "is this row yours" check in this kit is: an ability answers "may this role do
this KIND of thing", and the rest is a predicate where the query is. The inbox
(`GET /api/agents/interrupts`) returns `canAnswer` **per item instead of filtering**, so somebody
sees the question they may not answer rather than a hole they cannot explain.
