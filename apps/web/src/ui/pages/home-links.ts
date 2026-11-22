/**
 * The core Home quick links as data. `Home` renders them (after every plugin's `homeLinks`) and
 * `useNavigationEntries` lists them as destinations. A leaf module, like `settings/tabs.ts`: the
 * plugin UI API (`@/plugins/api/ui`) reaches it through `useNavigationEntries`, and importing the
 * PAGE from there pulled Home's whole import graph into anything that compiles the plugin UI kit —
 * `apps/evals` included, which has no Vite client types for a component reading `import.meta.env`.
 */
import {
  BellIcon,
  ClockIcon,
  Cog6ToothIcon,
  ShieldCheckIcon,
  UserCircleIcon,
} from '@heroicons/react/24/outline'
import type { ComponentType } from 'react'
import type { NavGuard } from '@/ui/hooks/useNavGuard'

export interface QuickLink {
  to: string
  label: string
  description: string
  icon: ComponentType<{ className?: string }>
  guard?: NavGuard
}

export const CORE_QUICK_LINKS: QuickLink[] = [
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
