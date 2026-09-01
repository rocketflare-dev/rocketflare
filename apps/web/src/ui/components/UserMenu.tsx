/**
 * Header avatar dropdown: who you are, where to manage yourself, sign out (D10 for which links
 * show — the same `useNavGuard()` the SideNav uses). Theme lives in `ThemeToggle` beside it.
 */
import {
  ArrowRightStartOnRectangleIcon,
  BellIcon,
  Cog6ToothIcon,
  ShieldCheckIcon,
  UserCircleIcon,
} from '@heroicons/react/24/outline'
import { useRef } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/ui/hooks/useAuth'
import { useNavGuard } from '@/ui/hooks/useNavGuard'
import { initials } from '@/ui/lib/format'

export function UserMenu() {
  const { user, tenant, logout } = useAuth()
  const canAccess = useNavGuard()
  const ref = useRef<HTMLDetailsElement>(null)
  if (!user) return null

  const close = () => ref.current?.removeAttribute('open')

  return (
    <details ref={ref} className="dropdown dropdown-end">
      <summary
        className="btn btn-ghost btn-sm btn-circle avatar list-none"
        aria-label="Your account"
      >
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="w-7 h-7 rounded-full" />
        ) : (
          <span className="w-7 h-7 rounded-full grid place-items-center text-xs font-semibold tone-primary">
            {initials(user.name, user.email)}
          </span>
        )}
      </summary>
      <ul className="dropdown-content popover-surface z-50 mt-1 w-64 p-1.5 space-y-0.5">
        <li className="px-2.5 py-2">
          <div>
            <div className="text-sm font-medium truncate">{user.name}</div>
            <div className="text-xs text-muted truncate">{user.email}</div>
            {tenant && (
              <div className="text-xs text-muted mt-0.5 capitalize">
                {tenant.role} · {tenant.name}
              </div>
            )}
          </div>
        </li>
        <li className="border-t border-[color:var(--border-subtle)] my-1" />
        <li>
          <Link
            to="/profile"
            onClick={close}
            className="nav-item flex items-center gap-2 px-2.5 py-1.5 text-sm"
          >
            <UserCircleIcon className="w-4 h-4" /> Profile
          </Link>
        </li>
        <li>
          <Link
            to="/notifications"
            onClick={close}
            className="nav-item flex items-center gap-2 px-2.5 py-1.5 text-sm"
          >
            <BellIcon className="w-4 h-4" /> Notifications
          </Link>
        </li>
        {canAccess('admin') && (
          <li>
            <Link
              to="/settings"
              onClick={close}
              className="nav-item flex items-center gap-2 px-2.5 py-1.5 text-sm"
            >
              <Cog6ToothIcon className="w-4 h-4" /> Settings
            </Link>
          </li>
        )}
        {canAccess('globalAdmin') && (
          <li>
            <Link
              to="/admin"
              onClick={close}
              className="nav-item flex items-center gap-2 px-2.5 py-1.5 text-sm"
            >
              <ShieldCheckIcon className="w-4 h-4" /> Admin
            </Link>
          </li>
        )}
        <li className="border-t border-[color:var(--border-subtle)] my-1" />
        <li>
          <button
            type="button"
            className="nav-item flex w-full items-center gap-2 px-2.5 py-1.5 text-sm"
            onClick={() => logout()}
          >
            <ArrowRightStartOnRectangleIcon className="w-4 h-4" /> Sign out
          </button>
        </li>
      </ul>
    </details>
  )
}

export default UserMenu
