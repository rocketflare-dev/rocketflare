/**
 * Per-FILE teardown for the api projects (`tests/setup.ts` is the per-RUN one): end every
 * pooled script handle so a fork's connection count does not climb file after file
 * (`53300 too many clients` is what that looks like). Handles are rebuilt on demand.
 *
 * The client is imported INSIDE the hook, not at the top: a setup file shares the test file's
 * module registry, so a static import here would evaluate `@/db/client` — and through the schema,
 * `@rocketflare/shared/ai/agents` and the plugin barrels — before the test file's `vi.mock` calls
 * exist, and a mocked barrel (`tests/helpers/fixture-agents.ts`) would never be read.
 */
import { afterAll } from 'vitest'

afterAll(async () => {
  const { closeAllDatabases } = await import('@/db/client')
  await closeAllDatabases()
})
