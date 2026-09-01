/**
 * Tenant, tenant settings and per-user preferences (D13, D25). Every function takes the tenant id
 * from the auth context — never from the request.
 */

import type {
  TenantSettings as TenantSettingsDto,
  UpdateTenantSettingsRequest,
} from '@gmgo/shared/tenant-settings'
import type { Tenant as TenantDto, UpdateTenantRequest } from '@gmgo/shared/tenants'
import type {
  TenantUserSettings as TenantUserSettingsDto,
  UserPreferences,
} from '@gmgo/shared/user-settings'
import { and, eq } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { tenantSettings, tenants, tenantUserSettings } from '../../db/schema'
import { ConflictError, NotFoundError } from '../utils/core/errors'
import { nudge, type Realtime, realtimeEvent } from './realtime'

export function toTenantDto(row: typeof tenants.$inferSelect): TenantDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function getTenant(db: Database, tenantId: string): Promise<TenantDto> {
  const row = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) })
  if (!row) throw new NotFoundError('Organisation not found')
  return toTenantDto(row)
}

export async function updateTenant(
  db: Database,
  tenantId: string,
  patch: UpdateTenantRequest,
  realtime?: Realtime
) {
  if (patch.slug) {
    const clash = await db.query.tenants.findFirst({
      columns: { id: true },
      where: eq(tenants.slug, patch.slug),
    })
    if (clash && clash.id !== tenantId)
      throw new ConflictError('That slug is already taken', 'slug_taken')
  }
  const [row] = await db
    .update(tenants)
    .set({
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.slug !== undefined && { slug: patch.slug }),
    })
    .where(eq(tenants.id, tenantId))
    .returning()
  if (!row) throw new NotFoundError('Organisation not found')
  nudge(realtime, realtimeEvent('tenant.changed', tenantId, { id: tenantId }))
  return toTenantDto(row)
}

/** Cascades through every `tenantRef` FK — one statement removes the organisation's world. */
export async function deleteTenant(
  db: Database,
  tenantId: string,
  realtime?: Realtime
): Promise<void> {
  const rows = await db
    .delete(tenants)
    .where(eq(tenants.id, tenantId))
    .returning({ id: tenants.id })
  if (rows.length === 0) throw new NotFoundError('Organisation not found')
  // Members still connected refetch the session and land on /select-tenant.
  nudge(realtime, realtimeEvent('tenant.changed', tenantId, { id: tenantId }))
}

function toSettingsDto(row: typeof tenantSettings.$inferSelect): TenantSettingsDto {
  return {
    tenantId: row.tenantId,
    timezone: row.timezone,
    notificationsEnabled: row.notificationsEnabled,
    settings: row.settings,
    updatedAt: row.updatedAt,
  }
}

/** Read (creating the default row on first access). */
export async function getTenantSettings(
  db: Database,
  tenantId: string
): Promise<TenantSettingsDto> {
  const existing = await db.query.tenantSettings.findFirst({
    where: eq(tenantSettings.tenantId, tenantId),
  })
  if (existing) return toSettingsDto(existing)
  const [row] = await db
    .insert(tenantSettings)
    .values({ tenantId })
    .onConflictDoNothing()
    .returning()
  if (row) return toSettingsDto(row)
  return getTenantSettings(db, tenantId)
}

export async function updateTenantSettings(
  db: Database,
  tenantId: string,
  patch: UpdateTenantSettingsRequest
): Promise<TenantSettingsDto> {
  const current = await getTenantSettings(db, tenantId)
  const [row] = await db
    .update(tenantSettings)
    .set({
      timezone: patch.timezone ?? current.timezone,
      notificationsEnabled: patch.notificationsEnabled ?? current.notificationsEnabled,
      settings: patch.settings ? { ...current.settings, ...patch.settings } : current.settings,
    })
    .where(eq(tenantSettings.tenantId, tenantId))
    .returning()
  if (!row) throw new NotFoundError('Organisation not found')
  return toSettingsDto(row)
}

function toPrefsDto(row: typeof tenantUserSettings.$inferSelect): TenantUserSettingsDto {
  return {
    tenantId: row.tenantId,
    userId: row.userId,
    preferences: row.preferences,
    updatedAt: row.updatedAt,
  }
}

export async function getUserPreferences(db: Database, tenantId: string, userId: string) {
  const existing = await db.query.tenantUserSettings.findFirst({
    where: and(eq(tenantUserSettings.tenantId, tenantId), eq(tenantUserSettings.userId, userId)),
  })
  if (existing) return toPrefsDto(existing)
  const [row] = await db
    .insert(tenantUserSettings)
    .values({ tenantId, userId })
    .onConflictDoNothing()
    .returning()
  if (row) return toPrefsDto(row)
  return getUserPreferences(db, tenantId, userId)
}

/** Shallow merge; a key set to `null` is removed. */
export async function updateUserPreferences(
  db: Database,
  tenantId: string,
  userId: string,
  preferences: UserPreferences
) {
  const current = await getUserPreferences(db, tenantId, userId)
  const merged: UserPreferences = { ...current.preferences }
  for (const [key, value] of Object.entries(preferences)) {
    if (value === null) delete merged[key]
    else merged[key] = value
  }
  const [row] = await db
    .update(tenantUserSettings)
    .set({ preferences: merged })
    .where(and(eq(tenantUserSettings.tenantId, tenantId), eq(tenantUserSettings.userId, userId)))
    .returning()
  return row ? toPrefsDto(row) : current
}
