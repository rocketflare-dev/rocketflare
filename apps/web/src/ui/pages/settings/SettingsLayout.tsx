/**
 * `/settings` (D10, D25): one page, tabs in `?tab=` (URLTabs) so links deep-link. The route is
 * behind `RequireGuard guard="admin"`; tabs whose content needs more (owner-only slug/delete)
 * gate inside. In single mode the heading reads "Workspace settings". AI tabs (D17, D18): `ai`
 * and `prompts` degrade to read-only inside; `usage` is `manage AiConfig` only and hidden otherwise.
 */
import {
  ChartBarIcon,
  Cog6ToothIcon,
  DocumentTextIcon,
  KeyIcon,
  SparklesIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline'
import { PageHeader, type TabConfig, URLTabs } from '@/ui/components/shared'
import { useAuth } from '@/ui/hooks/useAuth'
import { usePermissions } from '@/ui/hooks/usePermissions'
import AiSettings from './AI'
import ApiKeys from './ApiKeys'
import General from './General'
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
            id: 'usage',
            label: 'Usage',
            icon: <ChartBarIcon className="w-4 h-4" />,
            content: <UsageSettings />,
          },
        ]
      : []),
  ]
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
          {
            id: 'api-keys',
            label: 'API keys',
            icon: <KeyIcon className="w-4 h-4" />,
            content: <ApiKeys />,
          },
          ...aiTabs,
        ]}
      />
    </div>
  )
}
