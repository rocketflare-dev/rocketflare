/**
 * `/analytics/explore` (D19, D20): drizzle-cube's `AnalysisBuilder` for ad-hoc questions against
 * the tenant's cubes (every member — `read Analytics`; rows are tenant-scoped by every cube).
 * The builder keeps its draft in localStorage under a kit-specific key. For `manage Dashboard`,
 * "Save to dashboard" reads the builder's current analysis through its ref
 * (`getAnalysisConfig()` — the canonical portlet format) and appends it to a chosen page as a
 * new full-width row (`rows` mode: a `RowLayout` entry plus mirrored x/y/w/h on the portlet),
 * saving the whole config with `PATCH /pages/:id`.
 */
import type { AnalyticsPage } from '@gmgo/shared/analytics'
import { BookmarkSquareIcon } from '@heroicons/react/24/outline'
import {
  AnalysisBuilder,
  type AnalysisBuilderRef,
  type DashboardConfig,
  type PortletConfig,
} from 'drizzle-cube/client'
import { type FormEvent, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CubeClientProvider } from '@/ui/components/analytics/CubeClientProvider'
import { asDashboardConfig } from '@/ui/components/analytics/DashboardLoader'
import { Modal, PageHeader } from '@/ui/components/shared'
import { useAnalyticsPages, useUpdateAnalyticsPage } from '@/ui/hooks/useAnalyticsPages'
import { usePermissions } from '@/ui/hooks/usePermissions'

const NEW_PORTLET_H = 5

/** Append `portlet` as a new full-width row. Pure — the same shape the templates use. */
export function appendPortlet(
  config: DashboardConfig,
  portlet: Omit<PortletConfig, 'x' | 'y' | 'w' | 'h'>
): DashboardConfig {
  const y = config.portlets.reduce((max, p) => Math.max(max, p.y + p.h), 0)
  const placed: PortletConfig = { ...portlet, x: 0, y, w: 12, h: NEW_PORTLET_H }
  const rows = [
    ...(config.rows ?? []),
    { id: `row-${portlet.id}`, h: NEW_PORTLET_H, columns: [{ portletId: portlet.id, w: 12 }] },
  ]
  return { ...config, layoutMode: 'rows', rows, portlets: [...config.portlets, placed] }
}

export default function QueryBuilderPage() {
  const { can } = usePermissions()
  const canManage = can('manage', 'Dashboard')
  const builder = useRef<AnalysisBuilderRef>(null)
  const [saveOpen, setSaveOpen] = useState(false)

  return (
    <div>
      <PageHeader
        title="Explore"
        description="Ask an ad-hoc question of the organisation's data. Pick measures and dimensions; the chart follows."
        breadcrumbs={[{ label: 'Analytics', to: '/analytics' }, { label: 'Explore' }]}
        actions={
          canManage ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setSaveOpen(true)}
            >
              <BookmarkSquareIcon className="w-4 h-4" />
              Save to dashboard
            </button>
          ) : undefined
        }
      />
      <CubeClientProvider>
        <div className="surface-panel !p-0 overflow-hidden" style={{ minHeight: '70vh' }}>
          <AnalysisBuilder
            ref={builder}
            storageKey="gmgo-analysis-builder"
            maxHeight="calc(100vh - 220px)"
          />
        </div>
      </CubeClientProvider>
      {canManage && (
        <SavePortletModal open={saveOpen} onClose={() => setSaveOpen(false)} builder={builder} />
      )}
    </div>
  )
}

function SavePortletModal({
  open,
  onClose,
  builder,
}: {
  open: boolean
  onClose: () => void
  builder: React.RefObject<AnalysisBuilderRef>
}) {
  const navigate = useNavigate()
  const pages = useAnalyticsPages()
  const update = useUpdateAnalyticsPage()
  const [pageId, setPageId] = useState('')
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

  const target: AnalyticsPage | undefined =
    pages.data?.find(p => p.id === pageId) ?? pages.data?.[0]

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const ref = builder.current
    if (!ref || !target) return setError('Nothing to save yet — build a query first.')
    const name = title.trim()
    if (!name) return setError('Give the portlet a title.')
    const analysisConfig = ref.getAnalysisConfig()
    const config = appendPortlet(asDashboardConfig(target.config), {
      id: `portlet-${Date.now().toString(36)}`,
      title: name,
      analysisConfig,
      dashboardFilterMapping: [],
    })
    setError(null)
    update.mutate(
      { id: target.id, config: config as unknown as AnalyticsPage['config'] },
      {
        onSuccess: () => {
          onClose()
          navigate(`/analytics/${target.id}`)
        },
      }
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save to dashboard"
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="save-portlet-form"
            className="btn btn-primary"
            disabled={update.isPending || !target}
          >
            Save
          </button>
        </>
      }
    >
      <form id="save-portlet-form" onSubmit={submit} className="space-y-3" noValidate>
        <div>
          <label htmlFor="portlet-title" className="label text-sm font-medium">
            Portlet title
          </label>
          <input
            id="portlet-title"
            className="input w-full"
            value={title}
            onChange={e => setTitle(e.target.value)}
            maxLength={120}
          />
        </div>
        <div>
          <label htmlFor="portlet-page" className="label text-sm font-medium">
            Dashboard
          </label>
          <select
            id="portlet-page"
            className="select w-full"
            value={target?.id ?? ''}
            onChange={e => setPageId(e.target.value)}
          >
            {pages.data?.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted">
            Added as a new full-width row at the bottom; resize it in edit mode.
          </p>
        </div>
        {error && (
          <p className="text-sm text-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  )
}
