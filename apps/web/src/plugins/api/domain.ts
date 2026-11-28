/**
 * `defineDomain` — how an app domain declares its server half (docs/CONCEPTS.md §20).
 *
 * A domain fills the same slots a plugin's `ServerPlugin` does, so it reaches every registry —
 * routes, jobs, agents, tools on chat, agents and MCP, crons, event handlers, prompts, knowledge
 * sources, seed — through one unit list, `apps/web/src/units/server.ts`. What it does not have is
 * a plugin's packaging: no manifest, no barrels, no `source.repo`. One line in `apps/web/src/app.ts`
 * wires it.
 *
 * The id is checked here as well as by the boundary check, so a bad one fails the first test that
 * imports the app rather than a deploy: it must be a legal unit id, equal `shared.id`, and not be a
 * reserved one. Everything else — namespaces, edges, imports — is the boundary check's
 * (`tests/config/units.test.ts`, `pnpm plugin check`), which can see every unit at once.
 */
import { isPluginId, RESERVED_UNIT_IDS, type SharedPlugin } from '@rocketflare/shared/plugins/api'
import type { DomainDefinition, DomainUiDefinition, ServerDomain, UiDomain } from '../types'

/** `null` when `id` may name a domain, else why not. The boundary check applies the same rule. */
export function domainIdProblem(id: string, sharedId: string): string | null {
  if (!isPluginId(id)) return `'${id}' is not a legal unit id (lower-case, digits and '-')`
  if ((RESERVED_UNIT_IDS as readonly string[]).includes(id)) return `'${id}' is a reserved unit id`
  if (id !== sharedId) return `the id '${id}' differs from its shared half's '${sharedId}'`
  return null
}

export function defineDomain<const S extends SharedPlugin>(
  definition: DomainDefinition<S>
): ServerDomain<S> {
  const { id, dependsOn = [], tablePrefix: _prefix, tables: _tables, ...slots } = definition
  const problem = domainIdProblem(id, definition.shared.id)
  if (problem) throw new Error(`defineDomain: ${problem}`)
  return Object.freeze({
    ...slots,
    id,
    kind: 'domain',
    dependsOn: [...dependsOn],
  }) as ServerDomain<S>
}

/** The UI half. Types only at runtime besides the id check, because it ships in the main bundle. */
export function defineDomainUi<const S extends SharedPlugin>(
  definition: DomainUiDefinition<S>
): UiDomain<S> {
  const problem = domainIdProblem(definition.id, definition.shared.id)
  if (problem) throw new Error(`defineDomainUi: ${problem}`)
  return Object.freeze({ ...definition, kind: 'domain' }) as UiDomain<S>
}
