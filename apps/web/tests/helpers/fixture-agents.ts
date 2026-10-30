/**
 * Fixture agents for the kit's CORE tests — the runtime, the routes, the run pages — so that none
 * of them borrows one of the example agents (`kind: "example"` surfaces in `.rocketflare.json`). An
 * app deletes an example by deleting its surface's `paths` and its registry lines; a core test that
 * named one would go red with it (`tests/kit-only/example-surfaces.test.ts` keeps it that way).
 *
 * The fixtures arrive through the seam a real plugin uses (D31): a `SharedPlugin` declaring two
 * agent keys and two prompt keys, and a `ServerPlugin` carrying the definitions and the prompts.
 * A test installs them by mocking the two barrels — so it must be a `// @vitest-isolate` file
 * (api) or run on vitest's default isolation (ui, config, cli):
 *
 *     vi.mock('@rocketflare/shared/plugins', async importOriginal =>
 *       (await import('../helpers/fixture-agents')).withFixtureShared(await importOriginal())
 *     )
 *     vi.mock('@/plugins/server', async importOriginal =>
 *       (await import('../helpers/fixture-agents')).withFixtureServer(await importOriginal())
 *     )
 *
 * The UI and the CLI need only the shared half: they validate `agentKey` with the same enum.
 *
 * A test that needs a different body or meta still swaps `AGENTS[FIXTURE_AGENT]` for the test, as
 * before. A test that only stores a key as an opaque string (a row, a trace name) uses the
 * constant without mocking anything.
 *
 * This module is imported from inside `vi.mock` factories, so it imports nothing at runtime but
 * `zod`: a value import of a composer (`@rocketflare/shared/ai/agents`) would read the barrel it
 * is in the middle of mocking.
 */
import type { AgentKey } from '@rocketflare/shared/ai/agents'
import type { PromptDefinition } from '@rocketflare/shared/ai/prompts'
import type { SharedPlugin } from '@rocketflare/shared/plugins'
import { z } from 'zod'
import type { AnyAgentDefinition } from '@/api/services/agents/registry'
import type { AnyServerPlugin } from '@/plugins/server'

const KEY_A = 'fixture-agent'
const KEY_B = 'fixture-agent-b'

/** An exclusive agent taking `{ text }`. Typed as a key so a test can pass it where one belongs. */
export const FIXTURE_AGENT = KEY_A as string as AgentKey
/** A second exclusive agent taking `{ topic }` — for "another agent beside it". */
export const FIXTURE_AGENT_B = KEY_B as string as AgentKey

const FIXTURE_PLUGIN_ID = 'fixture'

const prompt = (key: string, title: string): PromptDefinition => ({
  key,
  title,
  description: `System prompt for the \`${key}\` test fixture agent.`,
  variables: ['appName', 'tenantName'],
  defaultText: `You are ${title} inside {{appName}}, working for {{tenantName}}.`,
})

/** The shared half: what the agent-key enum and the prompt-key list read. */
export const fixtureShared: SharedPlugin = {
  id: FIXTURE_PLUGIN_ID,
  label: 'Fixture agents (tests)',
  agentKeys: [FIXTURE_AGENT, FIXTURE_AGENT_B],
  promptKeys: [FIXTURE_AGENT, FIXTURE_AGENT_B],
}

const fixtureAgent = (
  key: AgentKey,
  title: string,
  inputSchema: z.ZodTypeAny
): AnyAgentDefinition => ({
  meta: {
    key,
    title,
    description: `${title} (a test fixture).`,
    inputSchema,
    outputSchema: z.any(),
    promptKey: key,
    exclusive: true,
  },
  run: async () => ({}),
})

/** The server half: the definitions and their prompts. */
export const fixtureServer = {
  shared: fixtureShared,
  // Keyed by the plain strings: `AgentKey` may be a single literal (an app with one agent), and
  // two computed keys of one literal type are a duplicate property to the compiler.
  agents: {
    [KEY_A]: fixtureAgent(
      FIXTURE_AGENT,
      'Fixture agent',
      z.object({ text: z.string().trim().min(1) })
    ),
    [KEY_B]: fixtureAgent(
      FIXTURE_AGENT_B,
      'Fixture agent B',
      z.object({ topic: z.string().trim().min(1) })
    ),
  },
  prompts: {
    [KEY_A]: prompt(KEY_A, 'Fixture agent'),
    [KEY_B]: prompt(KEY_B, 'Fixture agent B'),
  },
} as unknown as AnyServerPlugin

type SharedBarrel = typeof import('@rocketflare/shared/plugins')
type ServerBarrel = typeof import('@/plugins/server')

/** `@rocketflare/shared/plugins` with the fixture plugin appended. */
export function withFixtureShared(actual: SharedBarrel): SharedBarrel {
  const plugins = [...actual.sharedPlugins, fixtureShared]
  return { ...actual, SHARED_PLUGINS: plugins, sharedPlugins: plugins } as unknown as SharedBarrel
}

/** `@/plugins/server` with the fixture plugin appended. */
export function withFixtureServer(actual: ServerBarrel): ServerBarrel {
  const plugins = [...actual.serverPlugins, fixtureServer]
  return { ...actual, SERVER_PLUGINS: plugins, serverPlugins: plugins } as unknown as ServerBarrel
}
