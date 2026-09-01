/**
 * Renders one `analytics_pages` row with drizzle-cube's `AnalyticsDashboard` (D19, D20). GM wrote
 * no chart code: the grid editor, portlet editor, drill-down and charts are the library's. This
 * component owns the glue — the page config as local state (seeded from the row, re-seeded when
 * the server row changes and nothing is dirty, e.g. after a reset), the page-level date range
 * applied as `dashboardFilters` overrides of the template's `isUniversalTime` filter, and
 * autosave: in edit mode every `onConfigChange` schedules a debounced whole-config PATCH
 * (`useAutosaveDashboardConfig`), `onSave` (the editor's explicit save) flushes it, leaving edit
 * mode flushes it, and while anything is unsaved a `beforeunload` guard warns the reader.
 * Must render inside `CubeClientProvider`.
 */
import type { AnalyticsPage, DashboardConfigJson } from '@gmgo/shared/analytics'
import { AnalyticsDashboard, type DashboardConfig } from 'drizzle-cube/client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { LoadingIndicator } from '@/ui/components/LoadingIndicator'
import { useAutosaveDashboardConfig } from '@/ui/hooks/useAnalyticsPages'
import { type DateRangeValue, dashboardDateFilters } from '@/ui/hooks/useDashboardDateFilter'

interface DashboardLoaderProps {
  page: AnalyticsPage
  /** Edit mode (admin+, `manage Dashboard`) — the caller has already checked the ability. */
  editing: boolean
  range: DateRangeValue
  onDirtyChange?: (dirty: boolean) => void
}

/** The shared contract types `config` loosely; the library's type is the real shape. */
export function asDashboardConfig(config: DashboardConfigJson): DashboardConfig {
  return config as unknown as DashboardConfig
}

export function DashboardLoader({ page, editing, range, onDirtyChange }: DashboardLoaderProps) {
  const [config, setConfig] = useState<DashboardConfig>(() => asDashboardConfig(page.config))
  const autosave = useAutosaveDashboardConfig(page.id)
  const { dirty, flush, schedule } = autosave

  // A new server row (reset, recreate, another tab) replaces the local config unless the reader
  // has unsaved edits — those win until their PATCH lands.
  useEffect(() => {
    if (!dirty) setConfig(asDashboardConfig(page.config))
  }, [page.config, dirty])

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  // Leaving edit mode saves whatever is pending.
  useEffect(() => {
    if (!editing) void flush()
  }, [editing, flush])

  // Unsaved-changes guard for reloads / tab close.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const handleConfigChange = useCallback(
    (next: DashboardConfig) => {
      setConfig(next)
      if (editing) schedule(next as unknown as DashboardConfigJson)
    },
    [editing, schedule]
  )

  const handleSave = useCallback(
    async (next: DashboardConfig) => {
      setConfig(next)
      schedule(next as unknown as DashboardConfigJson)
      await flush()
    },
    [flush, schedule]
  )

  const dashboardFilters = useMemo(() => dashboardDateFilters(config, range), [config, range])

  return (
    <div data-testid="dashboard-loader" data-dirty={dirty} data-editing={editing}>
      <AnalyticsDashboard
        config={config}
        editable={editing}
        dashboardFilters={dashboardFilters}
        onConfigChange={handleConfigChange}
        onSave={editing ? handleSave : undefined}
        loadingComponent={<LoadingIndicator size="lg" centered />}
      />
    </div>
  )
}
