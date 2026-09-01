/**
 * Per-tenant settings contract (D13, D25 — rendered as "Workspace settings" in single mode).
 * `timezone` and `notificationsEnabled` are columns; `settings` is the app-extensible jsonb bag,
 * typed here so the column and the API agree.
 */
import { z } from 'zod'

/** Extend per app (`z.object({...}).passthrough()`); the kit ships an open record. */
export const tenantSettingsJsonSchema = z.record(z.string(), z.unknown())
export type TenantSettingsJson = z.infer<typeof tenantSettingsJsonSchema>

export const timezoneSchema = z.string().trim().min(1).max(64)

export const tenantSettingsSchema = z.object({
  tenantId: z.string().uuid(),
  timezone: timezoneSchema,
  notificationsEnabled: z.boolean(),
  settings: tenantSettingsJsonSchema,
  updatedAt: z.coerce.date(),
})
export type TenantSettings = z.infer<typeof tenantSettingsSchema>

/** Partial update — any subset; `settings` is shallow-merged by the server. */
export const updateTenantSettingsRequestSchema = z
  .object({
    timezone: timezoneSchema,
    notificationsEnabled: z.boolean(),
    settings: tenantSettingsJsonSchema,
  })
  .partial()
export type UpdateTenantSettingsRequest = z.infer<typeof updateTenantSettingsRequestSchema>
