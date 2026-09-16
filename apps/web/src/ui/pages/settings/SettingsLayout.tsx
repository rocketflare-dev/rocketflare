/**
 * `/settings` (D10, D25): one page, tabs in `?tab=` (URLTabs) so links deep-link. The route is
 * behind `RequireGuard guard="admin"`; tabs whose content needs more (owner-only slug/delete)
 * gate inside. In single mode the heading reads "Workspace settings". AI tabs (D17, D18): `ai`
 * and `prompts` degrade to read-only inside; `agent-models` and `usage` are `manage AiConfig` only and hidden otherwise.
 * `groups` (D29) is `manage Group` only and hidden otherwise — a picker that 403s on save is worse
 * than no tab.
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
import type { Actions, Subjects } from '@rocketflare/shared/permissions'
import { uiPlugins } from '@/plugins/ui'
import { PageHeader, type TabConfig, URLTabs } from '@/ui/components/shared'
import { useAuth } from '@/ui/hooks/useAuth'
import { usePermissions } from '@/ui/hooks/usePermissions'
import AgentModelsSettings from './AgentModels'
import AiSettings from './AI'
import ApiKeys from './ApiKeys'
import General from './General'
import GroupsSettings from './Groups'
import People from './People'
import PromptsSettings from './Prompts'
import UsageSettings from './Usage'

export default function SettingsLayout() {
  const { tenant, tenancyMode } = useAuth()
  const { can } = usePermissions()
  const single = tenancyMode === 'single'
  const aiTabs: TabConfig[] = [
    {
      id: 'ai',
      label: 'AI',
      icon: <SparklesIcon className="w-4 h-4" />,
      content: <AiSettings />,
    },
    {
      id: 'prompts',
      label: 'Prompts',
      icon: <DocumentTextIcon className="w-4 h-4" />,
      content: <PromptsSettings />,
    },
    ...(can('manage', 'AiConfig')
      ? [
          {
            id: 'agent-models',
            label: 'Agent models',
            icon: <CpuChipIcon className="w-4 h-4" />,
            content: <AgentModelsSettings />,
          },
          {
            id: 'usage',
            label: 'Usage',
            icon: <ChartBarIcon className="w-4 h-4" />,
            content: <UsageSettings />,
          },
        ]
      : []),
  ]
  // D31: installed plugins add their tabs LAST, so the kit's order never moves under a reader.
  // Each is handed `can` and decides for itself — a tab that would 403 on save is worse than none.
  // `can` is widened to strings on the way out, the same way a `NavGuard` pair is: a plugin's
  // subjects are not in the kit's union until it is installed, and the ability takes them anyway.
  const pluginTabs: TabConfig[] = uiPlugins.flatMap(
    p =>
      p.settingsTabs?.({
        can: (action, subject) => can(action as Actions, subject as Subjects),
      }) ?? []
  )
  return (
    <div className="max-w-5xl">
      <PageHeader
        title={single ? 'Workspace settings' : 'Settings'}
        description={
          single
            ? 'People, API keys and preferences.'
            : `Manage ${tenant?.name ?? 'this organisation'}.`
        }
      />
      <URLTabs
        defaultTab="general"
        tabs={[
          {
            id: 'general',
            label: 'General',
            icon: <Cog6ToothIcon className="w-4 h-4" />,
            content: <General />,
          },
          {
            id: 'people',
            label: 'People',
            icon: <UserGroupIcon className="w-4 h-4" />,
            content: <People />,
          },
          ...(can('manage', 'Group')
            ? [
                {
                  id: 'groups',
                  label: 'Groups',
                  icon: <RectangleGroupIcon className="w-4 h-4" />,
                  content: <GroupsSettings />,
                },
              ]
            : []),
          {
            id: 'api-keys',
            label: 'API keys',
            icon: <KeyIcon className="w-4 h-4" />,
            content: <ApiKeys />,
          },
          ...aiTabs,
          ...pluginTabs,
        ]}
      />
    </div>
  )
}
