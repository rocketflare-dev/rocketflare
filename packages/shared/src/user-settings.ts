/**
 * The user's own profile and per-tenant preferences (D13). Profile fields belong to the PERSON
 * (`users`), preferences to the person-in-this-tenant (`tenant_user_settings.preferences`).
 */
import { z } from 'zod'
import { userSchema } from './auth'

export const updateProfileRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    avatarUrl: z.string().url().max(2048).nullable(),
  })
  .partial()
  .refine(v => v.name !== undefined || v.avatarUrl !== undefined, {
    message: 'Provide at least one of name or avatarUrl',
  })
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>

/** Extend per app; the kit ships an open record. */
export const userPreferencesSchema = z.record(z.string(), z.unknown())
export type UserPreferences = z.infer<typeof userPreferencesSchema>

export const tenantUserSettingsSchema = z.object({
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  preferences: userPreferencesSchema,
  updatedAt: z.coerce.date(),
})
export type TenantUserSettings = z.infer<typeof tenantUserSettingsSchema>

/** Shallow-merged into the stored preferences by the server. */
export const updateTenantUserSettingsRequestSchema = z.object({
  preferences: userPreferencesSchema,
})
export type UpdateTenantUserSettingsRequest = z.infer<typeof updateTenantUserSettingsRequestSchema>

/** `GET /api/me` — the signed-in user plus their preferences for the selected tenant (flat, not wrapped). */
export const meResponseSchema = userSchema.extend({ preferences: userPreferencesSchema })
export type MeResponse = z.infer<typeof meResponseSchema>
