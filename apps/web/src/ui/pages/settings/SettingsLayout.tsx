/**
 * `/settings` (D10, D25): one page, tabs in `?tab=` (URLTabs) so links deep-link. The route is
 * behind `RequireGuard guard="admin"`; tabs whose content needs more (owner-only slug/delete)
 * gate inside. In single mode the heading reads "Workspace settings".
 */
import { Cog6ToothIcon, KeyIcon, UserGroupIcon } from '@heroicons/react/24/outline'
import { PageHeader, URLTabs } from '@/ui/components/shared'
import { useAuth } from '@/ui/hooks/useAuth'
import ApiKeys from './ApiKeys'
import General from './General'
import People from './People'

export default function SettingsLayout() {
  const { tenant, tenancyMode } = useAuth()
  const single = tenancyMode === 'single'
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
        ]}
      />
    </div>
  )
}
