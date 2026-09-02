/**
 * Header bell (D13): unread count from `/api/notifications/unread-count`, the five newest unread
 * in a dropdown, mark-all-read, and a link to the full page. Subscribes to query state only;
 * Phase 2's websocket store invalidates the keys. Notifications are tenant-scoped (403 `no_tenant`
 * without one), so the bell renders nothing for a global admin browsing `/admin` with no membership.
 */
import { BellIcon } from '@heroicons/react/24/outline'
import { Link } from 'react-router-dom'
import { useAuth } from '@/ui/hooks/useAuth'
import {
  useMarkNotificationsRead,
  useNotifications,
  useUnreadCount,
} from '@/ui/hooks/useNotifications'
import { timeAgo } from '@/ui/lib/format'
import { EmptyState } from './shared/EmptyState'

export function NotificationsBell() {
  const { tenant } = useAuth()
  if (!tenant) return null
  return <TenantNotificationsBell />
}

function TenantNotificationsBell() {
  const { data: unread } = useUnreadCount()
  const { data } = useNotifications({ unreadOnly: true, pageSize: 5 })
  const markRead = useMarkNotificationsRead()
  const count = unread?.count ?? 0
  const items = data?.items ?? []

  return (
    <details className="dropdown dropdown-end">
      <summary
        className="btn btn-ghost btn-sm btn-circle indicator list-none"
        aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
      >
        <BellIcon className="w-5 h-5" />
        {count > 0 && (
          <span className="badge badge-primary badge-xs indicator-item tabular-nums">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </summary>
      <div className="dropdown-content popover-surface z-50 mt-1 w-80 p-2">
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-sm font-semibold">Notifications</span>
          {count > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              disabled={markRead.isPending}
              onClick={() => markRead.mutate({ all: true })}
            >
              Mark all read
            </button>
          )}
        </div>
        {items.length === 0 ? (
          <EmptyState message="You're all caught up" size="sm" />
        ) : (
          <ul className="max-h-80 overflow-y-auto">
            {items.map(n => (
              <li key={n.id}>
                <button
                  type="button"
                  className="w-full text-left rounded-[var(--radius-control)] p-2 hover:bg-[color:var(--surface-hover)]"
                  onClick={() => markRead.mutate({ ids: [n.id] })}
                >
                  <div className="text-sm font-medium truncate">{n.title}</div>
                  {n.body && <div className="text-xs text-secondary line-clamp-2">{n.body}</div>}
                  <div className="text-[11px] text-muted mt-0.5">{timeAgo(n.createdAt)}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="border-t border-[color:var(--border-subtle)] mt-1 pt-1 px-2">
          <Link to="/notifications" className="link link-hover text-xs">
            View all notifications
          </Link>
        </div>
      </div>
    </details>
  )
}

export default NotificationsBell
