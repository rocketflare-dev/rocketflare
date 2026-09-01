/**
 * The `many()` side of every relation, kept OUT of `users.ts` / `tenants.ts` (D1): those two are
 * imported by every other table file, and `tenantRef(tenants)` evaluates its argument at module
 * load, so a hub table importing its dependents would be a circular-import TDZ error. The `one()`
 * sides live next to their tables.
 */
import { relations } from 'drizzle-orm'
import { accessRequests } from './access-requests'
import { activityEvents } from './activity-events'
import { agentModels } from './agent-models'
import { agentRunEvents } from './agent-run-events'
import { agentRuns } from './agent-runs'
import { aiConfigs } from './ai-configs'
import { aiUsage } from './ai-usage'
import { apiKeys } from './api-keys'
import { chunks } from './chunks'
import { conversations } from './conversations'
import { documents } from './documents'
import { files } from './files'
import { notifications } from './notifications'
import { oauthProviders } from './oauth-providers'
import { promptOverrides } from './prompt-overrides'
import { teamInvitations } from './team-invitations'
import { tenantSettings } from './tenant-settings'
import { tenantUserSettings } from './tenant-user-settings'
import { tenantUsers } from './tenant-users'
import { tenants } from './tenants'
import { userSessions } from './user-sessions'
import { users } from './users'

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(tenantUsers),
  sessions: many(userSessions),
  oauthProviders: many(oauthProviders),
  apiKeys: many(apiKeys),
  notifications: many(notifications),
  accessRequests: many(accessRequests, { relationName: 'requester' }),
  tenantUserSettings: many(tenantUserSettings),
  files: many(files),
  conversations: many(conversations),
  agentRuns: many(agentRuns),
  documents: many(documents),
}))

export const tenantsRelations = relations(tenants, ({ one, many }) => ({
  members: many(tenantUsers),
  invitations: many(teamInvitations),
  apiKeys: many(apiKeys),
  settings: one(tenantSettings, {
    fields: [tenants.id],
    references: [tenantSettings.tenantId],
  }),
  notifications: many(notifications),
  activityEvents: many(activityEvents),
  files: many(files),
  aiConfigs: many(aiConfigs),
  aiUsage: many(aiUsage),
  promptOverrides: many(promptOverrides),
  conversations: many(conversations),
  agentModels: many(agentModels),
  agentRuns: many(agentRuns),
  agentRunEvents: many(agentRunEvents),
  documents: many(documents),
  chunks: many(chunks),
}))
