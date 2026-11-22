/**
 * Per-FILE setup and teardown for the api projects. Setup: the network guard
 * (`helpers/network-guard.ts`). Teardown (`tests/setup.ts` is the per-RUN one): end every
 * pooled script handle so a fork's connection count does not climb file after file
 * (`53300 too many clients` is what that looks like). Handles are rebuilt on demand.
 *
 * The client is imported INSIDE the hook, not at the top: a setup file shares the test file's
 * module registry, so a static import here would evaluate `@/db/client` — and through the schema,
 * `@rocketflare/shared/ai/agents` and the plugin barrels — before the test file's `vi.mock` calls
 * exist, and a mocked barrel (`tests/helpers/fixture-agents.ts`) would never be read.
 */
import { afterAll, vi } from 'vitest'
import { installNetworkGuard } from './helpers/network-guard'

// No api test reaches the internet: a non-local request fails at once, naming its URL.
installNetworkGuard()

afterAll(async () => {
  // `api` shares a module registry, and Vitest undoes spies after each file but not stubs.
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  // A file's fake chat or decisions client must not answer the next file's calls.
  // (A file that mocks the module whole may not carry the setter.)
  const resolve = await import('@/api/services/ai/resolve')
  if (typeof resolve.overrideResolveChatForTests === 'function') {
    resolve.overrideResolveChatForTests(null)
  }
  if (typeof resolve.overrideResolveDecisionsForTests === 'function') {
    resolve.overrideResolveDecisionsForTests(null)
  }
  // Nor a file's fixture knowledge entity types be the next file's registry.
  const registry = await import('@/api/services/knowledge/registry')
  if (typeof registry.overrideKnowledgeEntityTypesForTests === 'function') {
    registry.overrideKnowledgeEntityTypesForTests(null)
  }
  const { closeAllDatabases } = await import('@/db/client')
  await closeAllDatabases()
})
