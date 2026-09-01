/**
 * Tenant AI providers (D17): `GET /api/ai/config` (sanitised rows — `hasCredential`, never a
 * key), `GET /providers` (the static catalog the form is built from), `GET /readiness` (what
 * chat/embeddings WOULD resolve to), `POST /` upsert on (scope, label), `POST /test` (saved row
 * or inline candidate) and `DELETE /:id`. Members hold `read AiConfig`, admins `manage`.
 *
 * Contract gap: the providers catalog has no schema in `@gmgo/shared/ai/config` (it is server
 * data, `services/ai/providers.ts`), so a permissive one lives here — only the fields the form
 * reads, `passthrough` for anything newer.
 */
import {
  type AiConfig,
  type AiScope,
  aiConfigListResponseSchema,
  aiConfigSchema,
  aiProviderSchema,
  aiReadinessSchema,
  aiScopeSchema,
  type TestAiConfigRequest,
  testAiConfigResponseSchema,
  type UpsertAiConfigRequest,
} from '@gmgo/shared/ai/config'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

export const aiProviderInfoSchema = z
  .object({
    id: aiProviderSchema,
    name: z.string(),
    scopes: z.array(aiScopeSchema),
    needsApiKey: z.boolean(),
    needsBaseUrl: z.boolean(),
    supportsThinking: z.boolean(),
    supportsServiceTier: z.boolean(),
    defaultModel: z.string(),
    suggestedModels: z.array(z.string()).default([]),
  })
  .passthrough()
export type AiProviderInfo = z.infer<typeof aiProviderInfoSchema>

export const aiProvidersResponseSchema = z
  .object({
    items: z.array(aiProviderInfoSchema),
    defaultMaxOutputTokens: z.number().int().positive().optional(),
  })
  .passthrough()
export type AiProvidersResponse = z.infer<typeof aiProvidersResponseSchema>

export function aiConfigsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.ai.configs,
    queryFn: () => api.get('/api/ai/config', { schema: aiConfigListResponseSchema }),
  })
}

export function aiProvidersQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.ai.providers,
    queryFn: () => api.get('/api/ai/config/providers', { schema: aiProvidersResponseSchema }),
    // The catalog is code: it changes with a deploy, not with a click.
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function aiReadinessQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.ai.readiness,
    queryFn: () => api.get('/api/ai/config/readiness', { schema: aiReadinessSchema }),
  })
}

export function useAiConfigs() {
  return useQuery(aiConfigsQueryOptions())
}

export function useAiProviders() {
  return useQuery(aiProvidersQueryOptions())
}

export function useAiReadiness() {
  return useQuery(aiReadinessQueryOptions())
}

/** Providers an adapter exists for in `scope` — the only ones the form may offer. */
export function providersForScope(
  providers: readonly AiProviderInfo[] | undefined,
  scope: AiScope
): AiProviderInfo[] {
  return (providers ?? []).filter(p => p.scopes.includes(scope))
}

/** Rows of one scope, default first then by label (the server orders by scope, label). */
export function configsForScope(configs: readonly AiConfig[] | undefined, scope: AiScope) {
  return (configs ?? [])
    .filter(c => c.scope === scope)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.label.localeCompare(b.label))
}

function invalidateAi(queryClient: ReturnType<typeof useQueryClient>) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.ai.configs }),
    queryClient.invalidateQueries({ queryKey: queryKeys.ai.readiness }),
  ])
}

/** Upsert on (scope, label). Omit `apiKey` to keep the stored credential. */
export function useUpsertAiConfig() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: UpsertAiConfigRequest) =>
      api.post('/api/ai/config', body, { schema: aiConfigSchema }),
    onSuccess: () => invalidateAi(queryClient),
  })
}

export function useDeleteAiConfig() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.delete(`/api/ai/config/${id}`, undefined, {
        showSuccessToast: true,
        successMessage: 'AI provider removed',
      }),
    onSuccess: () => invalidateAi(queryClient),
  })
}

/**
 * Spend one tiny request at the provider. A saved row (`{ configId }`) or an inline candidate
 * the admin has not saved yet. The verdict (`ok`, `latencyMs`, `error`) is the response body —
 * a transport failure (403, 429 rate limit, server down) is NOT a verdict and stays a toast.
 */
export function useTestAiConfig() {
  return useMutation({
    mutationFn: (body: TestAiConfigRequest) =>
      api.post('/api/ai/config/test', body, { schema: testAiConfigResponseSchema }),
  })
}
