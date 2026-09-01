/**
 * `/analytics/:pageId` (D19, D20): one dashboard. Header = name, description, badges, the
 * URL-synced date range (feeds the template's universal-time filter), and for `manage Dashboard`
 * the edit-mode toggle, rename, "Reset to template" (template pages; confirm → `POST /reset`)
 * and delete (user-created pages only — template pages cannot be deleted, the server would
 * refuse with 403 `template_page`; confirm → `DELETE`, back to the list). The dashboard itself is
 * `DashboardLoader` inside `CubeClientProvider`, so the drizzle-cube runtime loads with this lazy
 * chunk only. A router-level unsaved-changes guard is not available under `BrowserRouter`
 * (no data router), so the loader's `beforeunload` guard plus flush-on-leave-edit-mode is the
 * protection; the edit toggle shows "Saving…" / "Unsaved" while a PATCH is pending.
 */
import { ArrowPathIcon, PencilSquareIcon, TrashIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { useCallback, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { CubeClientProvider } from '@/ui/components/analytics/CubeClientProvider'
import {
  DashboardFormModal,
  type DashboardFormValues,
} from '@/ui/components/analytics/DashboardFormModal'
import { DashboardLoader } from '@/ui/components/analytics/DashboardLoader'
import { DateRangeControl } from '@/ui/components/analytics/DateRangeControl'
import { ConfirmModal, PageHeader, SectionPanel, SkeletonRows } from '@/ui/components/shared'
import {
  useAnalyticsPage,
  useDeleteAnalyticsPage,
  useResetAnalyticsPage,
  useUpdateAnalyticsPage,
} from '@/ui/hooks/useAnalyticsPages'
import { useDashboardDateFilter } from '@/ui/hooks/useDashboardDateFilter'
import { usePermissions } from '@/ui/hooks/usePermissions'

export default function DashboardViewPage() {
  const { pageId } = useParams<{ pageId: string }>()
  const navigate = useNavigate()
  const { can } = usePermissions()
  const canManage = can('manage', 'Dashboard')
  const page = useAnalyticsPage(pageId)
  const dateFilter = useDashboardDateFilter()

  const [editing, setEditing] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const update = useUpdateAnalyticsPage()
  const reset = useResetAnalyticsPage()
  const remove = useDeleteAnalyticsPage()
  const onDirtyChange = useCallback((d: boolean) => setDirty(d), [])

  if (page.isLoading) {
    return (
      <SectionPanel>
        <SkeletonRows rows={4} />
      </SectionPanel>
    )
  }
  if (page.isError || !page.data) {
    return (
      <div className="alert alert-error" role="alert">
        <span>{page.error?.message ?? 'Dashboard not found'}</span>
        <Link to="/analytics" className="btn btn-sm">
          Back to Analytics
        </Link>
      </div>
    )
  }
  const row = page.data
  const isTemplate = row.templateKey !== null

  const rename = (values: DashboardFormValues) =>
    update.mutate(
      { id: row.id, name: values.name, description: values.description },
      { onSuccess: () => setRenameOpen(false) }
    )

  const confirmReset = () =>
    reset.mutate(row.id, {
      onSuccess: () => {
        setResetOpen(false)
        setEditing(false)
      },
    })

  const confirmDelete = () =>
    remove.mutate(row.id, {
      onSuccess: () => {
        setDeleteOpen(false)
        navigate('/analytics', { replace: true })
      },
    })

  return (
    <div>
      <PageHeader
        title={row.name}
        description={row.description ?? undefined}
        breadcrumbs={[{ label: 'Analytics', to: '/analytics' }, { label: row.name }]}
        badge={
          <span className="flex items-center gap-1">
            {row.isDefault && <span className="badge badge-sm badge-primary">Default</span>}
            {isTemplate && <span className="badge badge-sm badge-ghost">Template</span>}
            {editing && (
              <span
                className="status-badge no-dot"
                data-status={dirty ? 'pending' : 'active'}
                aria-live="polite"
              >
                {dirty ? 'Saving…' : 'Saved'}
              </span>
            )}
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <DateRangeControl
              state={dateFilter.state}
              onPreset={dateFilter.setPreset}
              onCustom={dateFilter.setCustom}
            />
            {canManage && (
              <>
                <button
                  type="button"
                  className={`btn btn-sm ${editing ? 'btn-primary' : 'btn-ghost'}`}
                  aria-pressed={editing}
                  onClick={() => setEditing(e => !e)}
                >
                  {editing ? (
                    <XMarkIcon className="w-4 h-4" />
                  ) : (
                    <PencilSquareIcon className="w-4 h-4" />
                  )}
                  {editing ? 'Done' : 'Edit'}
                </button>
                <details className="dropdown dropdown-end">
                  <summary className="btn btn-ghost btn-sm" aria-label="More actions">
                    ⋯
                  </summary>
                  <ul className="dropdown-content menu menu-sm popover-surface z-30 mt-1 w-56 p-1">
                    <li>
                      <button type="button" onClick={() => setRenameOpen(true)}>
                        <PencilSquareIcon className="w-4 h-4" />
                        Rename
                      </button>
                    </li>
                    {isTemplate && (
                      <li>
                        <button type="button" onClick={() => setResetOpen(true)}>
                          <ArrowPathIcon className="w-4 h-4" />
                          Reset to template
                        </button>
                      </li>
                    )}
                    {!isTemplate && (
                      <li>
                        <button
                          type="button"
                          className="text-error"
                          onClick={() => setDeleteOpen(true)}
                        >
                          <TrashIcon className="w-4 h-4" />
                          Delete dashboard
                        </button>
                      </li>
                    )}
                  </ul>
                </details>
              </>
            )}
          </div>
        }
      />

      <CubeClientProvider>
        <DashboardLoader
          page={row}
          editing={editing && canManage}
          range={dateFilter.range}
          onDirtyChange={onDirtyChange}
        />
      </CubeClientProvider>

      {canManage && (
        <>
          <DashboardFormModal
            open={renameOpen}
            title="Rename dashboard"
            initial={{ name: row.name, description: row.description }}
            isPending={update.isPending}
            onClose={() => setRenameOpen(false)}
            onSubmit={rename}
          />
          <ConfirmModal
            isOpen={resetOpen}
            title="Reset to template"
            message={`"${row.name}" goes back to its template layout. Portlets added or changed on this dashboard are lost.`}
            confirmText="Reset"
            confirmButtonClass="btn-warning"
            isLoading={reset.isPending}
            onCancel={() => setResetOpen(false)}
            onConfirm={confirmReset}
          />
          <ConfirmModal
            isOpen={deleteOpen}
            title="Delete dashboard"
            message={`Delete "${row.name}"? This cannot be undone.`}
            confirmText="Delete"
            confirmButtonClass="btn-error"
            isLoading={remove.isPending}
            onCancel={() => setDeleteOpen(false)}
            onConfirm={confirmDelete}
          />
        </>
      )}
    </div>
  )
}
