/**
 * The core `/settings?tab=` tabs as data: id, label, icon and the guard each needs on top of the
 * page's own `admin`. `SettingsLayout` renders them (pairing each id with its component) and
 * `useNavigationEntries` lists them as destinations, so a tab can never be offered to someone the
 * page would not show it to. Order is the order on screen.
 */
import {
  ChartBarIcon,
  Cog6ToothIcon,
  CpuChipIcon,
  DocumentTextIcon,
  KeyIcon,
  RectangleGroupIcon,
  SparklesIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline'
import type { ComponentType } from 'react'
import type { NavGuard } from '@/ui/hooks/useNavGuard'

export type CoreSettingsTabId =
  | 'general'
  | 'people'
  | 'groups'
  | 'api-keys'
  | 'ai'
  | 'prompts'
  | 'agent-models'
  | 'usage'

export interface SettingsTabInfo<Id extends string = string> {
  id: Id
  label: string
  icon: ComponentType<{ className?: string }>
  /** Beyond the page's `admin`: the tab is hidden unless this passes too. */
  guard?: NavGuard
  /** Words a search should also match (the tab's contents, in a reader's terms). */
  keywords?: readonly string[]
}

/** Every role on the page: `/settings` itself is behind `RequireGuard guard="admin"`. */
export const SETTINGS_PAGE_GUARD: NavGuard = 'admin'

export const settingsTabPath = (id: string) => `/settings?tab=${encodeURIComponent(id)}`

export const CORE_SETTINGS_TABS: readonly SettingsTabInfo<CoreSettingsTabId>[] = [
  { id: 'general', label: 'General', icon: Cog6ToothIcon, keywords: ['organisation', 'name'] },
  {
    id: 'people',
    label: 'People',
    icon: UserGroupIcon,
    keywords: ['members', 'invite', 'invitations', 'roles'],
  },
  {
    id: 'groups',
    label: 'Groups',
    icon: RectangleGroupIcon,
    guard: { action: 'manage', subject: 'Group' },
    keywords: ['teams'],
  },
  { id: 'api-keys', label: 'API keys', icon: KeyIcon, keywords: ['tokens', 'cli'] },
  { id: 'ai', label: 'AI', icon: SparklesIcon, keywords: ['providers', 'models', 'keys'] },
  { id: 'prompts', label: 'Prompts', icon: DocumentTextIcon, keywords: ['system prompt'] },
  {
    id: 'agent-models',
    label: 'Agent models',
    icon: CpuChipIcon,
    guard: { action: 'manage', subject: 'AiConfig' },
  },
  {
    id: 'usage',
    label: 'Usage',
    icon: ChartBarIcon,
    guard: { action: 'manage', subject: 'AiConfig' },
    keywords: ['cost', 'tokens', 'spend'],
  },
]
