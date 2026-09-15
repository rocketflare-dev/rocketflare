/**
 * The kit's feature-flag demonstration (D30). Everything here exists to be deleted.
 *
 * It is reachable only while `example-feature` is on for the session's organisation. Note what that
 * means: a global admin, who holds `manage all`, is ALSO kept out — because the guard reads
 * `session.features`, not the ability. That is the difference between a flag and a permission, and
 * it is why the route guard and the nav item share one `EXAMPLE_FEATURE` const.
 *
 * To delete the demo: remove this file, its route and nav item, the `EXAMPLE_FEATURE` const, and
 * the `example-feature` entries in `FEATURES` (`packages/shared/src/permissions.ts`) and
 * `FEATURE_FLAGS` (`packages/shared/src/features.ts`).
 */
import { SectionPanel } from '@/ui/components/shared'

export default function ExampleFeature() {
  return (
    <SectionPanel
      title="Example feature"
      description="A page that exists only while a feature flag says it does."
    >
      <div className="space-y-3 text-sm">
        <p>
          You are seeing this because <code>example-feature</code> is on for this organisation. Turn
          it off under Admin → Feature flags and both this page and its nav item disappear — for
          every role, including a global admin.
        </p>
        <p className="text-muted">
          A real feature gates more doors than a nav item: its API mounts (a third element in the
          mount table in <code>src/api/index.ts</code>), its cubes (<code>cubesFor</code>) and its
          dashboard templates (<code>DashboardTemplate.feature</code>). The last one matters most —
          template dashboards are seeded lazily on every page list, so an ungated one appears in
          every organisation after a deploy.
        </p>
        <p className="text-muted">
          Delete this page, its route and nav item, and the <code>example-feature</code> entries in{' '}
          <code>packages/shared</code> when you add your own.
        </p>
      </div>
    </SectionPanel>
  )
}
