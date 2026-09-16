/**
 * The plugin's TanStack query families (D31), declared once here and handed to the host twice: to
 * `UiPlugin.queryKeys`, which merges them into the app-wide `queryKeys` so anything may reach them,
 * and to this plugin's own hooks, which read them directly.
 *
 * Reading them directly rather than through the merged object is deliberate: a plugin must work the
 * same whether it is the only one installed or the fifth, and a hyphenated root
 * (`queryKeys['example-feature:notes']`) reads worse than the object it came from. The merge is for
 * the HOST's benefit, not the plugin's.
 *
 * **Every root starts with `<id>:`** — `tests/config/plugins.test.ts` is the check — so one plugin's
 * invalidation can never reach another's cache, and `EXAMPLE_NOTES_ENTITY` is the same string the
 * server puts in its `entity.changed` nudge, which is what makes the socket wiring free.
 */
import { EXAMPLE_NOTES_ENTITY } from '../shared'

export const exampleNotesKeys = {
  all: [EXAMPLE_NOTES_ENTITY] as const,
  list: (page: number) => [EXAMPLE_NOTES_ENTITY, 'list', page] as const,
}

export const exampleFeatureQueryKeys = {
  [EXAMPLE_NOTES_ENTITY]: exampleNotesKeys,
} as const
