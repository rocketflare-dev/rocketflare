/**
 * `/analytics` (D19, D20): every dashboard page of the tenant, default first. Members see the
 * cards and the explorer link; `manage Dashboard` (admin+) adds "New dashboard" (name,
 * description, optional template start — the template's config is copied client-side from the
 * pure `src/dashboards` registry), "Recreate templates" (creates missing + resets existing
 * template pages, after confirmation) and the fact-table freshness badges (`GET /facts/status`,
 * admin-only, so the query is gated on the same ability). No drizzle-cube code here — the
 * library only loads with the view / explore pages.
 */
import type { AnalyticsPage, FactTableStatus } from '@gmgo/shared/analytics'
import {
  ArrowPathIcon,
  BeakerIcon,
  ChartBarIcon,
  PlusIcon,
  Squares2X2Icon,
} from '@heroicons/react/24/outline'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getTemplate } from '@/dashboards'
import {
  DashboardFormModal,
  type DashboardFormValues,
} from '@/ui/components/analytics/DashboardFormModal'
import {
  ConfirmModal,
  EmptyState,
  PageHeader,
  SectionPanel,
  SkeletonRows,
} from '@/ui/components/shared'
import {
  useAnalyticsPages,
  useAnalyticsTemplates,
  useCreateAnalyticsPage,
  useFactTableStatus,
  useRecreateTemplates,
} from '@/ui/hooks/useAnalyticsPages'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { showToast } from '@/ui/lib/api-client'
import { formatDate, timeAgo } from '@/ui/lib/format'

export default function DashboardListPage() {
  const { can } = usePermissions()
  const canManage = can('manage', 'Dashboard')
  const pages = useAnalyticsPages()
  const [createOpen, setCreateOpen] = useState(false)
  const [recreateOpen, setRecreateOpen] = useState(false)
  const recreate = useRecreateTemplates()

  const confirmRecreate = () =>
    recreate.mutate(undefined, {
      onSuccess: ({ created, reset }) => {
        setRecreateOpen(false)
        showToast(`Templates recreated: ${created} created, ${reset} reset`, 'success')
      },
    })

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Analytics"
        description="Dashboards over this organisation's data. Every member can read them; admins can edit."
        actions={
          <div className="flex items-center gap-2">
            <Link to="/analytics/explore" className="btn btn-ghost btn-sm">
              <BeakerIcon className="w-4 h-4" />
              Explore
            </Link>
            {canManage && (
              <>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setRecreateOpen(true)}
                  disabled={recreate.isPending}
                >
                  <ArrowPathIcon className="w-4 h-4" />
                  Recreate templates
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => setCreateOpen(true)}
                >
                  <PlusIcon className="w-4 h-4" />
                  New dashboard
                </button>
              </>
            )}
          </div>
        }
      />

      {canManage && <FactTableFreshness />}

      {pages.isLoading ? (
        <SectionPanel>
          <SkeletonRows rows={3} />
        </SectionPanel>
      ) : pages.isError ? (
        <div className="alert alert-error" role="alert">
          Failed to load dashboards: {pages.error.message}
        </div>
      ) : (pages.data?.length ?? 0) === 0 ? (
        <EmptyState
          icon={ChartBarIcon}
          message="No dashboards yet"
          description={
            canManage ? 'Create one, or recreate the templates.' : 'An administrator can add one.'
          }
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Dashboards">
          {pages.data?.map(page => (
            <li key={page.id}>
              <DashboardCard page={page} />
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <>
          <CreateDashboardModal open={createOpen} onClose={() => setCreateOpen(false)} />
          <ConfirmModal
            isOpen={recreateOpen}
            title="Recreate template dashboards"
            message="Missing template dashboards are created and existing ones are reset to their template. Edits made to template dashboards are lost; user-created dashboards are untouched."
            confirmText="Recreate"
            confirmButtonClass="btn-warning"
            isLoading={recreate.isPending}
            onCancel={() => setRecreateOpen(false)}
            onConfirm={confirmRecreate}
          />
        </>
      )}
    </div>
  )
}

function DashboardCard({ page }: { page: AnalyticsPage }) {
  const portlets = page.config.portlets.length
  return (
    <Link
      to={`/analytics/${page.id}`}
      className="block h-full surface-panel !p-4 hover:border-[color:var(--border-strong)]"
      data-testid="dashboard-card"
    >
      <div className="flex items-start gap-3">
        <Squares2X2Icon className="w-5 h-5 mt-0.5 text-muted shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold truncate">{page.name}</h3>
            {page.isDefault && <span className="badge badge-sm badge-primary">Default</span>}
            {page.templateKey && <span className="badge badge-sm badge-ghost">Template</span>}
          </div>
          {page.description && (
            <p className="mt-1 text-xs text-secondary line-clamp-2">{page.description}</p>
          )}
          <p className="mt-2 text-xs text-muted">
            {portlets} {portlets === 1 ? 'portlet' : 'portlets'} · updated {timeAgo(page.updatedAt)}
          </p>
        </div>
      </div>
    </Link>
  )
}

function CreateDashboardModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const create = useCreateAnalyticsPage()
  const templates = useAnalyticsTemplates()

  const submit = (values: DashboardFormValues) => {
    const template = values.templateKey ? getTemplate(values.templateKey) : null
    create.mutate(
      {
        name: values.name,
        description: values.description,
        ...(template ? { config: template.config as unknown as AnalyticsPage['config'] } : {}),
      },
      {
        onSuccess: page => {
          onClose()
          navigate(`/analytics/${page.id}`)
        },
      }
    )
  }

  return (
    <DashboardFormModal
      open={open}
      title="New dashboard"
      submitText="Create"
      templates={templates.data ?? []}
      isPending={create.isPending}
      onClose={onClose}
      onSubmit={submit}
    />
  )
}

/** Admin-only: is the fact table the dashboards read from up to date? */
function FactTableFreshness() {
  const status = useFactTableStatus({ enabled: true })
  if (!status.data || status.data.length === 0) return null
  return (
    <section className="mb-4 flex flex-wrap items-center gap-2 text-xs" aria-label="Fact tables">
      <span className="text-muted">Fact tables:</span>
      {status.data.map(f => (
        <FactBadge key={f.table} fact={f} />
      ))}
    </section>
  )
}

function FactBadge({ fact }: { fact: FactTableStatus }) {
  const label = fact.refreshedAt
    ? `refreshed ${timeAgo(fact.refreshedAt)}`
    : 'never built — the cron has not run yet'
  return (
    <span
      className="status-badge"
      data-status={fact.stale ? 'blocked' : fact.refreshedAt ? 'active' : 'idle'}
      title={`${fact.table}: ${label}${fact.refreshedAt ? ` (${formatDate(fact.refreshedAt)})` : ''}${fact.lagSeconds ? `, ${fact.lagSeconds}s behind` : ''}`}
    >
      <code>{fact.table}</code> {fact.stale ? 'stale' : fact.refreshedAt ? 'fresh' : 'empty'}
    </span>
  )
}
