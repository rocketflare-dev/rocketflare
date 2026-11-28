/**
 * Fixture server plugins for one api test file WITHOUT `vi.mock('@/plugins/server')`, so the file
 * can share the `api` project's module registry.
 *
 * `withServerPlugins(fixtures)` splices the fixtures into the REAL `serverPlugins` array in place
 * before the file's tests (`beforeAll`) and puts the array back after them (`afterAll`). With
 * `{ replace: true }` the installed plugins are taken out for the file, which is what a mock that
 * returned only the fixtures did. It works only for code that reads `serverPlugins` at CALL time:
 * the tool builder (`buildAgentTools`), the MCP listing, the tenant status hooks. A consumer that
 * reads the barrel at module load — the route mounts, `API_PREFIXES`, the agent and prompt
 * registries, `EMAIL_HANDLERS`, the job handler table — has already read the installed plugins and
 * never sees a fixture, so a file testing one of those still mocks the barrel (and is
 * `// @vitest-isolate`).
 *
 * The lazily memoised readers (`knowledgeEntityTypes`, `visibilityResources`, `eventSubscribers`)
 * are warmed from the installed plugins first, so a fixture can never be the set they cache for
 * every later file in the worker. A test that needs a fixture in one of them cannot use this.
 */
import { afterAll, beforeAll } from 'vitest'
import { visibilityResources } from '@/api/services/access'
import { eventSubscribers } from '@/api/services/events/subscribers'
import { knowledgeEntityTypes } from '@/api/services/knowledge/registry'
import { APP_DOMAINS } from '@/app'
import { type AnyServerPlugin, serverPlugins } from '@/plugins/server'

export function withServerPlugins(
  fixtures: readonly AnyServerPlugin[],
  options: { replace?: boolean } = {}
): void {
  const plugins = serverPlugins as AnyServerPlugin[]
  // `replace` swaps the whole unit set, so the app's own domains step aside too.
  const domains = APP_DOMAINS as unknown as unknown[]
  let installed: AnyServerPlugin[] = []
  let appDomains: unknown[] = []
  beforeAll(() => {
    knowledgeEntityTypes()
    visibilityResources()
    eventSubscribers()
    installed = [...plugins]
    appDomains = [...domains]
    if (options.replace) {
      plugins.splice(0, plugins.length, ...fixtures)
      domains.splice(0, domains.length)
    } else plugins.push(...fixtures)
  })
  afterAll(() => {
    plugins.splice(0, plugins.length, ...installed)
    domains.splice(0, domains.length, ...appDomains)
  })
}
