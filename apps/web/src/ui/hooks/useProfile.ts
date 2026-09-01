/**
 * The signed-in person (D13): `GET/PATCH /api/me`, per-tenant preferences, linked sign-in
 * providers, and the avatar upload (`POST /api/files?scope=avatars`, D23). Profile edits also
 * refresh the session (name/avatar live there too).
 *
 * Contract note: `/api/me` is assumed to return `userSchema` and `/api/me/preferences`
 * `tenantUserSettingsSchema`. `GET /auth/providers` has no shared schema; it is read tolerantly as
 * `{ providers: [{ provider, createdAt? }] }` (the linked ones, mirroring `adminUserDetailSchema`).
 */
import { userSchema } from '@rocketflare/shared/auth'
import {
  AVATAR_MIME_TYPES,
  isAvatarMimeType,
  MAX_UPLOAD_BYTES,
  uploadResponseSchema,
} from '@rocketflare/shared/files'
import {
  tenantUserSettingsSchema,
  type UpdateProfileRequest,
  type UpdateTenantUserSettingsRequest,
} from '@rocketflare/shared/user-settings'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { useAuth } from '@/ui/hooks/useAuth'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

export function meQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.me.profile,
    queryFn: () => api.get('/api/me', { schema: userSchema }),
  })
}

export function useMe() {
  return useQuery(meQueryOptions())
}

export function useUpdateProfile() {
  const queryClient = useQueryClient()
  const { refresh } = useAuth()
  return useMutation({
    mutationFn: (body: UpdateProfileRequest) =>
      api.patch('/api/me', body, {
        schema: userSchema,
        showSuccessToast: true,
        successMessage: 'Profile updated',
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.me.all })
      await refresh()
    },
  })
}

// ---- Avatar upload (D23) ------------------------------------------------------------------

export const AVATAR_ACCEPT = AVATAR_MIME_TYPES.join(',')

/** Client-side check mirroring the server's 415/413 — returns a message, or null when acceptable. */
export function validateAvatarFile(file: File): string | null {
  if (!isAvatarMimeType(file.type)) return 'Choose a PNG, JPEG, GIF or WebP image'
  if (file.size === 0) return 'That file is empty'
  if (file.size > MAX_UPLOAD_BYTES) {
    return `Images must be ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB or smaller`
  }
  return null
}

/** Uploads to `/api/files?scope=avatars`; the server sets `users.avatarUrl`, so refresh both caches. */
export function useUploadAvatar() {
  const queryClient = useQueryClient()
  const { refresh } = useAuth()
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData()
      form.append('file', file, file.name)
      return api.upload('/api/files?scope=avatars', form, {
        schema: uploadResponseSchema,
        showSuccessToast: true,
        successMessage: 'Photo updated',
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.me.all })
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.all })
      await refresh()
    },
  })
}

export function preferencesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.me.preferences,
    queryFn: () => api.get('/api/me/preferences', { schema: tenantUserSettingsSchema }),
  })
}

export function usePreferences() {
  return useQuery(preferencesQueryOptions())
}

export function useUpdatePreferences() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateTenantUserSettingsRequest) =>
      api.patch('/api/me/preferences', body, {
        schema: tenantUserSettingsSchema,
        showSuccessToast: true,
        successMessage: 'Preferences saved',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.me.preferences }),
  })
}

// ---- Linked providers -----------------------------------------------------------------------

export const linkedProvidersSchema = z.object({
  providers: z.array(
    z.object({ provider: z.string(), createdAt: z.coerce.date().nullable().optional() })
  ),
})
export type LinkedProviders = z.infer<typeof linkedProvidersSchema>

export function linkedProvidersQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.auth.providers,
    queryFn: () => api.get('/auth/providers', { schema: linkedProvidersSchema }),
  })
}

export function useLinkedProviders() {
  return useQuery(linkedProvidersQueryOptions())
}

export function useUnlinkProvider() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (provider: string) =>
      api.delete(`/auth/providers/${encodeURIComponent(provider)}`, undefined, {
        showSuccessToast: true,
        successMessage: 'Sign-in method disconnected',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.auth.providers }),
  })
}
