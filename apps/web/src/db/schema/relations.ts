/**
 * The `many()` side of every relation, kept OUT of `users.ts` / `tenants.ts` (D1): those two are
 * imported by every other table file, and `tenantRef(tenants)` evaluates its argument at module
 * load, so a hub table importing its dependents would be a circular-import TDZ error. The `one()`
 * sides live next to their tables.
 */
import { relations } from 'drizzle-orm'
import { accessRequests } from './access-requests'
import { activityEvents } from './activity-events'
import { apiKeys } from './api-keys'
import { files } from './files'
import { notifications } from './notifications'
import { oauthProviders } from './oauth-providers'
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
}))
