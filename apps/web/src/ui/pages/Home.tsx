import { BookOpenIcon, RocketLaunchIcon, ServerStackIcon } from '@heroicons/react/24/outline'
import { PageHeader, SectionPanel } from '@/ui/components/shared'
import { useAppInfo } from '@/ui/hooks/useAppInfo'

const NEXT_STEPS = [
  { step: 'Follow SETUP.md', detail: 'Postgres, .dev.vars, first migration, seed.' },
  { step: 'Read docs/CONCEPTS.md', detail: 'Tenancy, sessions, abilities, queues, workflows.' },
  {
    step: 'Read docs/ADAPTING.md',
    detail: 'Rename the app, rebrand index.css, add your first domain.',
  },
  {
    step: 'Phase 1',
    detail: 'Login, invitations, settings and admin replace this page with the dashboard.',
  },
]

/**
 * Phase 0 welcome. Phase 1 replaces this with the real dashboard (pending invitations banner,
 * setup checklist, tenant overview).
 */
export default function Home() {
  const { name, version, env, isLoading } = useAppInfo()

  return (
    <div className="max-w-3xl">
      <PageHeader
        title={`Welcome to ${name}`}
        description="The shell is running. The API, database and UI are wired; everything else is yours."
      />

      <div className="grid gap-4 md:grid-cols-2">
        <SectionPanel title="Deployment" description="From GET /api/health">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted">Environment</dt>
            <dd className="font-mono">{isLoading ? '…' : (env ?? 'unknown')}</dd>
            <dt className="text-muted">Version</dt>
            <dd className="font-mono">{isLoading ? '…' : (version ?? 'unknown')}</dd>
          </dl>
        </SectionPanel>

        <SectionPanel title="Stack">
          <ul className="space-y-2 text-sm text-secondary">
            <li className="flex items-center gap-2">
              <ServerStackIcon className="w-4 h-4 text-muted" />
              Hono API on Cloudflare Workers, Postgres via Hyperdrive
            </li>
            <li className="flex items-center gap-2">
              <RocketLaunchIcon className="w-4 h-4 text-muted" />
              React 18 SPA served from Workers Static Assets
            </li>
            <li className="flex items-center gap-2">
              <BookOpenIcon className="w-4 h-4 text-muted" />
              Contracts shared through src/shared (zod)
            </li>
          </ul>
        </SectionPanel>
      </div>

      <SectionPanel title="Next steps" className="mt-4">
        <ol className="space-y-3 text-sm">
          {NEXT_STEPS.map((item, i) => (
            <li key={item.step} className="flex gap-3">
              <span className="font-mono text-muted tabular-nums w-5 shrink-0">{i + 1}.</span>
              <div>
                <div className="font-medium">{item.step}</div>
                <div className="text-secondary">{item.detail}</div>
              </div>
            </li>
          ))}
        </ol>
      </SectionPanel>
    </div>
  )
}
