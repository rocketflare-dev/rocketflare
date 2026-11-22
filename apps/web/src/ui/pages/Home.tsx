/**
 * Home: where you are (organisation, your role), where to go next, and — for admins — what
 * just happened. Deliberately generic; apps replace the quick links with their own dashboard.
 * Installed plugins add "what needs doing" cards above the links (`UiPlugin.homeCards`) and links
 * of their own (`homeLinks`); the core links are data in `./home-links`.
 */
import { ClockIcon } from '@heroicons/react/24/outline'
import { roleLabel } from '@rocketflare/shared/tenants'
import { Link } from 'react-router'
import { uiPlugins } from '@/plugins/ui'
import { PluginHomeCards } from '@/ui/components/PluginHomeCards'
import { RoleBadge } from '@/ui/components/RoleBadge'
import { EmptyState, PageHeader, SectionPanel, SkeletonRows } from '@/ui/components/shared'
import { useActivity } from '@/ui/hooks/useActivity'
import { useAuth } from '@/ui/hooks/useAuth'
import { useNavGuard } from '@/ui/hooks/useNavGuard'
import { timeAgo } from '@/ui/lib/format'
import { CORE_QUICK_LINKS, type QuickLink } from './home-links'

/**
 * The core links, with every installed plugin's ahead of them. Plugin first because a
 * plugin is what this app ADDED — the core links (account, notifications, settings) are the
 * furniture.
 */
const QUICK_LINKS: QuickLink[] = [...uiPlugins.flatMap(p => p.homeLinks ?? []), ...CORE_QUICK_LINKS]

export default function Home() {
  const { user, tenant, tenancyMode } = useAuth()
  const canAccess = useNavGuard()
  const isAdmin = canAccess('admin')
  const links = QUICK_LINKS.filter(l => canAccess(l.guard))

  return (
    <div className="max-w-4xl">
      <PageHeader
        title={tenant ? tenant.name : 'Welcome'}
        badge={tenant && <RoleBadge role={tenant.role} />}
        description={
          user
            ? `Signed in as ${user.name}${tenant ? ` · your role here is ${roleLabel(tenant.role)}` : ''}${tenancyMode === 'single' ? '' : ' · switch organisations from the header'}`
            : undefined
        }
      />

      <PluginHomeCards plugins={uiPlugins} />

      <SectionPanel title="Quick links" className="mb-4">
        <ul className="grid gap-2 sm:grid-cols-2">
          {links.map(link => (
            <li key={link.to}>
              <Link
                to={link.to}
                className="flex items-start gap-3 surface-inset px-4 py-3 hover:border-[color:var(--border-strong)]"
              >
                <link.icon className="w-5 h-5 mt-0.5 text-muted shrink-0" />
                <span>
                  <span className="block text-sm font-medium">{link.label}</span>
                  <span className="block text-xs text-secondary">{link.description}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </SectionPanel>

      {isAdmin && <RecentActivity />}
    </div>
  )
}

function RecentActivity() {
  const { data, isLoading } = useActivity({ pageSize: 5 })
  const items = data?.items ?? []
  return (
    <SectionPanel
      title="Recent activity"
      actions={
        <Link to="/activity" className="btn btn-ghost btn-xs">
          View all
        </Link>
      }
    >
      {isLoading ? (
        <SkeletonRows rows={3} />
      ) : items.length === 0 ? (
        <EmptyState icon={ClockIcon} message="Nothing yet" size="sm" />
      ) : (
        <ul className="divide-y divide-[color:var(--border-subtle)] text-sm">
          {items.map(event => (
            <li key={event.id} className="flex items-center gap-3 py-2">
              <code className="text-xs">{event.type}</code>
              <span className="flex-1 truncate text-secondary">
                {event.actor?.name ?? 'system'}
              </span>
              <span className="text-xs text-muted whitespace-nowrap">
                {timeAgo(event.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionPanel>
  )
}
