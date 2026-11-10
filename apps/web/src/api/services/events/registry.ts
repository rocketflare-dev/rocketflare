/**
 * The declared plugin events (D42): every installed plugin's `SharedPlugin.events`, merged into one
 * name → definition table, and the types a caller names an event and its payload with.
 *
 * It lives server-side rather than as a sixth shared composer because nothing outside the Worker
 * needs the merged table: a plugin's UI and CLI already import their OWN event names from their
 * own shared entry, and the one client-facing contract (`GET /api/agents/bindable?event=`) takes
 * the name as a string the server checks here. It reads only the SHARED barrel, so a plugin may
 * reach it at module scope without the server-barrel cycle `plugins/CLAUDE.md` describes.
 *
 * `plugins.test.ts` (`eventDeclarationIssues`) and `pnpm plugin check` refuse a name that is not
 * `<plugin id>.<name>`, sits in `kit.`, or is declared twice; at runtime the first declaration wins.
 */
import {
  type EventNameOf,
  type EventPayloadOf,
  eventNameProblem,
  type SHARED_PLUGINS,
  sharedPlugins,
} from '@rocketflare/shared/plugins'
import type { ZodTypeAny } from 'zod'

type InstalledShared = (typeof SHARED_PLUGINS)[number]

/** Every event name an installed plugin declares. `never` while none does. */
export type EventName = EventNameOf<InstalledShared>

/** The parsed payload of event `E`, as the declaring plugin's schema outputs it. */
export type EventPayload<E extends EventName> = EventPayloadOf<InstalledShared, E>

export interface EventDefinition {
  name: string
  /** The plugin that declares it. */
  source: string
  schema: ZodTypeAny
}

let definitions: ReadonlyMap<string, EventDefinition> | null = null

/** The merged table, built once per isolate. A malformed name is skipped (the gate refuses it). */
export function eventDefinitions(): ReadonlyMap<string, EventDefinition> {
  if (definitions) return definitions
  const table = new Map<string, EventDefinition>()
  for (const plugin of sharedPlugins) {
    for (const [name, schema] of Object.entries(plugin.events ?? {})) {
      if (eventNameProblem(plugin.id, name) !== null || table.has(name)) continue
      table.set(name, { name, source: plugin.id, schema })
    }
  }
  definitions = table
  return table
}

export function eventDefinition(name: string): EventDefinition | undefined {
  return eventDefinitions().get(name)
}

export function isEventName(name: string): name is EventName {
  return eventDefinitions().has(name)
}
