import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { api } from '@/ui/lib/api-client'
import { type AppEnv, isAppEnv } from '@/ui/lib/environment'
import { queryKeys } from '@/ui/lib/query-keys'

/** Fallback shown before `/api/health` answers, or if it lacks a `name`. */
export const APP_NAME = 'Rocketflare'

/**
 * Contract with `GET /api/health` (src/api/routes/health.ts):
 *   `{ status: 'ok', version: RELEASE_VERSION, env: APP_ENV, name?: APP_NAME }`
 * Tolerant on purpose — a missing `env` shows NO badge rather than a wrong one, and a missing
 * `version` shows "dev".
 */
export const appInfoSchema = z
  .object({
    status: z.string().optional(),
    name: z.string().optional(),
    version: z.string().default('dev'),
    env: z.unknown().transform((v): AppEnv => (isAppEnv(v) ? v : 'production')),
  })
  .passthrough()

export type AppInfo = z.infer<typeof appInfoSchema>

export function appInfoQueryOptions() {
  return {
    queryKey: queryKeys.appInfo.all,
    queryFn: () => api.get('/api/health', { schema: appInfoSchema }),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  }
}

/**
 * Version + environment for the shell (EnvironmentBadge, SideNav footer, tab title, Home).
 * Undefined fields while loading; components render nothing rather than a placeholder.
 */
export function useAppInfo() {
  const query = useQuery(appInfoQueryOptions())
  return {
    name: query.data?.name ?? APP_NAME,
    version: query.data?.version,
    env: query.data?.env,
    isLoading: query.isLoading,
    isError: query.isError,
  }
}
