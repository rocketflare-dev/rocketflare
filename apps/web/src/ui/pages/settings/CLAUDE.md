# Settings UI (`/settings`)

One page, `SettingsLayout` with `URLTabs`
(`?tab=general|people|groups|api-keys|ai|prompts|agent-models|usage`), behind
`RequireGuard guard="admin"`. `groups` renders only for `manage Group`, `agent-models` and
`usage` only for `manage AiConfig` — a tab you cannot save from is worse than no tab. `ai` and
`prompts` degrade to read-only inside; owner-only content (slug, delete org) gates inside its tab.
Installed plugins append tabs LAST via `settingsTabs(ctx)`.

## AI (`AI.tsx`, `AiConfigModal.tsx`, `hooks/useAiConfig.ts`)

- The providers catalog (`GET /api/ai/config/providers`) has NO shared schema, so
  `useAiConfig.ts` carries a permissive `passthrough` one. `presetsFor`, `THINKING_*` come from
  `@rocketflare/shared/ai/config`.
- The label is the upsert key `(tenant, scope, label)` — read-only on edit (renaming would create a
  second row). `apiKey` is write-only: blank on edit keeps the stored key (`hasCredential`);
  switching provider on edit requires a new key. `serviceTier: ''` clears. "Set default" re-posts
  the row with `isDefault: true` and no `apiKey`.
- A member (`read AiConfig` / `read Prompt`) has no nav path to `/settings`, so the read-only
  rendering of the AI and Prompts tabs is exercised component-level in tests only.

## Agent models (`AgentModels.tsx`, `hooks/useAgentModels.ts`)

- `GET /api/ai/agent-models` is the whole truth (every prompt key, its assignment, and the effective
  provider/model/source the server computed) — the page never re-derives it.
- Override modal: pick a chat `ai_configs` row (`configsForScope(configs, 'chat')`; blank = keep the
  default config) and/or type a model; validated with `upsertAgentModelRequestSchema` (at least
  one), and `PUT` sends ONLY the set fields (the PUT replaces the row, so a blank model clears it).
  "Use default" is `DELETE` — absence is the default.
- Source badges: `agent` (assignment), `tenant`, `platform`, `none` (→ EmptyState linking
  `/settings?tab=ai`).

## Groups (`Groups.tsx`, `GroupMembersModal.tsx`, `hooks/useGroups.ts`)

- Group TYPES on the left, that type's groups on the right, `GroupMembersModal` for membership.
- **Deleting quotes the 409.** Deleting a type or group that still controls access answers
  `group_in_use` with one count per restrictable resource (core `documents` plus one per installed
  plugin — read the keys generically, never as a fixed pair); the confirm shows the counts, says
  the content narrows to its owner and administrators (never opens), and only then offers "Delete
  anyway" (`?force=1`).
- People has a Groups column + Edit groups (`MemberGroupsModal`, `useSetMemberGroups`); the profile
  shows a read-only "Your groups" (hidden when in none).
- Freshness is the generic nudge: one `['groups']` family (the root `entity.changed { entity:
  'groups' }` names), and `access.changed` (sent to the affected people only) invalidates
  `['auth'] ['documents'] ['groups']` plus every installed plugin's `realtimeRoots`. No hook here
  touches the socket.

## Tests

`tests/ui/`: `ai-settings`, `prompts-settings`, `agent-models-settings`, `usage-settings`, `people`,
`api-keys`, `groups` (list/create flows, the 409 confirm, the `AccessPicker` empty-selection
warning).
