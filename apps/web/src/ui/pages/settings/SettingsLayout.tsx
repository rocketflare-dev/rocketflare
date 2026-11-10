/**
 * `/settings`: one page, tabs in `?tab=` (URLTabs) so links deep-link. The route is
 * behind `RequireGuard guard="admin"`; tabs whose content needs more (owner-only slug/delete)
 * gate inside. In single mode the heading reads "Workspace settings". AI tabs: `ai`
 * and `prompts` degrade to read-only inside; `agent-models` and `usage` are `manage AiConfig` only and hidden otherwise.
 * `groups` is `manage Group` only and hidden otherwise — a picker that 403s on save is worse
 * than no tab.
 */
import type { Actions, Subjects } from '@rocketflare/shared/permissions'
import type { ReactElement } from 'react'
import { uiPlugins } from '@/plugins/ui'
import { PageHeader, type TabConfig, URLTabs } from '@/ui/components/shared'
import { useAuth } from '@/ui/hooks/useAuth'
import { useNavGuard } from '@/ui/hooks/useNavGuard'
import { usePermissions } from '@/ui/hooks/usePermissions'
import AgentModelsSettings from './AgentModels'
import AiSettings from './AI'
import ApiKeys from './ApiKeys'
import General from './General'
import GroupsSettings from './Groups'
import People from './People'
import PromptsSettings from './Prompts'
import { CORE_SETTINGS_TABS, type CoreSettingsTabId } from './tabs'
import UsageSettings from './Usage'

const CONTENT: Record<CoreSettingsTabId, () => ReactElement> = {
  general: () => <General />,
  people: () => <People />,
  groups: () => <GroupsSettings />,
  'api-keys': () => <ApiKeys />,
  ai: () => <AiSettings />,
  prompts: () => <PromptsSettings />,
  'agent-models': () => <AgentModelsSettings />,
  usage: () => <UsageSettings />,
}

export default function SettingsLayout() {
  const { tenant, tenancyMode } = useAuth()
  const { can } = usePermissions()
  const single = tenancyMode === 'single'
  const canAccess = useNavGuard()
  // The core tabs are data (`./tabs`), shared with `useNavigationEntries`; a guarded tab is hidden.
  const coreTabs: TabConfig[] = CORE_SETTINGS_TABS.filter(t => canAccess(t.guard)).map(t => ({
    id: t.id,
    label: t.label,
    icon: <t.icon className="w-4 h-4" />,
    content: CONTENT[t.id](),
  }))
  // Installed plugins add their tabs LAST, so the core order never moves under a reader.
  // Each is handed `can` and decides for itself — a tab that would 403 on save is worse than none.
  // `can` is widened to strings on the way out, the same way a `NavGuard` pair is: a plugin's
  // subjects are not in the core union until it is installed, and the ability takes them anyway.
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
      <URLTabs defaultTab="general" tabs={[...coreTabs, ...pluginTabs]} />
    </div>
  )
}
