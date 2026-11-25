/**
 * Home: the organisation's work at a glance, under a greeting (the organisation and the reader's
 * role are already in the switcher and the rail). The composer at the top (the AI first), then the work
 * areas — agent runs in the wide column, knowledge beside them with the spend, the people and what
 * just happened.
 * Every number sits inside the area it describes; there is no stats strip and no grid of links
 * (the nav is where you go; Home is what is happening).
 *
 * The areas are data (`./home-sections`): a feature contributes its own section there, core's are
 * in `./home/`, and each reads its part of ONE request (`useHomeSummary`). Installed plugins add
 * "what needs doing" cards under the composer (`UiPlugin.homeCards`) and any shortcuts of their own
 * (`homeLinks`) in the side column; Home never names a plugin. The core quick links are data in
 * `./home-links`, which the navigation search lists.
 */
import { type ComponentType, Suspense } from 'react'
import { Link } from 'react-router'
import { uiPlugins } from '@/plugins/ui'
import { ErrorBoundary } from '@/ui/components/ErrorBoundary'
import { PluginHomeCards } from '@/ui/components/PluginHomeCards'
import { SectionPanel, SectionPanelSkeleton } from '@/ui/components/shared'
import { useAuth } from '@/ui/hooks/useAuth'
import { useNavGuard } from '@/ui/hooks/useNavGuard'
import type { QuickLink } from './home-links'
import { HOME_SECTIONS, type HomePlacement, type HomeSection, sectionsFor } from './home-sections'

const PLUGIN_LINKS: QuickLink[] = uiPlugins.flatMap(p => p.homeLinks ?? [])

export default function Home({
  sections = HOME_SECTIONS,
}: {
  /** The registry; a test passes its own. */
  sections?: readonly HomeSection[]
}) {
  const { user } = useAuth()
  const canAccess = useNavGuard()
  const visible = sections.filter(s => canAccess(s.guard))
  const placed = (placement: HomePlacement) =>
    sectionsFor(visible, placement).map(s => <PlacedSection key={s.id} section={s} />)
  const links = PLUGIN_LINKS.filter(l => canAccess(l.guard))

  return (
    // One measure for the whole page, centred: the columns keep their 2 : 1 proportion from
    // tablet width up and the page stops growing where the lines would get too long to read.
    <div className="mx-auto w-full max-w-[88rem] flex flex-col gap-6">
      <h1 className="text-2xl font-semibold leading-tight">{greeting(user?.name)}</h1>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6">{placed('lead')}</div>

      <PluginHomeCards plugins={uiPlugins} />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)] items-start">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6">{placed('main')}</div>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
          {placed('aside')}
          {links.length > 0 && <Shortcuts links={links} />}
        </div>
      </div>
    </div>
  )
}

/** "Good morning, Olivia" — the reader's first name and the time of day where they are. Pure. */
export function greeting(name: string | null | undefined, hour = new Date().getHours()): string {
  const part =
    hour < 5
      ? 'Welcome back'
      : hour < 12
        ? 'Good morning'
        : hour < 18
          ? 'Good afternoon'
          : 'Good evening'
  const first = name?.trim().split(/\s+/)[0]
  return first ? `${part}, ${first}` : part
}

/** One section, isolated: a throw costs only this area, and a lazy one loads in its own shape. */
function PlacedSection({ section }: { section: HomeSection }) {
  const Component: ComponentType = section.Component
  return (
    <ErrorBoundary
      fallback={() => null}
      onError={(error, info) =>
        console.error(`[home section] ${section.id} failed`, error, info.componentStack)
      }
    >
      <Suspense fallback={<SectionPanelSkeleton rows={3} />}>
        <Component />
      </Suspense>
    </ErrorBoundary>
  )
}

function Shortcuts({ links }: { links: QuickLink[] }) {
  return (
    <SectionPanel title="Shortcuts">
      <ul className="-my-1">
        {links.map(link => (
          <li key={link.to}>
            <Link to={link.to} className="nav-item flex items-start gap-3 px-2 py-2 -mx-2">
              <link.icon className="w-5 h-5 mt-0.5 shrink-0" />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{link.label}</span>
                <span className="block text-xs text-muted">{link.description}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </SectionPanel>
  )
}
