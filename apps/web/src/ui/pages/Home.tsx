/**
 * Home (D25): where you are (organisation, your role), where to go next, and — for admins — what
 * just happened. Deliberately generic; apps replace the quick links with their own dashboard.
 */
import {
  BellIcon,
  ChartBarIcon,
  ClockIcon,
  Cog6ToothIcon,
  ShieldCheckIcon,
  UserCircleIcon,
} from '@heroicons/react/24/outline'
import type { ComponentType } from 'react'
import { Link } from 'react-router-dom'
import { RoleBadge } from '@/ui/components/RoleBadge'
import { EmptyState, PageHeader, SectionPanel, SkeletonRows } from '@/ui/components/shared'
import { useActivity } from '@/ui/hooks/useActivity'
import { useAuth } from '@/ui/hooks/useAuth'
import { type NavGuard, useNavGuard } from '@/ui/hooks/useNavGuard'
import { timeAgo } from '@/ui/lib/format'

interface QuickLink {
  to: string
  label: string
  description: string
  icon: ComponentType<{ className?: string }>
  guard?: NavGuard
}

const QUICK_LINKS: QuickLink[] = [
  {
    // D19: the dashboards every member can read (admins edit)
    to: '/analytics',
    label: 'Analytics',
    description: 'Dashboards over this organisation',
    icon: ChartBarIcon,
    guard: { action: 'read', subject: 'Analytics' },
  },
  {
    to: '/profile',
    label: 'Your account',
    description: 'Name, avatar, sign-in methods',
    icon: UserCircleIcon,
  },
  {
    to: '/notifications',
    label: 'Notifications',
    description: 'Everything addressed to you',
    icon: BellIcon,
  },
  {
    to: '/settings',
    label: 'Settings',
    description: 'People, API keys, organisation',
    icon: Cog6ToothIcon,
    guard: 'admin',
  },
  {
    to: '/activity',
    label: 'Activity',
    description: 'The audit log',
    icon: ClockIcon,
    guard: 'admin',
  },
  {
    to: '/admin',
    label: 'Admin',
    description: 'Every organisation and user',
    icon: ShieldCheckIcon,
    guard: 'globalAdmin',
  },
]

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
            ? `Signed in as ${user.name}${tenant ? ` · your role here is ${tenant.role}` : ''}${tenancyMode === 'single' ? '' : ' · switch organisations from the header'}`
            : undefined
        }
      />

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
