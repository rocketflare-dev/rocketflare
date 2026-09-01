/**
 * Analytics dashboards (D19, D20): the tenant's `analytics_pages` over `/api/analytics/*`.
 * `GET /pages` ensures the template pages exist and lists everything (not paginated); the list is
 * re-ordered client-side so the default page comes first. Mutations are admin+ (`manage
 * Dashboard`): create (`POST /pages`), rename/reconfigure (`PATCH /pages/:id`), delete
 * (`DELETE`, user-created pages only — the server answers 403 `template_page` otherwise), reset
 * a template page (`POST /pages/:id/reset`) and `POST /templates/recreate`. Dashboard edits
 * autosave the whole `config` through `useAutosaveDashboardConfig` (debounced PATCH; `flush()`
 * before leaving). Fact-table freshness (`GET /facts/status`) is admin-only, so the hook takes
 * `enabled` and callers gate it on the ability. Contracts: `@gmgo/shared/analytics`; the cube data
 * behind a page is fetched by drizzle-cube's own client (see components/analytics).
 */
import {
  type AnalyticsPage,
  analyticsPageListResponseSchema,
  analyticsPageSchema,
  type CreateAnalyticsPageRequest,
  type DashboardConfigJson,
  dashboardTemplateListResponseSchema,
  factTableStatusListResponseSchema,
  type UpdateAnalyticsPageRequest,
} from '@gmgo/shared/analytics'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

/** Edits are saved this long after the last change (and immediately on `flush()`). */
export const DASHBOARD_AUTOSAVE_MS = 1500

const recreateResponseSchema = z.object({ created: z.number().int(), reset: z.number().int() })
export type RecreateTemplatesResponse = z.infer<typeof recreateResponseSchema>

/** The default page first, then the server's order (`sortOrder`, name). Pure — unit-tested. */
export function orderPages(items: AnalyticsPage[]): AnalyticsPage[] {
  return [...items].sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
}

export function analyticsPagesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.analytics.pages.list,
    queryFn: () => api.get('/api/analytics/pages', { schema: analyticsPageListResponseSchema }),
    select: data => orderPages(data.items),
  })
}

export function analyticsPageQueryOptions(id: string) {
  return queryOptions({
    queryKey: queryKeys.analytics.pages.detail(id),
    queryFn: () =>
      api.get(`/api/analytics/pages/${encodeURIComponent(id)}`, { schema: analyticsPageSchema }),
  })
}

export function useAnalyticsPages() {
  return useQuery(analyticsPagesQueryOptions())
}

export function useAnalyticsPage(id: string | undefined) {
  return useQuery({ ...analyticsPageQueryOptions(id ?? ''), enabled: Boolean(id) })
}

export function useCreateAnalyticsPage() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateAnalyticsPageRequest) =>
      api.post<AnalyticsPage>('/api/analytics/pages', body, {
        schema: analyticsPageSchema,
        showSuccessToast: true,
        successMessage: 'Dashboard created',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.analytics.pages.all }),
  })
}

export type UpdateAnalyticsPageVariables = UpdateAnalyticsPageRequest & { id: string }

/**
 * `PATCH /pages/:id`. The returned row replaces the cached detail at once (so an autosave never
 * re-fetches the config it just sent) and the list is invalidated for names/defaults.
 */
export function useUpdateAnalyticsPage(options: { silent?: boolean } = {}) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...patch }: UpdateAnalyticsPageVariables) =>
      api.patch<AnalyticsPage>(`/api/analytics/pages/${encodeURIComponent(id)}`, patch, {
        schema: analyticsPageSchema,
        showSuccessToast: !options.silent,
        successMessage: 'Dashboard saved',
      }),
    onSuccess: page => {
      queryClient.setQueryData(queryKeys.analytics.pages.detail(page.id), page)
      return queryClient.invalidateQueries({ queryKey: queryKeys.analytics.pages.list })
    },
  })
}

export function useDeleteAnalyticsPage() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.delete(`/api/analytics/pages/${encodeURIComponent(id)}`, undefined, {
        showSuccessToast: true,
        successMessage: 'Dashboard deleted',
      }),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: queryKeys.analytics.pages.detail(id) })
      return queryClient.invalidateQueries({ queryKey: queryKeys.analytics.pages.all })
    },
  })
}

/** `POST /pages/:id/reset` — template pages only; the row comes back as the template. */
export function useResetAnalyticsPage() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.post<AnalyticsPage>(`/api/analytics/pages/${encodeURIComponent(id)}/reset`, undefined, {
        schema: analyticsPageSchema,
        showSuccessToast: true,
        successMessage: 'Dashboard reset to its template',
      }),
    onSuccess: page => {
      queryClient.setQueryData(queryKeys.analytics.pages.detail(page.id), page)
      return queryClient.invalidateQueries({ queryKey: queryKeys.analytics.pages.list })
    },
  })
}

export function analyticsTemplatesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.analytics.templates,
    queryFn: () =>
      api.get('/api/analytics/templates', { schema: dashboardTemplateListResponseSchema }),
    select: data => data.items,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function useAnalyticsTemplates() {
  return useQuery(analyticsTemplatesQueryOptions())
}

export function useRecreateTemplates() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post<RecreateTemplatesResponse>('/api/analytics/templates/recreate', undefined, {
        schema: recreateResponseSchema,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.analytics.pages.all }),
  })
}

/** Admin-only: pass `enabled: can('manage', 'Dashboard')` so members never request it. */
export function useFactTableStatus({ enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: queryKeys.analytics.factsStatus,
    queryFn: () =>
      api.get('/api/analytics/facts/status', { schema: factTableStatusListResponseSchema }),
    select: data => data.items,
    enabled,
    staleTime: 60 * 1000,
  })
}

/**
 * Debounced whole-config autosave for the dashboard editor. `schedule(config)` (re)starts the
 * timer; `flush()` saves a pending config now (leaving edit mode, unmount). `dirty` is true from
 * the first unsaved change until the PATCH resolves — the page's unsaved-changes guard reads it.
 */
export function useAutosaveDashboardConfig(pageId: string, delayMs = DASHBOARD_AUTOSAVE_MS) {
  const update = useUpdateAnalyticsPage({ silent: true })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<DashboardConfigJson | null>(null)
  const [dirty, setDirty] = useState(false)
  const { mutateAsync } = update

  const save = useCallback(
    async (config: DashboardConfigJson) => {
      pending.current = null
      try {
        await mutateAsync({ id: pageId, config })
        if (pending.current === null) setDirty(false)
      } catch {
        // Toasted by the mutation; the config stays dirty so the guard still fires.
      }
    },
    [mutateAsync, pageId]
  )

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const config = pending.current
    return config ? save(config) : Promise.resolve()
  }, [save])

  const schedule = useCallback(
    (config: DashboardConfigJson) => {
      pending.current = config
      setDirty(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = null
        void flush()
      }, delayMs)
    },
    [delayMs, flush]
  )

  // Unmount with a pending edit: save it rather than lose it.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
      const config = pending.current
      if (config) void save(config)
    }
  }, [save])

  return { schedule, flush, dirty, isSaving: update.isPending, error: update.error }
}
