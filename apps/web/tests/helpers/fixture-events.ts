/**
 * A fixture plugin for the kit's own event-seam tests (D42), installed the way a real one is — by
 * mocking the two barrels in a `// @vitest-isolate` file:
 *
 *     vi.mock('@rocketflare/shared/plugins', async importOriginal =>
 *       (await import('../helpers/fixture-events')).withFixtureEventsShared(await importOriginal())
 *     )
 *     vi.mock('@/plugins/server', async importOriginal =>
 *       (await import('../helpers/fixture-events')).withFixtureEventsServer(await importOriginal())
 *     )
 *
 * It declares two events, subscribes two handlers to the first (one of which fails on demand, to
 * prove a failing subscriber retries alone) and registers three agents: one TRIGGERED by the event
 * (`where` skips `kind: 'skip'`; `input` builds `{ text }`, so an empty `text` is invalid input),
 * one BINDABLE to it, and one that opts in to nothing — the forged-key case.
 *
 * Imported from inside `vi.mock` factories, so it imports nothing at runtime but `zod`.
 */
import type { AgentKey } from '@rocketflare/shared/ai/agents'
import type { SharedPlugin } from '@rocketflare/shared/plugins'
import { z } from 'zod'
import type { AnyAgentDefinition } from '@/api/services/agents/registry'
import type { DeliveredEvent, EventContext, EventHandler } from '@/api/services/events/types'
import type { AnyServerPlugin } from '@/plugins/server'

export const FIXTURE_EVENTS_ID = 'fixture-ev'
export const THING_HAPPENED = 'fixture-ev.thing.happened'
export const OTHER_EVENT = 'fixture-ev.other.happened'

export const TRIGGERED_AGENT = 'fixture-ev.auto' as string as AgentKey
export const BINDABLE_AGENT = 'fixture-ev.bound' as string as AgentKey
export const PLAIN_AGENT = 'fixture-ev.plain' as string as AgentKey

export const thingPayloadSchema = z.object({
  thingId: z.string().uuid(),
  kind: z.string(),
  text: z.string(),
})
export type ThingPayload = z.infer<typeof thingPayloadSchema>

/** What the handlers saw, in order — read and cleared by the tests. */
export const handled: { handler: string; event: DeliveredEvent; tenantId: string }[] = []
/** Set to make the `flaky` handler throw (a plain error: retried). */
export const flaky = { fail: false }

export const fixtureEventsShared: SharedPlugin = {
  id: FIXTURE_EVENTS_ID,
  label: 'Fixture events (tests)',
  agentKeys: [TRIGGERED_AGENT, BINDABLE_AGENT, PLAIN_AGENT],
  promptKeys: ['fixture-ev-auto', 'fixture-ev-bound', 'fixture-ev-plain'],
  events: {
    [THING_HAPPENED]: thingPayloadSchema,
    [OTHER_EVENT]: z.object({ n: z.number() }),
  },
}

const agent = (key: AgentKey, promptKey: string, extra: Partial<AnyAgentDefinition> = {}) =>
  ({
    meta: {
      key,
      title: `Fixture ${key}`,
      description: `${key} (a test fixture).`,
      inputSchema: z.object({ text: z.string().trim().min(1) }),
      outputSchema: z.any(),
      promptKey,
      exclusive: false,
    },
    run: async () => ({}),
    ...extra,
  }) as AnyAgentDefinition

const recorder = (name: string): EventHandler => ({
  event: THING_HAPPENED as never,
  name,
  handle: async (event: DeliveredEvent, ctx: EventContext) => {
    if (name === 'flaky' && flaky.fail) throw new Error('flaky handler failed')
    handled.push({ handler: name, event, tenantId: ctx.event.tenantId })
  },
})

const prompt = (key: string) => ({
  key,
  title: key,
  description: `System prompt for ${key}.`,
  variables: [],
  defaultText: `You are ${key}.`,
})

export const fixtureEventsServer = {
  shared: fixtureEventsShared,
  eventHandlers: [recorder('steady'), recorder('flaky')],
  agents: {
    [TRIGGERED_AGENT as string]: agent(TRIGGERED_AGENT, 'fixture-ev-auto', {
      triggers: [
        {
          event: THING_HAPPENED,
          where: (p: ThingPayload) => p.kind !== 'skip',
          input: (p: ThingPayload) => ({ text: p.text }),
        } as never,
      ],
    }),
    [BINDABLE_AGENT as string]: agent(BINDABLE_AGENT, 'fixture-ev-bound', {
      bindable: [
        { event: THING_HAPPENED, input: (p: ThingPayload) => ({ text: p.text }) } as never,
      ],
    }),
    [PLAIN_AGENT as string]: agent(PLAIN_AGENT, 'fixture-ev-plain'),
  },
  prompts: {
    'fixture-ev-auto': prompt('fixture-ev-auto'),
    'fixture-ev-bound': prompt('fixture-ev-bound'),
    'fixture-ev-plain': prompt('fixture-ev-plain'),
  },
} as unknown as AnyServerPlugin

type SharedBarrel = typeof import('@rocketflare/shared/plugins')
type ServerBarrel = typeof import('@/plugins/server')

export function withFixtureEventsShared(actual: SharedBarrel): SharedBarrel {
  const plugins = [...actual.sharedPlugins, fixtureEventsShared]
  return { ...actual, SHARED_PLUGINS: plugins, sharedPlugins: plugins } as unknown as SharedBarrel
}

export function withFixtureEventsServer(actual: ServerBarrel): ServerBarrel {
  const plugins = [...actual.serverPlugins, fixtureEventsServer]
  return { ...actual, SERVER_PLUGINS: plugins, serverPlugins: plugins } as unknown as ServerBarrel
}
