/**
 * The knowledge entity type registry (D43): the app's own types (`./entity-types.ts`) plus every
 * installed plugin's `ServerPlugin.knowledgeEntityTypes`, validated once.
 *
 * **A function, memoised — not a const** (the module-order rule in `.claude/rules/api.md`): this
 * module reads the plugin barrel, and a plugin's own code may import it back, so evaluating the
 * merge at module scope would leave one side `undefined` at import.
 *
 * The rules, each a test in `tests/config/knowledge-entity-types.test.ts`:
 * - **Namespacing.** A plugin's types are `<plugin id>.<name>`; an app's are bare (no dot). So an
 *   app type never collides with a plugin's, and a plugin's never with another plugin's.
 * - **Shape.** Every declaration passes `entityTypeSchema` — snake_case fact keys, at least one,
 *   and a facts object that renders as JSON schema (the extraction prompt shows it to the model).
 * - **Table.** A registration with a table names only that table's columns, the table has a
 *   `tenantId`, and the default resolver has a `labelColumn` (`registrationTableIssues`).
 * - **No duplicates** across the whole set.
 * - **Refs resolve.** A key that names another type (`refs`) names a registered one.
 * A violation throws: a type that silently failed to register would extract nothing, unnoticed.
 */
import { entityTypeSchema } from '@rocketflare/shared/ai/knowledge-facts'
import { serverPlugins } from '../../../plugins/server'
import { APP_ENTITY_TYPES } from './entity-types'
import { registrationTableIssues } from './resolve'
import type { EntityTypeRegistration } from './types'

/** Who contributed a list: the app (`null`) or the plugin with this id. */
export interface EntityTypeSource {
  owner: string | null
  types: readonly EntityTypeRegistration[]
}

/** Every problem with a set of contributions — `[]` when it composes. Pure; the tests' seam. */
export function entityTypeIssues(sources: readonly EntityTypeSource[]): string[] {
  const issues: string[] = []
  const seen = new Map<string, string>()
  for (const { owner, types } of sources) {
    const who = owner === null ? 'the app' : `plugin ${owner}`
    for (const reg of types) {
      const parsed = entityTypeSchema.safeParse(reg)
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const at = issue.path.length > 0 ? ` (${issue.path.join('.')})` : ''
          issues.push(`${who}: entity type ${String(reg.type)}${at}: ${issue.message}`)
        }
      }
      if (owner === null && reg.type.includes('.')) {
        issues.push(`the app: entity type ${reg.type} has a dot — an app type is a bare name`)
      }
      if (owner !== null && !reg.type.startsWith(`${owner}.`)) {
        issues.push(`plugin ${owner}: entity type ${reg.type} must start with "${owner}."`)
      }
      for (const issue of registrationTableIssues(reg)) {
        issues.push(`${who}: entity type ${reg.type}: ${issue}`)
      }
      const first = seen.get(reg.type)
      if (first !== undefined) {
        issues.push(`entity type ${reg.type} is registered by both ${first} and ${who}`)
      } else {
        seen.set(reg.type, who)
      }
    }
  }
  for (const { owner, types } of sources) {
    const who = owner === null ? 'the app' : `plugin ${owner}`
    for (const reg of types) {
      for (const [key, target] of Object.entries(reg.refs ?? {})) {
        if (target && !seen.has(target)) {
          issues.push(
            `${who}: entity type ${reg.type}: ${key} names ${target}, which is not registered`
          )
        }
      }
    }
  }
  return issues
}

/** Compose and validate; throws with every issue at once. */
export function composeEntityTypes(
  sources: readonly EntityTypeSource[]
): readonly EntityTypeRegistration[] {
  const issues = entityTypeIssues(sources)
  if (issues.length > 0) {
    throw new Error(`knowledge entity types do not compose:\n- ${issues.join('\n- ')}`)
  }
  return sources.flatMap(s => s.types)
}

let memo: readonly EntityTypeRegistration[] | null = null

/** The app's entity types plus every installed plugin's, validated. Empty in the bare kit. */
export function knowledgeEntityTypes(): readonly EntityTypeRegistration[] {
  if (memo === null) {
    memo = composeEntityTypes([
      { owner: null, types: APP_ENTITY_TYPES },
      ...serverPlugins.map(p => ({ owner: p.shared.id, types: p.knowledgeEntityTypes ?? [] })),
    ])
  }
  return memo
}

/** One registered type by name, or undefined. */
export function knowledgeEntityType(type: string): EntityTypeRegistration | undefined {
  return knowledgeEntityTypes().find(t => t.type === type)
}
